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

export interface LlmResult<T> {
  output: T;
  usage: LlmUsage;
  steps: number;
  toolCalls: LlmToolCall[];
  finishReason: string;
  /** The model that answered. Differs from the requested model only if a fallback served the turn. */
  model: string;
  latencyMs: number;
  warnings: string[];
}

/**
 * transient_api: 429, 5xx, overloaded or network, after retries ran out.
 * auth: the key is missing or rejected. The run cannot continue.
 * refusal: the model's safety classifiers declined the request.
 * invalid_output: the reply did not match the schema.
 * model_error: any other API or SDK failure.
 */
export type LlmFailureCause = "transient_api" | "auth" | "refusal" | "invalid_output" | "model_error";

export class LlmError extends Error {
  readonly failureCause: LlmFailureCause;
  readonly statusCode: number | undefined;

  constructor(failureCause: LlmFailureCause, message: string, options?: { statusCode?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "LlmError";
    this.failureCause = failureCause;
    this.statusCode = options?.statusCode;
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

function resolveModel(role: LlmRole, config: ModelConfig): LanguageModel {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmError("auth", "ANTHROPIC_API_KEY is not set. Put it in .env or export it.");
  }
  const anthropic = createAnthropic({ apiKey });
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
        ? ({ effort: config.responderEffort } satisfies AnthropicLanguageModelOptions)
        : {};

    const result = await generateText({
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
    });

    if (result.finishReason === "content-filter") {
      throw new LlmError("refusal", "The model declined the request (stop reason: refusal).");
    }

    const usage = result.totalUsage;
    const toolCalls: LlmToolCall[] = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({
        name: call.toolName,
        input: call.input,
        output: step.toolResults.find((toolResult) => toolResult.toolCallId === call.toolCallId)?.output,
      })),
    );

    return {
      output: result.output as T,
      usage: {
        inputTokens: usage.inputTokenDetails.noCacheTokens ?? usage.inputTokens ?? 0,
        cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? 0,
      },
      steps: result.steps.length,
      toolCalls,
      finishReason: result.finishReason,
      model: result.response.modelId,
      latencyMs: Date.now() - started,
      warnings: (result.warnings ?? []).map((warning) => JSON.stringify(warning)),
    };
  } catch (error) {
    throw classifyError(error);
  }
}
