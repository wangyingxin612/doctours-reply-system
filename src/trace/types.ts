// One trace per message. It records what was decided, by which part, and at what cost,
// so a wrong reply or a change in the escalation rate can be explained from data.

import type { GuardHit, RedactionType } from "../pipeline/guard";
import type { EscalationDecision } from "../policy/decide";
import type { Reply } from "../schema/reply";
import type { CallSource } from "../tools/ledger";
import type { ToolKind } from "../tools/registry";
import type { Violation } from "../validators/types";

/**
 * transient_api: 429, 5xx, overloaded or network, after retries ran out. Not a policy problem.
 * model_error: any other API failure.
 * refusal: the model's safety classifiers declined.
 * invalid_output: the model's reply did not match the schema.
 * validator: the reply still broke a rule after one repair.
 * internal_error: a bug or bad input on our side.
 */
export type FailureCause =
  | "transient_api"
  | "model_error"
  | "refusal"
  | "invalid_output"
  | "validator"
  | "internal_error";

export type ModelStage = "router" | "responder" | "repair" | "subtask";

export interface ModelCallTrace {
  stage: ModelStage;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  steps: number;
  /** Includes the time spent waiting between retries. */
  latencyMs: number;
  /** HTTP status of each attempt that failed and was retried. 0 means no response. Absent when none failed. */
  failedAttempts?: number[];
}

export interface ToolCallTrace {
  name: string;
  kind: ToolKind;
  source: CallSource;
  input: unknown;
  /** A short description of the result, not the full payload. */
  result: string;
}

export interface TraceEvent {
  type: string;
  detail?: unknown;
}

export interface ValidationTrace {
  attempt: number;
  violations: Violation[];
}

export type Coverage = "all" | "part" | "none";

export interface Trace {
  runId: string;
  index: number;
  messageId: string;
  /** Hash of the policy tables, skills and prompts. A change in behavior can be tied to a change here. */
  policyVersion: string;
  models: { router: string; responder: string; responderEffort: string };
  message: {
    redactedText: string;
    /** Type and count only. The removed card data is never written to disk. */
    redactions: Array<{ type: RedactionType; count: number }>;
  };
  guard: { hits: GuardHit[] };
  router: unknown;
  /** One label per message, so an intent mix-versus-rate split counts each message once. */
  primaryIntent: string | null;
  skillsLoaded: string[];
  toolCalls: ToolCallTrace[];
  events: TraceEvent[];
  directives: unknown;
  precedence: unknown[];
  validation: ValidationTrace[];
  repairAttempts: number;
  decision: EscalationDecision;
  failure: { cause: FailureCause; detail: string } | null;
  /** Self-reported by the responder: how much of the question it answered. A proxy, not a measurement. */
  coverage: Coverage | null;
  modelCalls: ModelCallTrace[];
  latencyMs: number;
  reply: Reply;
}
