// The model stages with a mock model: the router's JSON comes first, then the responder's.

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../config/models";
import { buildPacketContext } from "../../src/context/fixture";
import { createAnswerStage, currentPolicyVersion } from "../../src/pipeline/answer";
import type { ResponderOutput } from "../../src/pipeline/responder";
import type { RouterOutput } from "../../src/pipeline/router";
import { runMessage, type PipelineDeps } from "../../src/pipeline/run";
import { HANDOFF_SENTENCE } from "../../src/policy/escalation";

const config: ModelConfig = {
  routerModel: "mock-router",
  responderModel: "mock-responder",
  responderEffort: "low",
  maxRetries: 0,
  responderFallbacks: false,
};

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

type RouterOverrides = Omit<Partial<RouterOutput>, "entities"> & { entities?: Partial<RouterOutput["entities"]> };

function routed(overrides: RouterOverrides = {}): RouterOutput {
  const { entities, ...rest } = overrides;
  return {
    primaryIntent: "clinic_packages",
    intents: ["clinic_packages"],
    skills: ["clinic-packages"],
    requestType: "question",
    humanRequested: false,
    requestedActions: [],
    selfServe: [],
    needsCallHistory: false,
    rationale: "test",
    confidence: "high",
    ...rest,
    entities: {
      clinics: ["Dr. Hakan Clinic"],
      packages: [],
      clinicLean: null,
      packageLean: null,
      statedTiming: null,
      statedName: null,
      linksRequested: [],
      ...entities,
    },
  };
}

function drafted(overrides: Partial<ResponderOutput> = {}): ResponderOutput {
  return {
    response: "Sapphire costs $3,200 and its deposit is $500.",
    intent: "answer a pricing question",
    shouldFollowUp: false,
    followUpTiming: null,
    highEngagement: true,
    attachmentUrls: null,
    workingMemoryUpdates: null,
    coverage: "all",
    ...overrides,
  };
}

/** A model step that calls one tool instead of answering. */
class ToolCallStep {
  constructor(
    readonly toolName: string,
    readonly input: unknown,
  ) {}

  result() {
    return {
      content: [{ type: "tool-call" as const, toolCallId: `call-${this.toolName}`, toolName: this.toolName, input: JSON.stringify(this.input) }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage,
      warnings: [],
    };
  }
}

const toolCall = (toolName: string, input: unknown) => new ToolCallStep(toolName, input);

function run(text: string, replies: unknown[]) {
  const model = new MockLanguageModelV4({
    doGenerate: replies.map((reply) => (reply instanceof ToolCallStep ? reply.result() : json(reply))),
  });
  const deps: PipelineDeps = {
    context: buildPacketContext(),
    config,
    policyVersion: "test-version",
    answer: createAnswerStage({ model }),
  };
  return runMessage({ id: "m", text }, 0, "run", deps).then((result) => ({ ...result, model }));
}

/** Everything the model was sent on one call, as one string. */
function sent(model: MockLanguageModelV4, call: number): string {
  return JSON.stringify(model.doGenerateCalls[call]?.prompt);
}

describe("answer stage: escalation decided from the router's classification", () => {
  it("escalates a human request without calling the responder or any tool", async () => {
    const { reply, trace, model } = await run("could somebody from your team get on this with me?", [
      routed({ primaryIntent: "human_request", humanRequested: true, skills: [] }),
    ]);

    expect(reply).toMatchObject({ escalate: true, response: HANDOFF_SENTENCE });
    expect(trace.decision).toMatchObject({ decidedBy: "router_policy", reasonCode: "HUMAN_REQUESTED" });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(trace.toolCalls.map((call) => call.name)).toEqual(["updateWorkingMemoryTool"]);
    expect(trace.primaryIntent).toBe("human_request");
  });

  it("escalates the whole message when one action has no tool, even if the rest is a question", async () => {
    const { reply, trace, model } = await run("What does Gold include, and please refund what I paid.", [
      routed({
        requestType: "mixed",
        requestedActions: [{ type: "move_or_refund_money", evidence: "please refund what I paid" }],
        entities: { clinics: ["Heva Clinic"], clinicLean: "selected" },
      }),
    ]);

    expect(reply.escalate).toBe(true);
    expect(reply.response).not.toMatch(/gold|\$/i);
    expect(trace.decision.reasonCode).toBe("MONEY_MOVE_OR_REFUND_ACTION");
    expect(model.doGenerateCalls).toHaveLength(1);
    // No prefetch and no side effect on an escalated message, even though the router saw a clinic lean.
    expect(trace.toolCalls.map((call) => call.name)).toEqual(["updateWorkingMemoryTool"]);
  });

  it("answers when the only action is one a tool or rule handles", async () => {
    const { reply, trace } = await run("Any chance of a discount on Sapphire?", [
      routed({ requestedActions: [{ type: "request_discount", evidence: "any chance of a discount" }] }),
      drafted(),
    ]);

    expect(reply.escalate).toBe(false);
    expect(trace.decision.decidedBy).toBe("none");
  });
});

describe("answer stage: answering", () => {
  it("returns the responder's reply with the code-owned fields filled in", async () => {
    const { reply, trace, model } = await run("What does Dr. Hakan cost?", [routed(), drafted()]);

    expect(reply).toEqual({
      response: "Sapphire costs $3,200 and its deposit is $500.",
      escalate: false,
      escalationReason: null,
      templateId: null,
      intent: "answer a pricing question",
      shouldFollowUp: false,
      followUpTiming: null,
      attachmentUrls: null,
      highEngagement: true,
      workingMemoryUpdates: null,
    });
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(trace.skillsLoaded).toEqual(["core", "stage-pre-clinical-sent", "clinic-packages"]);
    expect(trace.modelCalls.map((call) => call.stage)).toEqual(["router", "responder"]);
    expect(trace.coverage).toBe("all");
    expect(trace.failure).toBeNull();
  });

  it("shows the router the skill index and the action catalog, but no skill body", async () => {
    const { model } = await run("What does Dr. Hakan cost?", [routed(), drafted()]);
    const routerPrompt = sent(model, 0);

    expect(routerPrompt).toContain("- clinic-packages: ");
    expect(routerPrompt).toContain("- move_or_refund_money: ");
    expect(routerPrompt).toContain("What does Dr. Hakan cost?");
    expect(routerPrompt).not.toContain("TOOL-GROUNDED ONLY");
    expect(routerPrompt).not.toContain("Never describe your limits in terms of the channel");
  });

  it("shows the responder core, the stage, the selected skill, the facts and the directives, and nothing else", async () => {
    const { model } = await run("What does Dr. Hakan cost?", [routed(), drafted()]);
    const responderPrompt = sent(model, 1);

    expect(responderPrompt).toContain("# IDENTITY");
    expect(responderPrompt).toContain("PRE_CLINICAL_SENT (decision stage)");
    expect(responderPrompt).toContain("## SKILL: clinic-packages");
    expect(responderPrompt).toContain("getClinicPackagesTool");
    expect(responderPrompt).toContain("Sapphire");
    expect(responderPrompt).toContain("quoteDepositWithPrice");
    expect(responderPrompt).toContain("Incoming thread message:");
    // Rules for topics this message is not about never reach the model.
    expect(responderPrompt).not.toContain("## SKILL: consultation");
    expect(responderPrompt).not.toContain("CONSULTATION RESCHEDULING");
    expect(responderPrompt).not.toContain("DEPOSIT ELIGIBILITY RULE");
  });

  it("drops memory fields that did not change and keeps the ones that did", async () => {
    const { reply } = await run("What does Dr. Hakan cost? Money is tight for me.", [
      routed(),
      drafted({
        workingMemoryUpdates: {
          communicationStyle: "casual",
          keyConcerns: "price sensitive",
          patientName: null,
          preferredPaymentMethod: null,
          procedureArea: "hairline",
          promisesMade: null,
          targetProcedureWindow: null,
        },
      }),
    ]);

    // communicationStyle and procedureArea already hold these values in working memory.
    expect(reply.workingMemoryUpdates).toEqual({ keyConcerns: "price sensitive" });
  });

  it("clears followUpTiming when the model says no follow-up is due", async () => {
    const { reply } = await run("What does Dr. Hakan cost?", [routed(), drafted({ shouldFollowUp: false, followUpTiming: "1 month" })]);
    expect(reply.followUpTiming).toBeNull();
  });
});

describe("answer stage: validation and repair", () => {
  it("repairs a draft that states a price no tool returned", async () => {
    const { reply, trace, model } = await run("What does Dr. Hakan cost?", [
      routed(),
      drafted({ response: "Sapphire is about $2,900." }),
      drafted(),
    ]);

    expect(reply.response).toBe("Sapphire costs $3,200 and its deposit is $500.");
    expect(trace.repairAttempts).toBe(1);
    expect(trace.validation[0]?.violations.map((violation) => violation.validator)).toEqual(["price_grounding"]);
    expect(trace.validation[1]?.violations).toEqual([]);
    expect(trace.modelCalls.map((call) => call.stage)).toEqual(["router", "responder", "repair"]);
    // The repair request carries the draft and what was wrong with it.
    expect(sent(model, 2)).toContain("is not in this turn's tool data");
  });

  it("hands the message to a person when the repair still breaks a rule", async () => {
    const { reply, trace } = await run("What does Dr. Hakan cost?", [
      routed(),
      drafted({ response: "Sapphire is about $2,900." }),
      drafted({ response: "Sapphire is roughly $3,000." }),
    ]);

    expect(reply).toMatchObject({ escalate: true, response: HANDOFF_SENTENCE });
    expect(trace.decision).toMatchObject({ reasonCode: "SYSTEM_FAILURE", decidedBy: "validator_fallback", category: "avoidable" });
    expect(trace.failure?.cause).toBe("validator");
    expect(trace.repairAttempts).toBe(1);
  });

  it("blocks a link the plan did not include, and requires the one it did", async () => {
    const consultation = routed({ primaryIntent: "consultation", skills: ["consultation"], entities: { clinics: [] } });
    const { reply, trace } = await run("How does the consultation work?", [
      consultation,
      drafted({ response: "It is a free phone call. Book at https://www.doctours.com/somewhere-else" }),
      drafted({ response: "It is a free phone call. You can book using the link below.\nhttps://www.doctours.com/consultation" }),
    ]);

    expect(trace.validation[0]?.violations.map((violation) => violation.validator)).toEqual(
      expect.arrayContaining(["url_last_line", "url_provenance"]),
    );
    expect(reply.response.endsWith("https://www.doctours.com/consultation")).toBe(true);
    expect(reply.escalate).toBe(false);
  });

  it("fails over when the router's output does not match its schema", async () => {
    const { reply, trace } = await run("What does Dr. Hakan cost?", [{ primaryIntent: "not-an-intent" }]);

    expect(reply.escalate).toBe(true);
    expect(trace.failure?.cause).toBe("invalid_output");
  });
});

describe("answer stage: the responder's own tool calls", () => {
  const WINTER_ANSWER = "Winter is a busy season for the clinics in Turkey, so popular months can fill up.";
  const datesQuestion = () =>
    routed({ primaryIntent: "dates_availability", intents: ["dates_availability"], skills: ["dates-availability"], entities: { clinics: [] } });

  /** The system text of one call: rules, skills, patient context, facts and directives. */
  const systemText = (model: MockLanguageModelV4, call: number) =>
    (model.doGenerateCalls[call]?.prompt ?? []).map((message) => (message.role === "system" ? message.content : "")).join("\n");

  it("does not offer a tool whose result code already fetched", async () => {
    const { model, trace } = await run("Is winter a busy time for the clinics?", [datesQuestion(), drafted({ response: WINTER_ANSWER })]);

    // The dates skill allows two tools. Code prefetched the patient context, so only the other is offered.
    expect(trace.toolCalls.filter((call) => call.source === "prefetch").map((call) => call.name)).toContain("getPatientContextTool");
    expect(model.doGenerateCalls[1]?.tools?.map((tool) => tool.name)).toEqual(["getClinicPackagesTool"]);
  });

  it("still offers a clinic tool after code used it for one clinic, so the model can fetch a second clinic the plan missed", async () => {
    // The router names Heva only, and no clinic name in the text matches Dr. Hakan Clinic.
    const { reply, trace, model } = await run("What does Heva charge, and what about the other clinic you matched me with?", [
      routed({ entities: { clinics: ["Heva Clinic"] } }),
      toolCall("getClinicPackagesTool", { clinicName: "Dr. Hakan Clinic" }),
      drafted({
        response:
          "Heva's Silver is $3,000 with a $500 deposit, and Gold is $4,500 with a $600 deposit. Dr. Hakan Clinic's Sapphire is $3,200 with a $500 deposit.",
      }),
    ]);

    // Code fetched packages for the one clinic it knew about.
    const byCode = trace.toolCalls.filter((call) => call.name === "getClinicPackagesTool" && call.source === "prefetch");
    expect(byCode).toHaveLength(1);

    // The same tool is still offered, because its input can differ. A tool with only one possible input is not.
    const offered = model.doGenerateCalls[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(offered).toContain("getClinicPackagesTool");
    expect(offered).not.toContain("getAllClinicsTool");
    expect(trace.toolCalls.some((call) => call.name === "getAllClinicsTool")).toBe(true);

    // The model's call for the second clinic ran, and the price it returned counts as grounded.
    expect(trace.toolCalls.filter((call) => call.source === "responder").map((call) => call.input)).toEqual([{ clinicName: "Dr. Hakan Clinic" }]);
    expect(trace.validation[0]?.violations.filter((violation) => violation.severity === "block")).toEqual([]);
    expect(reply.escalate).toBe(false);
    expect(reply.response).toContain("$3,200");
  });

  it("lets the model fetch a fact code did not, and records the call", async () => {
    const { reply, trace } = await run("Is winter a busy time for the clinics?", [
      datesQuestion(),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      drafted({ response: WINTER_ANSWER }),
    ]);

    expect(reply).toMatchObject({ escalate: false, response: WINTER_ANSWER });
    expect(trace.toolCalls.filter((call) => call.source === "responder").map((call) => call.name)).toEqual(["getClinicPackagesTool"]);
    expect(trace.modelCalls.map((call) => [call.stage, call.steps])).toEqual([["router", 1], ["responder", 2]]);
    expect(trace.events).toEqual([]);
  });

  it("answers from the facts when the model spends every step on tool calls", async () => {
    const { reply, trace, model } = await run("Is winter a busy time for the clinics?", [
      datesQuestion(),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Dr. Hakan Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      drafted({ response: WINTER_ANSWER }),
    ]);

    expect(reply).toMatchObject({ escalate: false, response: WINTER_ANSWER });
    expect(trace.failure).toBeNull();
    expect(trace.events).toContainEqual({ type: "tool_rounds_exhausted", detail: { steps: 3 } });
    // Both responder calls are in the trace, so the steps that produced no answer are still paid for on paper.
    expect(trace.modelCalls.map((call) => [call.stage, call.steps])).toEqual([["router", 1], ["responder", 3], ["responder", 1]]);

    // The last call has no tools. Its facts hold what the model fetched, and the repeated call is shown once.
    expect(model.doGenerateCalls).toHaveLength(5);
    expect(model.doGenerateCalls[4]?.tools ?? []).toEqual([]);
    const facts = systemText(model, 4);
    expect(facts.split('## getClinicPackagesTool({"clinicName":"Heva Clinic"})')).toHaveLength(2);
    expect(facts.split('## getClinicPackagesTool({"clinicName":"Dr. Hakan Clinic"})')).toHaveLength(2);
    expect(systemText(model, 1)).not.toContain("## getClinicPackagesTool(");
  });

  it("checks the answer from the call without tools like any other draft, and repairs it once", async () => {
    const { reply, trace, model } = await run("Is winter a busy time for the clinics?", [
      datesQuestion(),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Dr. Hakan Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      drafted({ response: "Winter is busy, and a January date costs $9,999." }),
      drafted({ response: WINTER_ANSWER }),
    ]);

    // The answer from the call without tools went through the validators, and one of them blocked it.
    expect(trace.validation.map((entry) => [entry.attempt, entry.violations.filter((violation) => violation.severity === "block").map((violation) => violation.validator)])).toEqual([
      [1, ["price_grounding"]],
      [2, []],
    ]);
    expect(reply).toMatchObject({ escalate: false, response: WINTER_ANSWER });
    expect(trace.repairAttempts).toBe(1);

    // Every call is in the trace. This is the longest path the packet's data allows: six model calls.
    // A long call history adds one call by the subtask, which makes seven.
    expect(trace.modelCalls.map((call) => [call.stage, call.steps])).toEqual([
      ["router", 1],
      ["responder", 3],
      ["responder", 1],
      ["repair", 1],
    ]);
    expect(model.doGenerateCalls).toHaveLength(6);
  });

  it("hands the message to a person when the answer without tools fails its repair as well, with no further call", async () => {
    const { reply, trace, model } = await run("Is winter a busy time for the clinics?", [
      datesQuestion(),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      drafted({ response: "Winter is busy, and a January date costs $9,999." }),
      drafted({ response: "Winter is busy, and a January date costs $8,888." }),
    ]);

    expect(reply).toMatchObject({ escalate: true, response: HANDOFF_SENTENCE });
    expect(trace.failure?.cause).toBe("validator");
    expect(model.doGenerateCalls).toHaveLength(6);
  });

  it("still hands the message to a person when the call without tools fails too", async () => {
    const { reply, trace } = await run("Is winter a busy time for the clinics?", [
      datesQuestion(),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      toolCall("getClinicPackagesTool", { clinicName: "Heva Clinic" }),
      { wrong: 1 },
    ]);

    expect(reply).toMatchObject({ escalate: true, response: HANDOFF_SENTENCE });
    expect(trace.decision).toMatchObject({ reasonCode: "SYSTEM_FAILURE", decidedBy: "validator_fallback" });
    expect(trace.failure?.cause).toBe("invalid_output");
  });
});

describe("policy version", () => {
  it("is stable for the same rules and names the table version", () => {
    expect(currentPolicyVersion("hair")).toBe(currentPolicyVersion("hair"));
    expect(currentPolicyVersion("hair")).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+\+[0-9a-f]{12}$/);
  });
});
