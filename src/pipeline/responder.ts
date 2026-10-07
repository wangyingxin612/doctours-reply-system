// The responder: the main model writes the reply from the rules, facts and directives code chose.
// Code then checks the draft. One repair attempt, and if that fails the message goes to a person.

import { z } from "zod";
import type { ModelConfig } from "../../config/models";
import { patientContextBlock } from "../context/snapshot";
import type { PatientContext } from "../context/types";
import { callModel, type LlmDeps, type LlmResult, type LlmTool, type SystemBlock } from "../llm/client";
import { fillPrompt, loadPrompt } from "../prompts";
import {
  COMMUNICATION_STYLES,
  PAYMENT_METHODS,
  PROCEDURE_WINDOWS,
  type IncomingMessage,
  type Reply,
  type WorkingMemoryUpdates,
} from "../schema/reply";
import { renderSkillBody } from "../skills/loader";
import type { ExtraFact } from "../subtasks/callHistory";
import type { TurnLedger } from "../tools/ledger";
import { TOOL_REGISTRY, type ToolDefinition } from "../tools/registry";
import type { ModelStage } from "../trace/types";
import { blocking, runValidators, type ValidationContext } from "../validators";
import { ReplyRejectedError } from "./errors";
import type { Plan } from "./plan";
import type { TurnRecord } from "./run";

/** Model calls allowed in one attempt: at most two tool rounds, then the structured answer. */
const MAX_STEPS = 3;

// The model owns these memory fields. Code owns collectionState and escalationFlags.
const memoryUpdates = z.object({
  communicationStyle: z.enum(COMMUNICATION_STYLES).nullable(),
  keyConcerns: z.string().nullable(),
  patientName: z.string().nullable(),
  preferredPaymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  procedureArea: z.string().nullable(),
  promisesMade: z.string().nullable(),
  targetProcedureWindow: z.enum(PROCEDURE_WINDOWS).nullable(),
});

export const responderSchema = z.object({
  response: z.string(),
  intent: z.string(),
  shouldFollowUp: z.boolean(),
  followUpTiming: z.string().nullable(),
  highEngagement: z.boolean(),
  attachmentUrls: z.array(z.string()).nullable(),
  workingMemoryUpdates: memoryUpdates.nullable(),
  /** Trace only. Self-reported, so the report labels it a proxy. */
  coverage: z.enum(["all", "part", "none"]),
});

export type ResponderOutput = z.infer<typeof responderSchema>;

export interface ResponderInput {
  /** The patient's message, already redacted. */
  message: IncomingMessage;
  context: PatientContext;
  plan: Plan;
  ledger: TurnLedger;
  record: TurnRecord;
  config: ModelConfig;
  redactedTokens: readonly string[];
}

function factsBlock(ledger: TurnLedger, extraFacts: readonly ExtraFact[]): string {
  // A subtask's raw tool output stays out of the prompt. Its prepared fact goes in instead.
  const calls = ledger.calls.filter((call) => call.source !== "memory" && call.source !== "subtask");
  const lines = ["# FACTS FOR THIS MESSAGE", ""];
  if (calls.length === 0 && extraFacts.length === 0) {
    return [...lines, "No tool calls were made for this message."].join("\n");
  }

  lines.push("Results of tool calls made for this message.");
  for (const call of calls) {
    const saved = call.kind === "write" ? " (saved this turn)" : "";
    lines.push("", `## ${call.name}(${JSON.stringify(call.input)})${saved}`, JSON.stringify(call.output));
  }
  for (const fact of extraFacts) lines.push("", `## ${fact.title}`, fact.body);
  return lines.join("\n");
}

function directivesBlock(plan: Plan): string {
  return ["# DIRECTIVES FOR THIS MESSAGE", "", JSON.stringify(plan.directives, null, 2)].join("\n");
}

/** The parts of the input that decide what the model is shown. */
export type PromptInput = Pick<ResponderInput, "message" | "context" | "plan" | "ledger">;

/** Everything the responder is shown for one message. Exported so its size can be measured offline. */
export function renderResponderPrompt(input: PromptInput): { system: SystemBlock[]; prompt: string } {
  return { system: systemBlocks(input), prompt: userPrompt(input) };
}

/** Stable text first, so prompt caching can reuse it: rules, then skills, then the patient, then this turn. */
function systemBlocks(input: PromptInput): SystemBlock[] {
  const { plan, context, ledger } = input;

  const rules = [
    loadPrompt("responder-frame.md"),
    "# CORE RULES",
    renderSkillBody(plan.core, context),
    ...(plan.stage ? ["# STAGE RULES", renderSkillBody(plan.stage, context)] : []),
  ].join("\n\n");

  const skills =
    plan.selected.length === 0
      ? "# SKILLS FOR THIS MESSAGE\n\nNo skill was selected for this message."
      : [
          "# SKILLS FOR THIS MESSAGE",
          ...plan.selected.map((skill) => `## SKILL: ${skill.name}\n\n${renderSkillBody(skill, context)}`),
        ].join("\n\n");

  return [
    { text: rules, cache: true },
    { text: skills, cache: plan.selected.length > 0 },
    { text: patientContextBlock(context), cache: true },
    { text: `${factsBlock(ledger, plan.extraFacts)}\n\n${directivesBlock(plan)}` },
  ];
}

/** The packet's user-message template, unchanged. */
function userPrompt(input: PromptInput): string {
  return fillPrompt(loadPrompt("user-message.txt"), {
    HUMAN_MESSAGE: input.message.text,
    RECENT_CONVERSATION_SUMMARY: input.context.text.recentConversationSummary,
  });
}

function toolsFor(input: ResponderInput): Record<string, LlmTool> | undefined {
  if (input.plan.tools.length === 0) return undefined;
  return Object.fromEntries(
    input.plan.tools.map((name) => {
      const definition: ToolDefinition = TOOL_REGISTRY[name];
      const tool: LlmTool = {
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: (toolInput) => input.ledger.call(name, toolInput, "responder"),
      };
      return [name, tool];
    }),
  );
}

/** Keeps only memory fields the model set and that differ from what is already stored. */
function changedMemory(updates: ResponderOutput["workingMemoryUpdates"], context: PatientContext): WorkingMemoryUpdates | null {
  if (updates === null) return null;
  const stored = context.workingMemory as Record<string, unknown>;
  const changed = Object.entries(updates).filter(([key, value]) => value !== null && value !== stored[key]);
  return changed.length > 0 ? (Object.fromEntries(changed) as WorkingMemoryUpdates) : null;
}

/** Builds the reply from the model's fields. Code sets the fields the model has no say over. */
export function toReply(output: ResponderOutput, context: PatientContext): Reply {
  return {
    response: output.response.replace(/\r\n/g, "\n").trim(),
    escalate: false,
    escalationReason: null,
    templateId: null,
    intent: output.intent.trim(),
    shouldFollowUp: output.shouldFollowUp,
    followUpTiming: output.shouldFollowUp ? (output.followUpTiming?.trim() || null) : null,
    attachmentUrls: output.attachmentUrls && output.attachmentUrls.length > 0 ? output.attachmentUrls : null,
    highEngagement: output.highEngagement,
    workingMemoryUpdates: changedMemory(output.workingMemoryUpdates, context),
  };
}

function validationContext(input: ResponderInput): ValidationContext {
  const links = new Set(input.plan.directives.links.include);
  return {
    allowedUrls: links,
    requiredUrls: links,
    imageUrls: input.ledger.imageUrls(),
    money: input.ledger.money(),
    policyAmounts: input.plan.policyAmounts,
    patientText: input.message.text,
    redactedTokens: input.redactedTokens,
  };
}

function recordCall(record: TurnRecord, stage: ModelStage, result: LlmResult<unknown>): void {
  record.modelCalls.push({
    stage,
    model: result.model,
    ...result.usage,
    steps: result.steps,
    latencyMs: result.latencyMs,
  });
}

export async function runResponder(input: ResponderInput, deps: LlmDeps = {}): Promise<Reply> {
  const { record, context } = input;
  const llm = { config: input.config, ...deps };
  const prompt = userPrompt(input);
  const tools = toolsFor(input);

  const first = await callModel(
    { role: "responder", system: systemBlocks(input), prompt, schema: responderSchema, tools, maxSteps: tools ? MAX_STEPS : 1 },
    llm,
  );
  recordCall(record, "responder", first);

  let output = first.output;
  let reply = toReply(output, context);
  let violations = runValidators(reply, validationContext(input));
  record.validation.push({ attempt: 1, violations });

  if (blocking(violations).length > 0) {
    // A fresh single request, not a continuation: the rules, the facts (now with anything the first
    // attempt fetched), the draft and what was wrong with it.
    const repairPrompt = `${prompt}\n\n${fillPrompt(loadPrompt("repair.md"), {
      DRAFT: JSON.stringify(output, null, 2),
      PROBLEMS: blocking(violations)
        .map((violation) => `- ${violation.message}`)
        .join("\n"),
    })}`;
    const second = await callModel(
      { role: "responder", system: systemBlocks(input), prompt: repairPrompt, schema: responderSchema },
      llm,
    );
    recordCall(record, "repair", second);
    record.repairAttempts = 1;

    output = second.output;
    reply = toReply(output, context);
    violations = runValidators(reply, validationContext(input));
    record.validation.push({ attempt: 2, violations });

    if (blocking(violations).length > 0) throw new ReplyRejectedError(blocking(violations));
  }

  record.coverage = output.coverage;
  return reply;
}
