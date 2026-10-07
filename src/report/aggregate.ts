// Turns a run's traces into the numbers the Monday review reads.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costOf } from "../../config/pricing";
import { GUARD_INTENT, type GuardReasonCode } from "../pipeline/guard";
import type { ModelCallTrace, Trace } from "../trace/types";

export function loadRun(dir: string): Trace[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Trace);
}

/** A 95% Wilson interval for a rate. It stays sensible for small runs and for rates near 0 or 1. */
export function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/** The value at `fraction` of the way through a list sorted from low to high. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

/** One intent per message. Traces written before guard decisions carried an intent get it from the code. */
export function intentOf(trace: Trace): string {
  if (trace.primaryIntent) return trace.primaryIntent;
  if (trace.decision.decidedBy === "guard" && trace.decision.reasonCode) {
    return GUARD_INTENT[trace.decision.reasonCode as GuardReasonCode] ?? "other";
  }
  return "unclassified";
}

function count<Key extends string>(keys: readonly Key[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

export interface StageTokens {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface RunSummary {
  runId: string;
  messages: number;
  policyVersions: string[];
  models: string[];
  escalated: number;
  rate: number;
  interval: [number, number];
  byReasonCode: Record<string, number>;
  byDecidedBy: Record<string, number>;
  byCategory: Record<string, number>;
  /** Failures behind SYSTEM_FAILURE escalations. transient_api is not a policy problem. */
  byFailureCause: Record<string, number>;
  byIntent: Record<string, { messages: number; escalated: number }>;
  /** Self-reported by the responder for answered messages. A proxy, not a measurement. */
  coverage: Record<string, number>;
  answered: number;
  repairs: number;
  warnings: number;
  cost: { total: number; perMessage: number; unpricedModels: string[] };
  tokens: Record<string, StageTokens>;
  latencyMs: { p50: number; p95: number; answeredP50: number; answeredP95: number };
  /** Model calls that got through only after a retry, and the HTTP statuses that caused the retries. */
  retries: { calls: number; ofCalls: number; byStatus: Record<string, number> };
}

/** How many model calls needed a retry, and why. Status 0 is a request that got no response. */
export function retriesOf(calls: readonly ModelCallTrace[]): RunSummary["retries"] {
  const failed = calls.flatMap((call) => call.failedAttempts ?? []);
  return {
    calls: calls.filter((call) => (call.failedAttempts?.length ?? 0) > 0).length,
    ofCalls: calls.length,
    byStatus: count(failed.map((status) => (status === 0 ? "no response" : `HTTP ${status}`))),
  };
}

export function summarize(traces: readonly Trace[]): RunSummary {
  const escalated = traces.filter((trace) => trace.decision.escalate);
  const answered = traces.filter((trace) => !trace.decision.escalate);

  const byIntent: RunSummary["byIntent"] = {};
  for (const trace of traces) {
    const entry = (byIntent[intentOf(trace)] ??= { messages: 0, escalated: 0 });
    entry.messages += 1;
    if (trace.decision.escalate) entry.escalated += 1;
  }

  const tokens: RunSummary["tokens"] = {};
  const unpriced = new Set<string>();
  let cost = 0;
  for (const call of traces.flatMap((trace) => trace.modelCalls)) {
    const stage = (tokens[call.stage] ??= { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    stage.calls += 1;
    stage.input += call.inputTokens;
    stage.cacheRead += call.cacheReadTokens;
    stage.cacheWrite += call.cacheWriteTokens;
    stage.output += call.outputTokens;

    const callCost = costOf(call);
    if (callCost === null) unpriced.add(call.model);
    else cost += callCost;
  }

  const latencies = traces.map((trace) => trace.latencyMs).sort((a, b) => a - b);
  const answeredLatencies = answered.map((trace) => trace.latencyMs).sort((a, b) => a - b);

  return {
    runId: traces[0]?.runId ?? "empty",
    messages: traces.length,
    policyVersions: [...new Set(traces.map((trace) => trace.policyVersion))],
    models: [...new Set(traces.flatMap((trace) => [trace.models.router, `${trace.models.responder} (effort ${trace.models.responderEffort})`]))],
    escalated: escalated.length,
    rate: traces.length === 0 ? 0 : escalated.length / traces.length,
    interval: wilson(escalated.length, traces.length),
    byReasonCode: count(escalated.map((trace) => trace.decision.reasonCode ?? "unknown")),
    byDecidedBy: count(escalated.map((trace) => trace.decision.decidedBy)),
    byCategory: count(escalated.map((trace) => trace.decision.category ?? "unknown")),
    byFailureCause: count(traces.flatMap((trace) => (trace.failure ? [trace.failure.cause] : []))),
    byIntent,
    coverage: count(answered.map((trace) => trace.coverage ?? "unknown")),
    answered: answered.length,
    repairs: traces.filter((trace) => trace.repairAttempts > 0).length,
    warnings: traces.flatMap((trace) => trace.validation.flatMap((entry) => entry.violations)).filter((violation) => violation.severity === "warn").length,
    cost: { total: cost, perMessage: traces.length === 0 ? 0 : cost / traces.length, unpricedModels: [...unpriced] },
    tokens,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      answeredP50: percentile(answeredLatencies, 0.5),
      answeredP95: percentile(answeredLatencies, 0.95),
    },
    retries: retriesOf(traces.flatMap((trace) => trace.modelCalls)),
  };
}
