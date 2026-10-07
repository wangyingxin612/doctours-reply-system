// A batch of messages: bounded concurrency, input order kept, one bad message never sinks the run.

import { systemFailureDecision } from "../policy/decide";
import { buildEscalationReply } from "../policy/escalation";
import { incomingMessageSchema, type Reply } from "../schema/reply";
import type { Trace } from "../trace/types";
import { writeTrace } from "../trace/write";
import { runMessage, type MessageResult, type PipelineDeps } from "./run";

export const DEFAULT_CONCURRENCY = 4;

/** Runs `work` over `items` with at most `limit` in flight. Results keep the input order. */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index] as Item, index);
      } catch (error) {
        // Only fatal errors reach here. Stop handing out work and fail the run.
        failed = true;
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

export interface BatchOptions {
  runId: string;
  concurrency: number;
  /** Directory for this run's traces. Null writes none. */
  traceDir: string | null;
  deps: PipelineDeps;
}

export interface BatchResult {
  replies: Reply[];
  traces: Trace[];
}

/** An input item that is not `{ id, text }` still gets a reply, so output positions match input positions. */
function rejectInput(item: unknown, index: number, runId: string, deps: PipelineDeps): MessageResult {
  const id = typeof item === "object" && item !== null && "id" in item ? String(item.id) : `item-${index}`;
  const reply = buildEscalationReply("SYSTEM_FAILURE");
  return {
    reply,
    trace: {
      runId,
      index,
      messageId: id,
      policyVersion: deps.policyVersion,
      models: {
        router: deps.config.routerModel,
        responder: deps.config.responderModel,
        responderEffort: deps.config.responderEffort,
      },
      message: { redactedText: "", redactions: [] },
      guard: { hits: [] },
      router: null,
      primaryIntent: null,
      skillsLoaded: [],
      toolCalls: [],
      events: [],
      directives: null,
      precedence: [],
      validation: [],
      repairAttempts: 0,
      decision: systemFailureDecision(),
      failure: { cause: "internal_error", detail: "Input item is not an object with string fields id and text." },
      coverage: null,
      modelCalls: [],
      latencyMs: 0,
      reply,
    },
  };
}

export async function respondToMessages(items: readonly unknown[], options: BatchOptions): Promise<BatchResult> {
  const results = await mapWithConcurrency(items, options.concurrency, async (item, index) => {
    const parsed = incomingMessageSchema.safeParse(item);
    const result = parsed.success
      ? await runMessage(parsed.data, index, options.runId, options.deps)
      : rejectInput(item, index, options.runId, options.deps);
    if (options.traceDir) writeTrace(options.traceDir, result.trace);
    return result;
  });

  return { replies: results.map((result) => result.reply), traces: results.map((result) => result.trace) };
}
