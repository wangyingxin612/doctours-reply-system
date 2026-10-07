// The only file that imports a model SDK. Everything else calls callModel().

import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import {
  APICallError,
  generateText,
  isStepCount,
  Output,
  RetryError,
  tool,
  type LanguageModel,
  type ToolSet,
} from "ai";
import { AsyncLocalStorage } from "node:async_hooks";
import type { z } from "zod";
import { loadModelConfig, type ModelConfig } from "../../config/models";

export type LlmRole = "router" | "responder";

export interface SystemBlock {
  text: string;
  /** Marks the end of a stable prefix. Everything up to and including this block can be cached. */
  cache?: boolean;
}

export interface LlmTool {
  description: string;
  inputSchema: z.ZodType;
  execute: (input: unknown) => unknown | Promise<unknown>;
}

export interface LlmRequest<T> {
  role: LlmRole;
  system: SystemBlock[];
  prompt: string;
  schema: z.ZodType<T>;
  tools?: Record<string, LlmTool>;
  /** Model calls allowed, counting the final structured answer. 3 means at most two tool rounds. */
  maxSteps?: number;
  maxOutputTokens?: number;
  /**
   * How long one HTTP attempt may wait for a response, in milliseconds. An attempt that runs out is
   * dropped and retried like a lost connection. Leave it out, or give 0, for no limit of ours.
   */
  attemptTimeoutMs?: number;
}

export interface LlmUsage {
  /** Input tokens billed at the full rate. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Includes reasoning tokens. */
  outputTokens: number;
  reasoningTokens: number;
}

export interface LlmToolCall {
  name: string;
  input: unknown;
  output: unknown;
}

/** What a call used, whether or not it ended in an answer. */
export interface LlmSpend {
  usage: LlmUsage;
  steps: number;
  /** The model that answered. Differs from the requested model only if a fallback served the turn. */
  model: string;
  /** Includes the time spent waiting between retries. */
  latencyMs: number;
  /** HTTP status of each attempt that failed and was retried. 0 means the request got no response. */
  failedAttempts: number[];
}

export interface LlmResult<T> extends LlmSpend {
  output: T;
  toolCalls: LlmToolCall[];
  finishReason: string;
  warnings: string[];
}

/**
 * transient_api: 429, 5xx, overloaded or network, after retries ran out.
 * auth: the key is missing or rejected. The run cannot continue.
 * billing: the account has no credit left. The run cannot continue.
 * refusal: the model's safety classifiers declined the request.
 * invalid_output: the reply did not match the schema.
 * model_error: any other API or SDK failure.
 */
export type LlmFailureCause = "transient_api" | "auth" | "billing" | "refusal" | "invalid_output" | "model_error";

/** The API reports an empty account as a plain 400, so it has to be recognized by its message. */
const OUT_OF_CREDIT = /credit balance|purchase credits|billing/i;

export class LlmError extends Error {
  readonly failureCause: LlmFailureCause;
  readonly statusCode: number | undefined;
  /** Set only when the step limit ran out while the model was still calling tools: what that attempt used. */
  readonly spentAtStepLimit: LlmSpend | undefined;

  constructor(
    failureCause: LlmFailureCause,
    message: string,
    options?: { statusCode?: number; cause?: unknown; spentAtStepLimit?: LlmSpend },
  ) {
    super(message, { cause: options?.cause });
    this.name = "LlmError";
    this.failureCause = failureCause;
    this.statusCode = options?.statusCode;
    this.spentAtStepLimit = options?.spentAtStepLimit;
  }
}

export interface LlmDeps {
  config?: ModelConfig;
  /** Replaces the real model. Unit tests pass a mock here. */
  model?: LanguageModel;
}

const DEFAULT_MAX_OUTPUT_TOKENS: Record<LlmRole, number> = {
  router: 1024,
  // Thinking counts toward this limit even at low effort, so leave room beyond the reply itself.
  responder: 8000,
};

/** What the fetch wrapper knows about the model call in progress. */
interface CallContext {
  /** The SDK retries inside one call and reports none of it, so each failed attempt is noted here. */
  failedAttempts: number[];
  attemptTimeoutMs: number | undefined;
}

const callContext = new AsyncLocalStorage<CallContext>();

/**
 * fetch, with two additions. Every failed attempt is noted, so a slow call can be told apart from
 * a retried one. And an attempt may be given a time limit: when it runs out, the attempt fails the
 * way a lost connection does, which the SDK retries. The limit covers the wait for the response to
 * start. For these calls, which do not stream, that is nearly all of the call.
 */
const recordingFetch: typeof fetch = async (input, init) => {
  const context = callContext.getStore();
  const limit = context?.attemptTimeoutMs;
  const ours = limit ? new AbortController() : null;
  const timer = ours ? setTimeout(() => ours.abort(), limit) : null;
  const signal = ours ? (init?.signal ? AbortSignal.any([init.signal, ours.signal]) : ours.signal) : init?.signal;
  try {
    const response = await fetch(input, signal ? { ...init, signal } : init);
    if (!response.ok) context?.failedAttempts.push(response.status);
    return response;
  } catch (error) {
    context?.failedAttempts.push(0);
    if (ours?.signal.aborted && !init?.signal?.aborted) {
      throw new TypeError("fetch failed", { cause: new Error(`No response within ${limit} ms.`) });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

function resolveModel(role: LlmRole, config: ModelConfig): LanguageModel {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmError("auth", "ANTHROPIC_API_KEY is not set. Put it in .env or export it.");
  }
  const anthropic = createAnthropic({ apiKey, fetch: recordingFetch });
  return anthropic(role === "router" ? config.routerModel : config.responderModel);
}

function toSdkTools(tools: Record<string, LlmTool> | undefined): ToolSet | undefined {
  if (!tools) return undefined;
  const entries = Object.entries(tools).map(([name, definition]) => [
    name,
    tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (input: unknown) => definition.execute(input),
    }),
  ]);
  return entries.length > 0 ? (Object.fromEntries(entries) as ToolSet) : undefined;
}

function toInstructions(system: SystemBlock[]) {
  return system.map((block) => ({
    role: "system" as const,
    content: block.text,
    ...(block.cache ? { providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } } : {}),
  }));
}

function classifyError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  const outOfRetries = RetryError.isInstance(error);
  const root = outOfRetries ? error.lastError : error;

  if (APICallError.isInstance(root)) {
    const { statusCode } = root;
    if (statusCode === 401 || statusCode === 403) {
      return new LlmError("auth", `The API rejected the key (HTTP ${statusCode}).`, { statusCode, cause: error });
    }
    if (OUT_OF_CREDIT.test(root.message) || OUT_OF_CREDIT.test(root.responseBody ?? "")) {
      return new LlmError("billing", "The API account is out of credit. Add credit and run again.", {
        statusCode,
        cause: error,
      });
    }
    if (root.isRetryable) {
      const where = statusCode === undefined ? "network error" : `HTTP ${statusCode}`;
      return new LlmError("transient_api", `Transient API error (${where}) outlasted its retries.`, {
        statusCode,
        cause: error,
      });
    }
    return new LlmError("model_error", `API error (HTTP ${statusCode ?? "unknown"}): ${root.message}`, {
      statusCode,
      cause: error,
    });
  }

  const name = error instanceof Error ? error.name : "";
  if (name.includes("NoObjectGenerated") || name.includes("NoOutputGenerated") || name.includes("TypeValidation")) {
    return new LlmError("invalid_output", "The model's reply did not match the schema.", { cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LlmError("model_error", message, { cause: error });
}

export async function callModel<T>(request: LlmRequest<T>, deps: LlmDeps = {}): Promise<LlmResult<T>> {
  const config = deps.config ?? loadModelConfig();
  const started = Date.now();

  try {
    const model = deps.model ?? resolveModel(request.role, config);
    const anthropicOptions =
      request.role === "responder"
        ? ({
            effort: config.responderEffort,
            ...(config.responderFallbacks ? { fallbacks: "default" as const } : {}),
          } satisfies AnthropicLanguageModelOptions)
        : {};

    const failedAttempts: number[] = [];
    const result = await callContext.run({ failedAttempts, attemptTimeoutMs: request.attemptTimeoutMs || undefined }, () =>
      generateText({
        model,
        instructions: toInstructions(request.system),
        prompt: request.prompt,
        output: Output.object({ schema: request.schema }),
        tools: toSdkTools(request.tools),
        stopWhen: isStepCount(request.maxSteps ?? 1),
        maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS[request.role],
        maxRetries: config.maxRetries,
        // The responder model rejects any non-default temperature, so only the router sets one.
        ...(request.role === "router" ? { temperature: 0 } : {}),
        providerOptions: { anthropic: anthropicOptions },
      }),
    );

    if (result.finishReason === "content-filter") {
      throw new LlmError("refusal", "The model declined the request (stop reason: refusal).");
    }

    const usage = result.totalUsage;
    const spend: LlmSpend = {
      usage: {
        inputTokens: usage.inputTokenDetails.noCacheTokens ?? usage.inputTokens ?? 0,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? 0,
      },
      steps: result.steps.length,
      model: result.response.modelId,
      latencyMs: Date.now() - started,
      failedAttempts,
    };

    if (result.finishReason === "tool-calls") {
      // Every step went to tool calls, so there is no answer to read. The caller still learns the cost.
      throw new LlmError("invalid_output", "The model was still calling tools at the step limit.", { spentAtStepLimit: spend });
    }

    const toolCalls: LlmToolCall[] = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({
        name: call.toolName,
        input: call.input,
        output: step.toolResults.find((toolResult) => toolResult.toolCallId === call.toolCallId)?.output,
      })),
    );

    return {
      output: result.output as T,
      ...spend,
      toolCalls,
      finishReason: result.finishReason,
      warnings: (result.warnings ?? []).map((warning) => JSON.stringify(warning)),
    };
  } catch (error) {
    throw classifyError(error);
  }
}
