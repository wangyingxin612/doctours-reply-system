// The baseline runner with a mock model: what the original flow is sent, and what is kept of its answer.

import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../config/models";
import {
  answerWithOriginalPrompt,
  ORIGINAL_MAX_STEPS,
  originalSystemPrompt,
  originalUserMessage,
  runBaselineCase,
  type OriginalReply,
} from "../../eval/baseline/original";
import type { LoadedCase } from "../../eval/lib";
import * as constants from "../../src/context/packet";
import { FatalRunError } from "../../src/pipeline/errors";
import { replySchema } from "../../src/schema/reply";
import { TOOL_NAMES } from "../../src/tools/registry";
import { countSchema, MAX_OPTIONAL_FIELDS, MAX_UNION_FIELDS } from "../helpers/schemaLimits";

const config: ModelConfig = {
  routerModel: "mock-router",
  responderModel: "mock-responder",
  responderEffort: "medium",
  maxRetries: 0,
  routerAttemptTimeoutMs: 0,
  responderFallbacks: false,
};

const usage = {
  inputTokens: { total: 1000, noCache: 100, cacheRead: 900, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function toolCall(toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function drafted(overrides: Partial<OriginalReply> = {}): OriginalReply {
  return {
    response: "The clinic is open on weekdays.",
    escalate: false,
    escalationReason: null,
    intent: "answer a question about opening days",
    shouldFollowUp: false,
    followUpTiming: null,
    attachmentUrls: null,
    highEngagement: false,
    workingMemoryUpdates: null,
    ...overrides,
  };
}

function evalCase(expect: LoadedCase["expect"]): LoadedCase {
  return { id: "opening-days", source: "custom", split: "dev", tags: ["packages"], text: "Which days is the clinic open?", expect };
}

const SYSTEM = "The original prompt would be here.";

describe("the original prompt, filled", () => {
  const system = originalSystemPrompt();

  it("replaces every placeholder with the constant of the same name", () => {
    expect(system).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(system).toContain(constants.PATIENT_SUMMARY);
    expect(system).toContain(String(constants.SAVED_CLINIC_COUNT));
    expect(system.length).toBeGreaterThan(160_000);
  });

  it("builds the packet's user message around the patient's text", () => {
    const message = originalUserMessage("Which days is the clinic open?");
    expect(message).toContain('"Which days is the clinic open?"');
    expect(message).toContain(constants.RECENT_CONVERSATION_SUMMARY);
  });
});

describe("one message through the original flow", () => {
  it("sends the whole prompt as a cached system message, with every tool and the responder's effort", async () => {
    const model = new MockLanguageModelV4({ doGenerate: json(drafted()) });
    await answerWithOriginalPrompt("Which days is the clinic open?", SYSTEM, { config, model });

    const call = model.doGenerateCalls[0];
    expect(call?.prompt[0]).toMatchObject({
      role: "system",
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(JSON.stringify(call?.prompt[1])).toContain("Which days is the clinic open?");
    expect(call?.tools?.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(call?.providerOptions?.anthropic?.effort).toBe("medium");
    expect(call?.temperature).toBeUndefined();
  });

  it("keeps its output schema inside the API's limits", async () => {
    const model = new MockLanguageModelV4({ doGenerate: json(drafted()) });
    await answerWithOriginalPrompt("x", SYSTEM, { config, model });

    const format = model.doGenerateCalls[0]?.responseFormat;
    const counts = countSchema(format?.type === "json" ? format.schema : null);
    expect(counts.optional).toBeGreaterThan(0);
    expect(counts.optional).toBeLessThanOrEqual(MAX_OPTIONAL_FIELDS);
    expect(counts.unions).toBeLessThanOrEqual(MAX_UNION_FIELDS);
    expect(counts.openObjects).toBe(0);
    expect(counts.unsupportedKeywords).toEqual([]);
  });

  it("lets the model call tools, and records each call and the tokens of every step", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [toolCall("getSavedClinicsTool", {}), toolCall("getPaymentLinkTool", { type: "assessment" }), json(drafted())],
    });
    const answer = await answerWithOriginalPrompt("How do I pay?", SYSTEM, { config, model });

    expect(answer.toolCalls.map((call) => [call.name, call.source])).toEqual([
      ["getSavedClinicsTool", "responder"],
      ["getPaymentLinkTool", "responder"],
    ]);
    expect(answer.modelCall).toMatchObject({
      stage: "responder",
      steps: 3,
      inputTokens: 300,
      cacheReadTokens: 2700,
      cacheWriteTokens: 0,
      outputTokens: 150,
    });
  });

  it("returns a Reply that meets the contract, with templateId null and the response trimmed", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: json(
        drafted({
          response: "  You can book here.\r\nhttps://example.com/book \n",
          workingMemoryUpdates: { keyConcerns: "timing", collectionState: { lastAskedItem: "name", nameAskCount: 1 } },
        }),
      ),
    });
    const { reply } = await answerWithOriginalPrompt("How do I book?", SYSTEM, { config, model });

    expect(replySchema.safeParse(reply).success).toBe(true);
    expect(reply.templateId).toBeNull();
    expect(reply.response).toBe("You can book here.\nhttps://example.com/book");
    expect(reply.workingMemoryUpdates).toEqual({ keyConcerns: "timing", collectionState: { lastAskedItem: "name", nameAskCount: 1 } });
  });

  it("fails when the model is still calling tools at the step limit", async () => {
    const model = new MockLanguageModelV4({ doGenerate: toolCall("getAllClinicsTool", {}) });
    await expect(answerWithOriginalPrompt("x", SYSTEM, { config, model })).rejects.toMatchObject({ failureCause: "invalid_output" });
    expect(model.doGenerateCalls).toHaveLength(ORIGINAL_MAX_STEPS);
  });
});

describe("one eval case through the original flow", () => {
  it("passes a case whose reply meets it, and keeps the model, the effort and the cost inputs", async () => {
    const model = new MockLanguageModelV4({ doGenerate: json(drafted()) });
    const record = await runBaselineCase(evalCase({ escalate: false, mustMatch: ["weekdays"], urls: [] }), SYSTEM, { config, model });

    expect(record.result).toMatchObject({ id: "opening-days", passed: true, failures: [] });
    expect(record).toMatchObject({ caseId: "opening-days", model: "mock-responder", effort: "medium", failure: null, repairAttempts: 0 });
    expect(record.modelCalls).toHaveLength(1);
    expect(record.reply?.response).toBe("The clinic is open on weekdays.");
  });

  it("does not hold the missing reason code against it when it escalates as the case expects", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: json(drafted({ response: "I'm getting a person to help.", escalate: true, escalationReason: "The patient asked for a person." })),
    });
    const record = await runBaselineCase(evalCase({ escalate: true, reasonCode: "HUMAN_REQUESTED" }), SYSTEM, { config, model });

    expect(record.result.passed).toBe(true);
    expect(record.result).toMatchObject({ expectedEscalate: true, actualEscalate: true });
  });

  it("fails a case it answers when the case expects a person", async () => {
    const model = new MockLanguageModelV4({ doGenerate: json(drafted()) });
    const record = await runBaselineCase(evalCase({ escalate: true, reasonCodeIn: ["CALL_REQUEST", "HUMAN_REQUESTED"] }), SYSTEM, { config, model });

    expect(record.result.passed).toBe(false);
    expect(record.result.failures).toEqual(["escalate is false, expected true"]);
  });

  it("records a failed model call as a failed case with no reply, and does not escalate it", async () => {
    const model = new MockLanguageModelV4({ doGenerate: json({ wrong: 1 }) });
    const record = await runBaselineCase(evalCase({ escalate: true }), SYSTEM, { config, model });

    expect(record.reply).toBeNull();
    expect(record.failure?.cause).toBe("invalid_output");
    expect(record.modelCalls).toEqual([]);
    expect(record.result).toMatchObject({ passed: false, expectedEscalate: true, actualEscalate: false });
    expect(record.result.failures[0]).toMatch(/^no reply: invalid_output/);
  });

  it("keeps the tokens of a case that ran to the step limit without a reply", async () => {
    const model = new MockLanguageModelV4({ doGenerate: toolCall("getAllClinicsTool", {}) });
    const record = await runBaselineCase(evalCase({ escalate: false }), SYSTEM, { config, model });

    expect(record.reply).toBeNull();
    expect(record.result.failures).toEqual(["no reply: invalid_output: The model was still calling tools at the step limit."]);
    expect(record.modelCalls).toHaveLength(1);
    expect(record.modelCalls[0]).toMatchObject({ steps: ORIGINAL_MAX_STEPS, cacheReadTokens: 900 * ORIGINAL_MAX_STEPS });
  });

  it("stops the run when the account is out of credit", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "Your credit balance is too low to access the Anthropic API.",
          url: "https://example.invalid/v1/messages",
          requestBodyValues: {},
          statusCode: 400,
          isRetryable: false,
        });
      },
    });

    await expect(runBaselineCase(evalCase({ escalate: false }), SYSTEM, { config, model })).rejects.toBeInstanceOf(FatalRunError);
  });
});
