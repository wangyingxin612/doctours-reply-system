// The eval set and its checker, checked without a model. A bad pattern or a misspelt reason code
// would otherwise only show up after a paid run.

import { describe, expect, it } from "vitest";
import { checkCase, type EvalCase, type Produced } from "../../eval/assert";
import { loadCases } from "../../eval/lib";
import { HANDOFF_SENTENCE, REASON_CODES } from "../../src/policy/escalation";
import type { Reply } from "../../src/schema/reply";

describe("eval cases", () => {
  const cases = loadCases();
  const custom = cases.filter((testCase) => testCase.source === "custom");

  it("load with a text each, the packet's five among them", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(cases.every((testCase) => testCase.text.trim().length > 0)).toBe(true);
    expect(cases.filter((testCase) => testCase.source === "packet")).toHaveLength(5);
  });

  it("use patterns that compile", () => {
    for (const testCase of cases) {
      for (const pattern of [...(testCase.expect.mustMatch ?? []), ...(testCase.expect.mustNotMatch ?? [])]) {
        expect(() => new RegExp(pattern, "i"), `${testCase.id}: /${pattern}/`).not.toThrow();
      }
    }
  });

  it("name only reason codes the escalation table has, and only on cases that escalate", () => {
    for (const testCase of cases) {
      const codes = [...(testCase.expect.reasonCode ? [testCase.expect.reasonCode] : []), ...(testCase.expect.reasonCodeIn ?? [])];
      for (const code of codes) expect(REASON_CODES as readonly string[], testCase.id).toContain(code);
      if (!testCase.expect.escalate) expect(codes, testCase.id).toEqual([]);
    }
  });

  it("ask for no wording and no link from an escalation, which is one fixed sentence", () => {
    for (const testCase of cases.filter((candidate) => candidate.expect.escalate)) {
      expect(testCase.expect.mustMatch ?? [], testCase.id).toEqual([]);
      expect(testCase.expect.urls ?? [], testCase.id).toEqual([]);
    }
  });

  it("pair boundary cases both ways, one on each side of the boundary", () => {
    const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
    const paired = cases.filter((testCase) => testCase.pairedWith !== undefined);
    expect(paired.length).toBeGreaterThanOrEqual(10);
    for (const testCase of paired) {
      const other = byId.get(testCase.pairedWith!);
      expect(other?.pairedWith, testCase.id).toBe(testCase.id);
      expect(other?.expect.escalate, testCase.id).toBe(!testCase.expect.escalate);
    }
  });

  it("keep about half of the custom cases on the escalation boundary, both sides alike", () => {
    const boundary = custom.filter((testCase) => testCase.tags.includes("boundary"));
    const escalating = boundary.filter((testCase) => testCase.expect.escalate).length;

    expect(boundary.length / custom.length).toBeGreaterThanOrEqual(0.4);
    expect(Math.abs(escalating - (boundary.length - escalating))).toBeLessThanOrEqual(2);
  });

  it("mark every holdout case by its id, so a tuning run cannot pick one up by accident", () => {
    for (const testCase of cases) expect(testCase.id.startsWith("h-"), testCase.id).toBe(testCase.split === "holdout");
  });
});

describe("checkCase", () => {
  const answered: Produced = { failure: null, decision: { reasonCode: null } };

  function reply(overrides: Partial<Reply> = {}): Reply {
    return {
      response: "Gold includes two nights at the hotel.",
      escalate: false,
      escalationReason: null,
      templateId: null,
      intent: "answer a package question",
      shouldFollowUp: false,
      followUpTiming: null,
      attachmentUrls: null,
      highEngagement: false,
      workingMemoryUpdates: null,
      ...overrides,
    };
  }

  function handoff(overrides: Partial<Reply> = {}): Reply {
    return reply({ response: HANDOFF_SENTENCE, escalate: true, escalationReason: "The patient asked for a person.", ...overrides });
  }

  function testCase(expect: EvalCase["expect"]): EvalCase {
    return { id: "case", source: "custom", split: "dev", tags: ["packages"], text: "What does Gold include?", expect };
  }

  const failuresOf = (expect: EvalCase["expect"], given: Reply, produced: Produced = answered) => checkCase(testCase(expect), given, produced).failures;

  it("passes a reply that meets the case", () => {
    const result = checkCase(testCase({ escalate: false, mustMatch: ["two nights"], mustNotMatch: ["\\$"], urls: [] }), reply(), answered);
    expect(result).toMatchObject({ passed: true, failures: [], expectedEscalate: false, actualEscalate: false });
  });

  it("fails the wrong side of escalate, and says which code or failure put it there", () => {
    expect(failuresOf({ escalate: false }, handoff(), { failure: null, decision: { reasonCode: "CALL_REQUEST" } })).toContain(
      "escalate is true, expected false (CALL_REQUEST)",
    );
    expect(failuresOf({ escalate: true }, reply())).toContain("escalate is false, expected true");
  });

  it("checks the reason code only when the case pins one", () => {
    const produced: Produced = { failure: null, decision: { reasonCode: "CALL_REQUEST" } };
    expect(failuresOf({ escalate: true }, handoff(), produced)).toEqual([]);
    expect(failuresOf({ escalate: true, reasonCode: "CALL_REQUEST" }, handoff(), produced)).toEqual([]);
    expect(failuresOf({ escalate: true, reasonCode: "HUMAN_REQUESTED" }, handoff(), produced)).toEqual([
      "reason code is CALL_REQUEST, expected HUMAN_REQUESTED",
    ]);
    expect(failuresOf({ escalate: true, reasonCodeIn: ["HUMAN_REQUESTED", "CALL_REQUEST"] }, handoff(), produced)).toEqual([]);
  });

  it("fails a case the pipeline failed on, even when escalate matches", () => {
    const produced: Produced = { failure: { cause: "transient_api", detail: "HTTP 529" }, decision: { reasonCode: "SYSTEM_FAILURE" } };
    expect(failuresOf({ escalate: true }, handoff(), produced)).toEqual(["pipeline failure: transient_api: HTTP 529"]);
  });

  it("compares the set of URLs exactly, and reads an empty list as no URL at all", () => {
    const withLink = reply({ response: "You can book a call here.\nhttps://example.com/book" });

    expect(failuresOf({ escalate: false, urls: ["https://example.com/book"] }, withLink)).toEqual([]);
    expect(failuresOf({ escalate: false, urls: [] }, withLink)).toEqual(["URLs are [https://example.com/book], expected []"]);
    expect(failuresOf({ escalate: false, urls: ["https://example.com/book"] }, reply())).toEqual([
      "URLs are [], expected [https://example.com/book]",
    ]);
    expect(failuresOf({ escalate: false }, withLink)).toEqual([]);
  });

  it("fails a URL that is not the last line, and markdown", () => {
    expect(failuresOf({ escalate: false }, reply({ response: "Book at https://example.com/book when you are ready." }))[0]).toMatch(/^url_last_line: /);
    expect(failuresOf({ escalate: false }, reply({ response: "Gold includes **two nights** at the hotel." }))[0]).toMatch(/^no_markdown: /);
  });

  it("holds an escalation to one short reply with a reason, no digits and no link", () => {
    expect(failuresOf({ escalate: true }, handoff())).toEqual([]);
    expect(failuresOf({ escalate: true }, handoff({ response: "I can't do that. I'm bringing in a person. They will call. Hold tight." }))).toEqual([
      "escalation reply has more than two sentences",
    ]);
    expect(failuresOf({ escalate: true }, handoff({ response: "A person will reply within 24 hours." }))).toEqual(["escalation reply contains digits"]);
    expect(failuresOf({ escalate: true }, handoff({ escalationReason: null }))).toEqual(["escalationReason is null on an escalation"]);
    expect(failuresOf({ escalate: false }, reply({ escalationReason: "left over" }))).toEqual([
      "escalationReason is set on a reply that does not escalate",
    ]);
  });
});
