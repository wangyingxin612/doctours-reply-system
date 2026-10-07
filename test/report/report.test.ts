import { describe, expect, it } from "vitest";
import { costOf, priceFor } from "../../config/pricing";
import type { ReasonCode } from "../../src/policy/escalation";
import { ESCALATION_TABLE } from "../../src/policy/escalation";
import { intentOf, summarize, wilson } from "../../src/report/aggregate";
import { byIntent, byReasonCode } from "../../src/report/decompose";
import { renderReport } from "../../src/report/render";
import type { Trace } from "../../src/trace/types";

interface Spec {
  intent: string;
  /** Blocking violations on the first draft. Any makes the message a repaired one. */
  blockedBy?: Array<{ validator: string; rule?: string }>;
  code?: ReasonCode;
  decidedBy?: Trace["decision"]["decidedBy"];
  failure?: Trace["failure"];
  coverage?: Trace["coverage"];
  latencyMs?: number;
  modelCalls?: Trace["modelCalls"];
}

let counter = 0;

function trace(spec: Spec, runId = "run"): Trace {
  counter += 1;
  const escalate = spec.code !== undefined;
  return {
    runId,
    index: counter,
    messageId: `m${counter}`,
    policyVersion: "v1",
    models: { router: "claude-haiku-4-5-20251001", responder: "claude-sonnet-5-5", responderEffort: "low" },
    message: { redactedText: "", redactions: [] },
    guard: { hits: [] },
    router: null,
    primaryIntent: spec.intent,
    skillsLoaded: [],
    toolCalls: [],
    events: [],
    directives: null,
    precedence: [],
    validation: spec.blockedBy
      ? [
          { attempt: 1, violations: spec.blockedBy.map((blocker) => ({ ...blocker, severity: "block" as const, message: "blocked" })) },
          { attempt: 2, violations: [] },
        ]
      : [],
    repairAttempts: spec.blockedBy ? 1 : 0,
    decision: {
      escalate,
      reasonCode: spec.code ?? null,
      secondaryReasonCodes: [],
      decidedBy: escalate ? (spec.decidedBy ?? "router_policy") : "none",
      category: spec.code ? ESCALATION_TABLE[spec.code].category : null,
    },
    failure: spec.failure ?? null,
    coverage: escalate ? null : (spec.coverage ?? "all"),
    modelCalls: spec.modelCalls ?? [],
    latencyMs: spec.latencyMs ?? 100,
    reply: {
      response: "x",
      escalate,
      escalationReason: escalate ? "why" : null,
      templateId: null,
      intent: "x",
      shouldFollowUp: false,
      followUpTiming: null,
      attachmentUrls: null,
      highEngagement: false,
      workingMemoryUpdates: null,
    },
  };
}

const many = (count: number, spec: Spec, runId?: string) => Array.from({ length: count }, () => trace(spec, runId));

describe("pricing", () => {
  it("finds a price by model prefix, including a dated id", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
    expect(priceFor("claude-sonnet-5-5")?.output).toBe(10);
    expect(priceFor("some-other-model")).toBeNull();
  });

  it("prices each token class at its own rate", () => {
    const cost = costOf({
      model: "claude-sonnet-5-5",
      inputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2 + 2.5 + 0.2 + 10, 10);
  });
});

describe("run summary", () => {
  const traces = [
    ...many(6, { intent: "clinic_packages" }),
    ...many(2, { intent: "human_request", code: "HUMAN_REQUESTED", decidedBy: "guard" }),
    trace({ intent: "deposit_terms", code: "MONEY_MOVE_OR_REFUND_ACTION" }),
    trace({
      intent: "payment",
      code: "SYSTEM_FAILURE",
      decidedBy: "validator_fallback",
      failure: { cause: "transient_api", detail: "HTTP 529" },
    }),
  ];
  const summary = summarize(traces);

  it("counts the rate, and splits it by reason code, decider and category", () => {
    expect(summary.messages).toBe(10);
    expect(summary.rate).toBeCloseTo(0.4, 10);
    expect(summary.byReasonCode).toEqual({ HUMAN_REQUESTED: 2, MONEY_MOVE_OR_REFUND_ACTION: 1, SYSTEM_FAILURE: 1 });
    expect(summary.byDecidedBy).toEqual({ guard: 2, router_policy: 1, validator_fallback: 1 });
    expect(summary.byCategory).toEqual({ policy_required: 3, avoidable: 1 });
    expect(summary.byFailureCause).toEqual({ transient_api: 1 });
  });

  it("keeps per-code counts adding up to the number escalated", () => {
    const total = Object.values(summary.byReasonCode).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(summary.escalated);
  });

  it("reports coverage for answered messages only", () => {
    const mixed = summarize([trace({ intent: "a", coverage: "none" }), trace({ intent: "a", coverage: "part" }), trace({ intent: "a", code: "CALL_REQUEST" })]);
    expect(mixed.coverage).toEqual({ none: 1, part: 1 });
    expect(mixed.answered).toBe(2);
  });

  it("adds up cost and lists a model it has no price for", () => {
    const call = (model: string) => ({
      stage: "responder" as const,
      model,
      inputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
      steps: 1,
      latencyMs: 10,
    });
    const priced = summarize([trace({ intent: "a", modelCalls: [call("claude-sonnet-5-5"), call("mystery-model")] })]);

    expect(priced.cost.total).toBeCloseTo((1000 * 2 + 100 * 10) / 1_000_000, 12);
    expect(priced.cost.unpricedModels).toEqual(["mystery-model"]);
    expect(priced.tokens.responder).toMatchObject({ calls: 2, input: 2000, output: 200 });
  });

  it("counts the model calls that needed a retry, by what failed", () => {
    const call = (failedAttempts?: number[]) => ({
      stage: "router" as const,
      model: "claude-haiku-4-5-20251001",
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      steps: 1,
      latencyMs: 10,
      ...(failedAttempts ? { failedAttempts } : {}),
    });
    const retried = summarize([
      trace({ intent: "a", modelCalls: [call(), call([529, 529])] }),
      trace({ intent: "a", modelCalls: [call([0]), call()] }),
    ]);

    expect(retried.retries).toEqual({ calls: 2, ofCalls: 4, byStatus: { "HTTP 529": 2, "no response": 1 } });
    expect(renderReport(retried)).toContain("2 of 4 model calls got through only after a retry (failed attempts: HTTP 529: 2, no response: 1)");
    expect(renderReport(summarize([trace({ intent: "a", modelCalls: [call()] })]))).toContain("None of the 1 model calls needed a retry.");
  });

  it("gives a guard decision its intent even in a trace that recorded none", () => {
    const old = { ...trace({ intent: "x", code: "HUMAN_REQUESTED", decidedBy: "guard" }), primaryIntent: null };
    expect(intentOf(old)).toBe("human_request");
  });
});

describe("repairs and stage latency", () => {
  const call = (stage: "router" | "responder" | "repair", latencyMs: number) => ({
    stage,
    model: stage === "router" ? "claude-haiku-4-5-20251001" : "claude-sonnet-5-5",
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    steps: 1,
    latencyMs,
  });
  const answered = (intent: string, blockedBy?: Spec["blockedBy"]) =>
    trace({ intent, blockedBy, modelCalls: [call("router", 3000), call("responder", 2000), ...(blockedBy ? [call("repair", 2500)] : [])] });

  const summary = summarize([
    answered("pricing_promos", [{ validator: "banned_phrases", rule: "price_refusal" }]),
    answered("pricing_promos", [{ validator: "banned_phrases", rule: "price_refusal" }, { validator: "price_grounding" }]),
    answered("pricing_promos"),
    answered("consultation", [{ validator: "url_provenance" }]),
    answered("travel"),
    // Escalated by the router: one model call, no draft, so it is not in the repair rate.
    trace({ intent: "human_request", code: "HUMAN_REQUESTED", modelCalls: [call("router", 9000)] }),
    // Escalated by the guard: no model call at all.
    trace({ intent: "human_request", code: "HUMAN_REQUESTED", decidedBy: "guard" }),
  ]);

  it("counts repairs against the messages that got a draft", () => {
    expect(summary.drafted).toBe(5);
    expect(summary.repairs).toBe(3);
  });

  it("names what blocked each first draft, by validator and rule, once per message", () => {
    expect(summary.blockedBy).toEqual({ "banned_phrases: price_refusal": 2, price_grounding: 1, url_provenance: 1 });
  });

  it("splits repairs by primary intent", () => {
    expect(summary.repairsByIntent).toEqual({
      pricing_promos: { drafted: 3, repaired: 2 },
      consultation: { drafted: 1, repaired: 1 },
      travel: { drafted: 1, repaired: 0 },
    });
  });

  it("gives the latency of each stage's calls", () => {
    expect(summary.stageLatencyMs).toEqual({
      router: { calls: 6, p50: 3000, p95: 9000 },
      responder: { calls: 5, p50: 2000, p95: 2000 },
      repair: { calls: 3, p50: 2500, p95: 2500 },
    });
  });

  it("renders the repair tables and the stage table", () => {
    const report = renderReport(summary);

    expect(report).toContain("3 of 5 drafted messages needed a repair (60.0%)");
    expect(report).toContain("| banned_phrases: price_refusal | 2 | 40.0% |");
    expect(report).toContain("| pricing_promos | 3 | 2 | 66.7% |");
    expect(report).not.toContain("| travel | 1 | 0 |");
    expect(report).toContain("| router | 6 | 3000 | 9000 |");
  });

  it("says so plainly when nothing needed a repair", () => {
    const clean = renderReport(summarize([answered("travel")]));
    expect(clean).toContain("0 of 1 drafted messages needed a repair (0.0%)");
    expect(clean).not.toContain("By what blocked the first draft");
  });
});

describe("wilson interval", () => {
  it("stays inside 0 and 1 and contains the observed rate", () => {
    for (const [successes, total] of [[0, 20], [5, 10], [20, 20], [14, 50]] as const) {
      const [low, high] = wilson(successes, total);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
      expect(low).toBeLessThanOrEqual(successes / total);
      expect(high).toBeGreaterThanOrEqual(successes / total);
    }
    expect(wilson(0, 0)).toEqual([0, 0]);
  });

  it("narrows as the run grows", () => {
    const small = wilson(3, 10);
    const large = wilson(300, 1000);
    expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
  });
});

describe("explaining a change", () => {
  const baseline = summarize([
    ...many(60, { intent: "clinic_packages" }),
    ...many(20, { intent: "payment" }),
    ...many(5, { intent: "payment", code: "PAYMENT_ACTION_NO_TOOL" }),
    ...many(10, { intent: "human_request", code: "HUMAN_REQUESTED", decidedBy: "guard" }),
    ...many(5, { intent: "dates_availability", code: "DATE_HOLD_OR_AVAILABILITY_ACTION" }),
  ]);
  const current = summarize([
    ...many(40, { intent: "clinic_packages" }),
    ...many(12, { intent: "payment" }),
    ...many(8, { intent: "payment", code: "PAYMENT_ACTION_NO_TOOL" }),
    ...many(25, { intent: "human_request", code: "HUMAN_REQUESTED", decidedBy: "guard" }),
    ...many(3, { intent: "travel" }),
    ...many(2, { intent: "travel", code: "SYSTEM_FAILURE", decidedBy: "validator_fallback", failure: { cause: "validator", detail: "x" } }),
  ]);
  const change = current.rate - baseline.rate;

  it("splits the change by reason code with nothing left over", () => {
    const contributions = byReasonCode(baseline, current);
    const total = contributions.reduce((sum, entry) => sum + entry.contribution, 0);

    expect(total).toBeCloseTo(change, 12);
    expect(contributions.find((entry) => entry.code === "DATE_HOLD_OR_AVAILABILITY_ACTION")?.contribution).toBeCloseTo(-0.05, 12);
    expect(contributions.find((entry) => entry.code === "SYSTEM_FAILURE")?.baselineRate).toBe(0);
  });

  it("splits the change into mix and rate effects with nothing left over", () => {
    const effects = byIntent(baseline, current);
    const total = effects.reduce((sum, effect) => sum + effect.mixEffect + effect.rateEffect, 0);
    expect(total).toBeCloseTo(change, 12);
  });

  it("calls it all mix when only the traffic changed", () => {
    const before = summarize([...many(80, { intent: "clinic_packages" }), ...many(20, { intent: "human_request", code: "HUMAN_REQUESTED" })]);
    const after = summarize([...many(50, { intent: "clinic_packages" }), ...many(50, { intent: "human_request", code: "HUMAN_REQUESTED" })]);
    const effects = byIntent(before, after);

    expect(effects.reduce((sum, effect) => sum + effect.rateEffect, 0)).toBeCloseTo(0, 12);
    expect(effects.reduce((sum, effect) => sum + effect.mixEffect, 0)).toBeCloseTo(0.3, 12);
  });

  it("calls it all rate when the traffic is the same and one intent escalates more", () => {
    const before = summarize([...many(45, { intent: "payment" }), ...many(5, { intent: "payment", code: "PAYMENT_ACTION_NO_TOOL" }), ...many(50, { intent: "travel" })]);
    const after = summarize([...many(30, { intent: "payment" }), ...many(20, { intent: "payment", code: "PAYMENT_ACTION_NO_TOOL" }), ...many(50, { intent: "travel" })]);
    const effects = byIntent(before, after);

    expect(effects.reduce((sum, effect) => sum + effect.mixEffect, 0)).toBeCloseTo(0, 12);
    expect(effects.reduce((sum, effect) => sum + effect.rateEffect, 0)).toBeCloseTo(0.15, 12);
  });

  it("counts an intent that only one run has as a change in mix", () => {
    const travel = byIntent(baseline, current).find((effect) => effect.intent === "travel");
    expect(travel?.rateBefore).toBeNull();
    expect(travel?.rateEffect).toBeCloseTo(0, 12);
    // Five of the ninety current messages are travel, and two of those five escalated.
    expect(travel?.mixEffect).toBeCloseTo((5 / 90) * 0.4, 12);
  });
});

describe("report text", () => {
  const baseline = summarize([...many(9, { intent: "clinic_packages" }, "last-week"), trace({ intent: "human_request", code: "HUMAN_REQUESTED" }, "last-week")]);
  const current = summarize([
    ...many(6, { intent: "clinic_packages" }, "this-week"),
    ...many(3, { intent: "payment", code: "SYSTEM_FAILURE", decidedBy: "validator_fallback", failure: { cause: "transient_api", detail: "HTTP 529" } }, "this-week"),
    trace({ intent: "human_request", code: "HUMAN_REQUESTED" }, "this-week"),
  ]);

  it("states the rate, the two categories and the failure causes", () => {
    const report = renderReport(current);

    expect(report).toContain("# Escalation report: this-week");
    expect(report).toContain("40.0% of messages were handed to a person (4 of 10)");
    expect(report).toContain("| Policy required | 1 | 10.0% |");
    expect(report).toContain("| Avoidable | 3 | 30.0% |");
    expect(report).toContain("| transient_api | 3 | 30.0% |");
    expect(report).toContain("It is not a policy problem");
    expect(report).toContain("a proxy, not a measurement");
    expect(report).not.toContain("## Change against");
  });

  it("explains a change against a baseline, down to the reason code", () => {
    const report = renderReport(current, baseline);

    expect(report).toContain("## Change against last-week");
    expect(report).toContain("from 10.0% (1 of 10) to 40.0% (4 of 10): +30.0 points");
    expect(report).toContain("| SYSTEM_FAILURE | 0.0% | 30.0% | +30.0 |");
    expect(report).toContain("| HUMAN_REQUESTED | 10.0% | 10.0% | +0.0 |");
    expect(report).toContain("| Total | 10.0% | 40.0% | +30.0 |");
    expect(report).toContain("Both runs used policy version v1");
  });
});
