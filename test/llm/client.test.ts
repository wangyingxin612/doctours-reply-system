import { APICallError, RetryError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelConfig } from "../../config/models";
import { callModel, LlmError, type LlmRequest } from "../../src/llm/client";

const config: ModelConfig = {
  routerModel: "mock-router",
  responderModel: "mock-responder",
  responderEffort: "low",
  maxRetries: 0,
  responderFallbacks: false,
};

const usage = {
  inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: undefined },
  outputTokens: { total: 30, text: 22, reasoning: 8 },
};

type Unified = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

function textReply(text: string, unified: Unified = "stop") {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified, raw: undefined },
    usage,
    warnings: [],
  };
}

const schema = z.object({ answer: z.string() });

function request(role: LlmRequest<unknown>["role"]): LlmRequest<{ answer: string }> {
  return { role, system: [{ text: "You answer in JSON.", cache: true }], prompt: "Say hi.", schema };
}

function apiError(statusCode: number | undefined, isRetryable: boolean) {
  return new APICallError({
    message: `status ${statusCode}`,
    url: "https://example.invalid/v1/messages",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("callModel", () => {
  it("returns the parsed object and maps usage by token class", async () => {
    const model = new MockLanguageModelV4({ doGenerate: textReply('{"answer":"hi"}') });
    const result = await callModel(request("responder"), { config, model });

    expect(result.output).toEqual({ answer: "hi" });
    expect(result.usage).toEqual({
      inputTokens: 20,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 30,
      reasoningTokens: 8,
    });
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toEqual([]);
  });

  it("sets temperature 0 on the router only, and effort on the responder only", async () => {
    const router = new MockLanguageModelV4({ doGenerate: textReply('{"answer":"hi"}') });
    await callModel(request("router"), { config, model: router });
    expect(router.doGenerateCalls[0]?.temperature).toBe(0);
    expect(router.doGenerateCalls[0]?.providerOptions?.anthropic?.effort).toBeUndefined();

    const responder = new MockLanguageModelV4({ doGenerate: textReply('{"answer":"hi"}') });
    await callModel(request("responder"), { config, model: responder });
    expect(responder.doGenerateCalls[0]?.temperature).toBeUndefined();
    expect(responder.doGenerateCalls[0]?.providerOptions?.anthropic?.effort).toBe("low");
  });

  it("turns on the refusal fallback only when the config asks for it", async () => {
    const off = new MockLanguageModelV4({ doGenerate: textReply('{"answer":"hi"}') });
    await callModel(request("responder"), { config, model: off });
    expect(off.doGenerateCalls[0]?.providerOptions?.anthropic).not.toHaveProperty("fallbacks");

    const on = new MockLanguageModelV4({ doGenerate: textReply('{"answer":"hi"}') });
    await callModel(request("responder"), { config: { ...config, responderFallbacks: true }, model: on });
    expect(on.doGenerateCalls[0]?.providerOptions?.anthropic?.fallbacks).toBe("default");

    const router = new MockLanguageModelV4({ doGenerate: textReply('{"answer":"hi"}') });
    await callModel(request("router"), { config: { ...config, responderFallbacks: true }, model: router });
    expect(router.doGenerateCalls[0]?.providerOptions?.anthropic).not.toHaveProperty("fallbacks");
  });

  it("runs a tool, then returns the structured answer within the step cap", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookupTool", input: '{"name":"alpha"}' }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        textReply('{"answer":"open on weekdays"}'),
      ],
    });
    const execute = vi.fn(() => ({ open: "weekdays" }));

    const result = await callModel(
      {
        ...request("responder"),
        tools: { lookupTool: { description: "Look up a record.", inputSchema: z.object({ name: z.string() }), execute } },
        maxSteps: 3,
      },
      { config, model },
    );

    expect(execute).toHaveBeenCalledWith({ name: "alpha" });
    expect(result.output).toEqual({ answer: "open on weekdays" });
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([{ name: "lookupTool", input: { name: "alpha" }, output: { open: "weekdays" } }]);
  });

  it("reports a reply that breaks the schema as invalid_output", async () => {
    const model = new MockLanguageModelV4({ doGenerate: textReply('{"wrong":1}') });
    const error = await failure(callModel(request("responder"), { config, model }));
    expect(error.failureCause).toBe("invalid_output");
  });

  it("reports a classifier block as refusal", async () => {
    const model = new MockLanguageModelV4({ doGenerate: textReply("", "content-filter") });
    const error = await failure(callModel(request("responder"), { config, model }));
    expect(error.failureCause).toBe("refusal");
  });

  it("retries a transient API error with backoff before giving up", async () => {
    vi.useFakeTimers();
    const doGenerate = vi.fn(async () => {
      throw apiError(529, true);
    });
    const model = new MockLanguageModelV4({ doGenerate });

    const pending = failure(callModel(request("responder"), { config: { ...config, maxRetries: 2 }, model }));
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await pending;

    expect(doGenerate).toHaveBeenCalledTimes(3);
    expect(error.failureCause).toBe("transient_api");
    expect(error.statusCode).toBe(529);
  });

  it("recovers when a retry succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) throw apiError(429, true);
        return textReply('{"answer":"hi"}');
      },
    });

    const pending = callModel(request("responder"), { config: { ...config, maxRetries: 2 }, model });
    await vi.advanceTimersByTimeAsync(60_000);

    expect((await pending).output).toEqual({ answer: "hi" });
    expect(calls).toBe(2);
  });

  it("classifies errors by kind", async () => {
    const cases: Array<[unknown, LlmError["failureCause"]]> = [
      [apiError(429, true), "transient_api"],
      [apiError(undefined, true), "transient_api"],
      [new RetryError({ message: "gave up", reason: "maxRetriesExceeded", errors: [apiError(503, true)] }), "transient_api"],
      [apiError(401, false), "auth"],
      [apiError(400, false), "model_error"],
      [new Error("boom"), "model_error"],
    ];

    for (const [thrown, expected] of cases) {
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          throw thrown;
        },
      });
      const error = await failure(callModel(request("responder"), { config, model }));
      expect(error.failureCause).toBe(expected);
    }
  });
});
