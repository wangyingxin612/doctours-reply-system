// One message through the pipeline. Code decides; a model only writes when code lets the message through.

import type { ModelConfig } from "../../config/models";
import type { PatientContext } from "../context/types";
import { decideFromGuard, systemFailureDecision, type EscalationDecision } from "../policy/decide";
import { buildEscalationReply } from "../policy/escalation";
import type { IncomingMessage, Reply } from "../schema/reply";
import { TurnLedger } from "../tools/ledger";
import type { Coverage, FailureCause, ModelCallTrace, Trace, TraceEvent, ValidationTrace } from "../trace/types";
import { toToolCallTraces } from "../trace/write";
import { noCardEcho } from "../validators/noCardEcho";
import { shape } from "../validators/shape";
import { EMPTY_VALIDATION_CONTEXT } from "../validators/types";
import { isFatal, toFailure, toFatal } from "./errors";
import { runGuard, type GuardResult, type Redaction, type RedactionType } from "./guard";

/** What the model stages add to the trace while they work. */
export interface TurnRecord {
  router: unknown;
  primaryIntent: string | null;
  skillsLoaded: string[];
  events: TraceEvent[];
  directives: unknown;
  precedence: unknown[];
  validation: ValidationTrace[];
  repairAttempts: number;
  coverage: Coverage | null;
  modelCalls: ModelCallTrace[];
}

export interface AnswerInput {
  /** The message with card data already removed. No later stage sees the original text. */
  message: IncomingMessage;
  guard: GuardResult;
  ledger: TurnLedger;
  record: TurnRecord;
  context: PatientContext;
  config: ModelConfig;
}

export interface AnswerOutput {
  reply: Reply;
  decision: EscalationDecision;
}

/** Router, planner and responder. Handles every message the guard did not decide. */
export type AnswerStage = (input: AnswerInput) => Promise<AnswerOutput>;

export interface PipelineDeps {
  context: PatientContext;
  config: ModelConfig;
  policyVersion: string;
  answer?: AnswerStage;
}

export interface MessageResult {
  reply: Reply;
  trace: Trace;
}

interface Failure {
  cause: FailureCause;
  detail: string;
}

interface Outcome extends AnswerOutput {
  failure: Failure | null;
}

function newTurnRecord(): TurnRecord {
  return {
    router: null,
    primaryIntent: null,
    skillsLoaded: [],
    events: [],
    directives: null,
    precedence: [],
    validation: [],
    repairAttempts: 0,
    coverage: null,
    modelCalls: [],
  };
}

function countRedactions(redactions: readonly Redaction[]): Array<{ type: RedactionType; count: number }> {
  const counts = new Map<RedactionType, number>();
  for (const { type } of redactions) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count }));
}

/** Never ship an unverified reply: a failure hands the message to a person. */
function failOver(failure: Failure): Outcome {
  return { reply: buildEscalationReply("SYSTEM_FAILURE"), decision: systemFailureDecision(), failure };
}

async function decideAndAnswer(input: AnswerInput, answer: AnswerStage | undefined): Promise<Outcome> {
  if (input.guard.hits.length > 0) {
    // Decided without a model: no router call, no prefetch, no side effects.
    const decision = decideFromGuard(input.guard.hits);
    return { reply: buildEscalationReply(decision.reasonCode ?? "SYSTEM_FAILURE"), decision, failure: null };
  }
  try {
    if (!answer) throw new Error("No answer stage is wired into the pipeline.");
    return { ...(await answer(input)), failure: null };
  } catch (error) {
    // A missing or rejected key stops the run. Escalating every message would hide the real problem.
    if (isFatal(error)) throw toFatal(error);
    return failOver(toFailure(error));
  }
}

export async function runMessage(
  message: IncomingMessage,
  index: number,
  runId: string,
  deps: PipelineDeps,
): Promise<MessageResult> {
  const started = Date.now();
  const guard = runGuard(message.text);
  const ledger = new TurnLedger();
  const record = newTurnRecord();

  let outcome = await decideAndAnswer(
    {
      message: { id: message.id, text: guard.redactedText },
      guard,
      ledger,
      record,
      context: deps.context,
      config: deps.config,
    },
    deps.answer,
  );

  // Last check on whatever is about to ship, escalations included: the contract holds and no card data leaks.
  const finalContext = { ...EMPTY_VALIDATION_CONTEXT, redactedTokens: guard.redactions.map(({ token }) => token) };
  const violations = [...shape(outcome.reply, finalContext), ...noCardEcho(outcome.reply, finalContext)];
  if (violations.length > 0) {
    record.validation.push({ attempt: record.validation.length + 1, violations });
    outcome = failOver({ cause: "validator", detail: violations.map((violation) => violation.message).join(" ") });
  }

  const { reply, decision, failure } = outcome;
  if (reply.workingMemoryUpdates) {
    ledger.call("updateWorkingMemoryTool", { memory: reply.workingMemoryUpdates }, "memory");
  }

  const trace: Trace = {
    runId,
    index,
    messageId: message.id,
    policyVersion: deps.policyVersion,
    models: {
      router: deps.config.routerModel,
      responder: deps.config.responderModel,
      responderEffort: deps.config.responderEffort,
    },
    message: { redactedText: guard.redactedText, redactions: countRedactions(guard.redactions) },
    guard: { hits: guard.hits },
    router: record.router,
    primaryIntent: record.primaryIntent,
    skillsLoaded: record.skillsLoaded,
    toolCalls: toToolCallTraces(ledger.calls),
    events: record.events,
    directives: record.directives,
    precedence: record.precedence,
    validation: record.validation,
    repairAttempts: record.repairAttempts,
    decision,
    failure,
    coverage: record.coverage,
    modelCalls: record.modelCalls,
    latencyMs: Date.now() - started,
    reply,
  };

  return { reply, trace };
}
