// A subtask: read the call records so the responder does not have to.
// Short records go to the responder as they are. Long ones are first reduced, by the small model,
// to the findings that bear on the patient's message. Either way the responder gets one compact fact.

import { z } from "zod";
import type { ModelConfig } from "../../config/models";
import type { PatientContext } from "../context/types";
import { callModel, type LlmDeps } from "../llm/client";
import { loadPrompt } from "../prompts";
import type { TurnLedger } from "../tools/ledger";
import type { ModelCallTrace } from "../trace/types";

/** Below this many characters of call text, extraction would cost more than it saves. */
export const DIRECT_LIMIT_CHARS = 4000;

export interface ExtraFact {
  title: string;
  body: string;
}

export interface CallHistoryInput {
  /** The patient's message, already redacted. */
  question: string;
  context: PatientContext;
  ledger: TurnLedger;
  config: ModelConfig;
}

export interface CallHistoryResult {
  fact: ExtraFact;
  /** Set when the small model did the reading. */
  call: ModelCallTrace | null;
}

const findingsSchema = z.object({ findings: z.array(z.string()) });

interface CallRecord {
  summary?: string | null;
  transcript?: string | null;
}

export async function readCallHistory(
  input: CallHistoryInput,
  deps: LlmDeps = {},
  directLimit: number = DIRECT_LIMIT_CHARS,
): Promise<CallHistoryResult> {
  const result = input.ledger.call("getFullCallsTool", { chatId: input.context.chatId }, "subtask") as {
    calls?: CallRecord[];
  } | null;
  const calls = result?.calls ?? [];
  const size = calls.reduce((total, call) => total + (call.summary?.length ?? 0) + (call.transcript?.length ?? 0), 0);

  if (size <= directLimit) {
    return { fact: { title: "Call records (getFullCallsTool)", body: JSON.stringify(result) }, call: null };
  }

  const extracted = await callModel(
    {
      role: "router",
      system: [{ text: loadPrompt("call-history.md") }],
      prompt: `# Patient message\n"${input.question}"\n\n# Call records\n${JSON.stringify(calls)}`,
      schema: findingsSchema,
    },
    { config: input.config, ...deps },
  );

  const { findings } = extracted.output;
  return {
    fact: {
      title: `Findings from ${calls.length} call records, extracted for this message`,
      body: findings.length > 0 ? findings.map((finding) => `- ${finding}`).join("\n") : "Nothing in the call records bears on this message.",
    },
    call: {
      stage: "subtask",
      model: extracted.model,
      ...extracted.usage,
      steps: extracted.steps,
      latencyMs: extracted.latencyMs,
    },
  };
}
