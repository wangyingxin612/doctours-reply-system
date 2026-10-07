// The original flow, as the packet's Flow section describes it: the whole system prompt on every
// message, every tool in the model's hands, and one Reply back. It exists only to be measured against.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ModelConfig } from "../../config/models";
import * as constants from "../../src/context/packet";
import { callModel, type LlmDeps, type LlmTool } from "../../src/llm/client";
import { isFatal, toFailure, toFatal } from "../../src/pipeline/errors";
import { fillPrompt, loadPrompt } from "../../src/prompts";
import {
  COLLECTION_ITEMS,
  COMMUNICATION_STYLES,
  PAYMENT_METHODS,
  PROCEDURE_WINDOWS,
  type Reply,
} from "../../src/schema/reply";
import { TurnLedger } from "../../src/tools/ledger";
import { TOOL_NAMES, TOOL_REGISTRY, type ToolDefinition } from "../../src/tools/registry";
import type { ModelCallTrace, ToolCallTrace } from "../../src/trace/types";
import { toModelCallTrace, toToolCallTraces } from "../../src/trace/write";
import { checkCase, type CaseResult, type EvalCase } from "../assert";
import type { LoadedCase, RunRecord } from "../lib";

/**
 * Model calls allowed for one message, counting the final answer. The pipeline's responder gets 3,
 * because code fetches its facts. Here the model has to fetch everything itself, so it gets room.
 */
export const ORIGINAL_MAX_STEPS = 10;

/** The packet's system prompt with every {{NAME}} replaced by the constant of the same name. */
export function originalSystemPrompt(): string {
  const lines = readFileSync(join(import.meta.dirname, "..", "..", "docs", "packet.md"), "utf8").split("\n");
  const heading = lines.indexOf("### System prompt");
  const open = lines.findIndex((line, index) => index > heading && line.startsWith("```"));
  const close = lines.findIndex((line, index) => index > open && line === "```");
  if (heading === -1 || open === -1 || close === -1) throw new Error("The packet has no system prompt block.");
  const template = lines.slice(open + 1, close).join("\n");

  const values = constants as unknown as Record<string, unknown>;
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The original prompt uses ${placeholder}, and no constant has that name.`);
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

/** The packet's user message for one patient message. */
export function originalUserMessage(text: string): string {
  return fillPrompt(loadPrompt("user-message.txt"), {
    HUMAN_MESSAGE: text,
    RECENT_CONVERSATION_SUMMARY: constants.RECENT_CONVERSATION_SUMMARY,
  });
}

// Memory fields are optional here and never null. The contract allows both, but the API accepts
// at most 16 nullable fields in one output schema, and the contract has more than that. A field
// left out means the same as null.
const memoryUpdates = z.object({
  collectionState: z
    .object({
      areaAskCount: z.number().optional(),
      lastAskedItem: z.enum(COLLECTION_ITEMS).optional(),
      nameAskCount: z.number().optional(),
      photoAskCount: z.number().optional(),
    })
    .optional(),
  communicationStyle: z.enum(COMMUNICATION_STYLES).optional(),
  escalationFlags: z.string().optional(),
  keyConcerns: z.string().optional(),
  patientName: z.string().optional(),
  preferredPaymentMethod: z.enum(PAYMENT_METHODS).optional(),
  procedureArea: z.string().optional(),
  promisesMade: z.string().optional(),
  targetProcedureWindow: z.enum(PROCEDURE_WINDOWS).optional(),
});

/**
 * The packet's Reply, minus templateId, which is always null. The field descriptions are the
 * packet's own notes on its output. They are all the original flow is told about escalation.
 */
export const originalReplySchema = z.object({
  response: z.string().describe("The reply, in plain text. If it includes a URL, that URL is the last line."),
  escalate: z.boolean().describe("True only when a person must take over."),
  escalationReason: z.string().nullable().describe("A short reason when escalate is true, and null otherwise."),
  intent: z.string(),
  shouldFollowUp: z.boolean(),
  followUpTiming: z.string().nullable(),
  attachmentUrls: z
    .array(z.string())
    .nullable()
    .describe("At most 3 URLs, and only URLs a tool returned on this turn."),
  highEngagement: z.boolean(),
  workingMemoryUpdates: memoryUpdates.nullable(),
});

export type OriginalReply = z.infer<typeof originalReplySchema>;

/** Every tool in the packet. The original flow has no code that decides which ones a message needs. */
function everyTool(ledger: TurnLedger): Record<string, LlmTool> {
  return Object.fromEntries(
    TOOL_NAMES.map((name) => {
      const definition: ToolDefinition = TOOL_REGISTRY[name];
      const tool: LlmTool = {
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: (input) => ledger.call(name, input, "responder"),
      };
      return [name, tool];
    }),
  );
}

export interface OriginalAnswer {
  reply: Reply;
  modelCall: ModelCallTrace;
  toolCalls: ToolCallTrace[];
}

/**
 * One message through the original flow. Same model and effort as the pipeline's responder, so a
 * difference in the results comes from the structure and not from the model.
 */
export async function answerWithOriginalPrompt(
  text: string,
  system: string,
  deps: LlmDeps & { config: ModelConfig },
): Promise<OriginalAnswer> {
  const ledger = new TurnLedger();
  const result = await callModel(
    {
      role: "responder",
      // The prompt is the same for every message, so it is cached. Cached input is billed at a tenth of the full rate.
      system: [{ text: system, cache: true }],
      prompt: originalUserMessage(text),
      schema: originalReplySchema,
      tools: everyTool(ledger),
      maxSteps: ORIGINAL_MAX_STEPS,
    },
    deps,
  );

  const { response, escalate, escalationReason, ...rest } = result.output;
  return {
    reply: { response: response.replace(/\r\n/g, "\n").trim(), escalate, escalationReason, templateId: null, ...rest },
    modelCall: toModelCallTrace("responder", result),
    toolCalls: toToolCallTraces(ledger.calls),
  };
}

/** What the run keeps for one case. Not a pipeline trace: there is no guard, router or policy to record. */
export interface BaselineRecord extends RunRecord {
  caseId: string;
  model: string;
  effort: string;
  /** Null when the model call failed. The original flow has nothing to fall back on. */
  reply: Reply | null;
  toolCalls: ToolCallTrace[];
  result: CaseResult;
}

/** The original prompt has no reason codes, so a case is checked on everything else. */
function withoutReasonCodes(testCase: EvalCase): EvalCase {
  const { reasonCode: _code, reasonCodeIn: _codes, ...expect } = testCase.expect;
  return { ...testCase, expect };
}

/** Runs one eval case through the original flow and checks the reply. A dead key or an empty account stops the run. */
export async function runBaselineCase(
  testCase: LoadedCase,
  system: string,
  deps: LlmDeps & { config: ModelConfig },
): Promise<BaselineRecord> {
  const started = Date.now();
  // The original flow has no repair step.
  const common = { caseId: testCase.id, model: deps.config.responderModel, effort: deps.config.responderEffort, repairAttempts: 0 };
  try {
    const answer = await answerWithOriginalPrompt(testCase.text, system, deps);
    return {
      ...common,
      reply: answer.reply,
      failure: null,
      toolCalls: answer.toolCalls,
      modelCalls: [answer.modelCall],
      latencyMs: Date.now() - started,
      result: checkCase(withoutReasonCodes(testCase), answer.reply, { failure: null, decision: { reasonCode: null } }),
    };
  } catch (error) {
    if (isFatal(error)) throw toFatal(error);
    const failure = toFailure(error);
    return {
      ...common,
      reply: null,
      failure,
      toolCalls: [],
      modelCalls: [],
      latencyMs: Date.now() - started,
      result: {
        id: testCase.id,
        tags: testCase.tags,
        passed: false,
        failures: [`no reply: ${failure.cause}: ${failure.detail}`],
        expectedEscalate: testCase.expect.escalate,
        actualEscalate: false,
      },
    };
  }
}
