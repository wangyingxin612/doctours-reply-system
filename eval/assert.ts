// Checks one reply against one eval case. Facts and rules are checked, never wording.

import { z } from "zod";
import { replySchema, type Reply } from "../src/schema/reply";
import type { Trace } from "../src/trace/types";
import { noMarkdown } from "../src/validators/noMarkdown";
import { extractUrls } from "../src/validators/text";
import { EMPTY_VALIDATION_CONTEXT } from "../src/validators/types";
import { urlLastLine } from "../src/validators/urlLastLine";

export const caseSchema = z.strictObject({
  id: z.string(),
  /** "packet" cases take their text from eval/packet/messages.json. */
  source: z.enum(["packet", "custom"]),
  /** Tune on dev only. Report holdout. */
  split: z.enum(["dev", "holdout"]),
  /** Behaviors this case exercises. Results are grouped by tag. */
  tags: z.array(z.string()).min(1),
  text: z.string().optional(),
  /** For a boundary pair: the id of the case on the other side of the boundary. */
  pairedWith: z.string().optional(),
  note: z.string().optional(),
  expect: z.strictObject({
    escalate: z.boolean(),
    /** The primary reason code, when the case pins it. */
    reasonCode: z.string().optional(),
    /** Use instead of reasonCode when more than one code is a correct reading of the message. */
    reasonCodeIn: z.array(z.string()).optional(),
    shouldFollowUp: z.boolean().optional(),
    /** Regular expressions, case-insensitive. Every one must match the response. */
    mustMatch: z.array(z.string()).optional(),
    /** Regular expressions, case-insensitive. None may match the response. */
    mustNotMatch: z.array(z.string()).optional(),
    /** The exact set of URLs the response must contain. An empty list means no URL at all. */
    urls: z.array(z.string()).optional(),
  }),
});

export type EvalCase = z.infer<typeof caseSchema>;

export interface CaseResult {
  id: string;
  tags: string[];
  passed: boolean;
  failures: string[];
  expectedEscalate: boolean;
  actualEscalate: boolean;
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

export function checkCase(testCase: EvalCase, reply: Reply, trace: Trace): CaseResult {
  const failures: string[] = [];
  const { expect } = testCase;
  const { response } = reply;

  if (!replySchema.safeParse(reply).success) failures.push("reply does not match the Reply schema");

  if (reply.escalate !== expect.escalate) {
    const why = trace.failure ? ` (failure: ${trace.failure.cause})` : trace.decision.reasonCode ? ` (${trace.decision.reasonCode})` : "";
    failures.push(`escalate is ${reply.escalate}, expected ${expect.escalate}${why}`);
  }
  if (expect.reasonCode !== undefined && trace.decision.reasonCode !== expect.reasonCode) {
    failures.push(`reason code is ${trace.decision.reasonCode}, expected ${expect.reasonCode}`);
  }
  if (expect.reasonCodeIn !== undefined && !expect.reasonCodeIn.includes(trace.decision.reasonCode ?? "")) {
    failures.push(`reason code is ${trace.decision.reasonCode}, expected one of ${expect.reasonCodeIn.join(", ")}`);
  }
  if (expect.shouldFollowUp !== undefined && reply.shouldFollowUp !== expect.shouldFollowUp) {
    failures.push(`shouldFollowUp is ${reply.shouldFollowUp}, expected ${expect.shouldFollowUp}`);
  }
  // A failure that happens to land on the expected side of escalate is still a failure of the system.
  if (trace.failure !== null) failures.push(`pipeline failure: ${trace.failure.cause}: ${trace.failure.detail}`);

  for (const pattern of expect.mustMatch ?? []) {
    if (!new RegExp(pattern, "i").test(response)) failures.push(`missing: /${pattern}/`);
  }
  for (const pattern of expect.mustNotMatch ?? []) {
    if (new RegExp(pattern, "i").test(response)) failures.push(`must not appear: /${pattern}/`);
  }

  if (expect.urls !== undefined) {
    const actual = [...new Set(extractUrls(response))].sort();
    const wanted = [...expect.urls].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      failures.push(`URLs are [${actual.join(", ")}], expected [${wanted.join(", ")}]`);
    }
  }

  for (const violation of [...urlLastLine(reply, EMPTY_VALIDATION_CONTEXT), ...noMarkdown(reply, EMPTY_VALIDATION_CONTEXT)]) {
    failures.push(`${violation.validator}: ${violation.message}`);
  }

  if (reply.escalate) {
    // The packet: one short sentence, optionally after one short decline, and then stop.
    if (sentenceCount(response) > 2) failures.push("escalation reply has more than two sentences");
    if (/\d/.test(response)) failures.push("escalation reply contains digits");
    if (extractUrls(response).length > 0) failures.push("escalation reply contains a URL");
    if (reply.escalationReason === null) failures.push("escalationReason is null on an escalation");
  } else if (reply.escalationReason !== null) {
    failures.push("escalationReason is set on a reply that does not escalate");
  }

  return {
    id: testCase.id,
    tags: testCase.tags,
    passed: failures.length === 0,
    failures,
    expectedEscalate: expect.escalate,
    actualEscalate: reply.escalate,
  };
}
