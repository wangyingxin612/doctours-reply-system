// Checks one reply against one eval case. Facts and rules are checked, never wording.
// A text check is a regular expression, so it can test where a thing is said and what must not be
// said near it. It cannot test what a sentence means. test/eval/textChecks.test.ts runs the checks
// of the cases that lean on them against replies known to be good and replies known to be bad.

import { z } from "zod";
import { replySchema, type Reply } from "../src/schema/reply";
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
    /**
     * Regular expressions, case-insensitive. Every one must match the first sentence of the response.
     * For a rule that says what comes first, such as "the no first, then what we do offer".
     */
    firstSentenceMatch: z.array(z.string()).optional(),
    /**
     * No sentence that matches `about` may also match `pattern`. For a word that is wrong only in
     * one context, such as "might" in a sentence about insurance.
     */
    mustNotMatchInSentence: z.array(z.strictObject({ about: z.string(), pattern: z.string() })).optional(),
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

/**
 * Words that belong to the system and not to a coordinator, such as "the tool shows". The pipeline
 * has a validator for this. The check here is separate and broader on purpose: it does not depend
 * on that validator, it also runs on replies no validator saw, and a false alarm in the eval costs
 * a look, not a reply.
 */
const MACHINERY_TALK = /\b(?:tools?|database|system prompt|my data|the data I have)\b/i;

/** A curly apostrophe means the same as a straight one. Patterns are written with the straight one. */
function straightApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC]/g, "'");
}

/** Words that end in a period without ending a sentence. "Dr." is in most replies here. */
const ABBREVIATION = /\b(?:Dr|Mr|Mrs|Ms|Prof|vs|e\.g|i\.e|U\.S)\.$/i;

/** The sentences of a reply. A line break ends a sentence. A period after "Dr" does not. */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\n+/)) {
    let current = "";
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      current = current === "" ? piece : `${current} ${piece}`;
      if (ABBREVIATION.test(current)) continue;
      sentences.push(current.trim());
      current = "";
    }
    sentences.push(current.trim());
  }
  return sentences.filter((sentence) => sentence !== "");
}

function sentenceCount(text: string): number {
  return sentencesOf(text).length;
}

/** What a check reads about how a reply was produced. A pipeline trace has both fields. */
export interface Produced {
  failure: { cause: string; detail: string } | null;
  decision: { reasonCode: string | null };
}

export function checkCase(testCase: EvalCase, reply: Reply, trace: Produced): CaseResult {
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

  const text = straightApostrophes(response);
  const sentences = sentencesOf(text);
  const matches = (pattern: string, subject: string) => new RegExp(pattern, "i").test(subject);

  for (const pattern of expect.firstSentenceMatch ?? []) {
    if (!matches(pattern, sentences[0] ?? "")) failures.push(`first sentence is missing: /${pattern}/`);
  }
  for (const pattern of expect.mustMatch ?? []) {
    if (!matches(pattern, text)) failures.push(`missing: /${pattern}/`);
  }
  for (const pattern of expect.mustNotMatch ?? []) {
    if (matches(pattern, text)) failures.push(`must not appear: /${pattern}/`);
  }
  for (const { about, pattern } of expect.mustNotMatchInSentence ?? []) {
    if (sentences.some((sentence) => matches(about, sentence) && matches(pattern, sentence))) {
      failures.push(`must not appear in a sentence about /${about}/: /${pattern}/`);
    }
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

  const machinery = MACHINERY_TALK.exec(response);
  if (machinery) failures.push(`talks about the machinery: "${machinery[0]}"`);

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
