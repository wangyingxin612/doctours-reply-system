// The eval's text checks, run on fixed strings. No model is called.
// A check that passes a wrong reply, or fails a right one, makes the eval's score mean less, so the
// checks that carry a rule get tests of their own. Each case is read from eval/cases.json, so these
// tests fail if its checks are loosened. "Real" replies are copied from past runs. The others are
// written to break, or to keep, the one rule the case is about.

import { describe, expect, it } from "vitest";
import { checkCase, sentencesOf, type Produced } from "../../eval/assert";
import { loadCases, type LoadedCase } from "../../eval/lib";
import type { Reply } from "../../src/schema/reply";

const cases = loadCases();
const answered: Produced = { failure: null, decision: { reasonCode: null } };

function caseOf(id: string): LoadedCase {
  const testCase = cases.find((candidate) => candidate.id === id);
  if (!testCase) throw new Error(`no eval case ${id}`);
  return testCase;
}

function failuresOf(id: string, response: string): string[] {
  const reply: Reply = {
    response,
    escalate: false,
    escalationReason: null,
    templateId: null,
    intent: "answer",
    shouldFollowUp: false,
    followUpTiming: null,
    attachmentUrls: null,
    highEngagement: false,
    workingMemoryUpdates: null,
  };
  return checkCase(caseOf(id), reply, answered).failures;
}

/** The failure messages a case's own checks produce, so a test names a check without copying its pattern. */
function messagesOf(id: string) {
  const { expect: checks } = caseOf(id);
  const [negation, subject] = checks.firstSentenceMatch ?? [];
  const [financing, layaway] = checks.mustMatch ?? [];
  const [scoped] = checks.mustNotMatchInSentence ?? [];
  return {
    noFirstMissing: `first sentence is missing: /${negation}/`,
    subjectFirstMissing: `first sentence is missing: /${subject}/`,
    financingMissing: `missing: /${financing}/`,
    layawayMissing: `missing: /${layaway}/`,
    forbidden: (pattern: string) => `must not appear: /${(checks.mustNotMatch ?? []).find((candidate) => candidate === pattern)}/`,
    hedge: `must not appear in a sentence about /${scoped?.about}/: /${scoped?.pattern}/`,
  };
}

describe("sentences", () => {
  it("does not end a sentence at the period in Dr.", () => {
    expect(sentencesOf("Dr. Hakan Clinic has one package. It costs $3,200.")).toEqual(["Dr. Hakan Clinic has one package.", "It costs $3,200."]);
  });

  it("keeps a one-word answer as a sentence of its own", () => {
    expect(sentencesOf("No. Once your flights are booked, that option ends.")).toEqual(["No.", "Once your flights are booked, that option ends."]);
  });

  it("ends a sentence at a line break, and leaves a URL and a decimal whole", () => {
    expect(sentencesOf("It is $3,200.50 in total. You can book here.\nhttps://www.doctours.com/consultation")).toEqual([
      "It is $3,200.50 in total.",
      "You can book here.",
      "https://www.doctours.com/consultation",
    ]);
  });

  it("splits at question and exclamation marks", () => {
    expect(sentencesOf("Is it free? Yes! It is.")).toEqual(["Is it free?", "Yes!", "It is."]);
  });
});

describe("medicaid: the no first, then financing and layaway, and no hedge", () => {
  const messages = messagesOf("medicaid");
  // The reply from the last run of this case. An earlier check failed it for saying "insurers" and not "insurance".
  const LAST_RUN =
    "Unfortunately you can't use Medicaid for a hair transplant. It's cash-pay, and we don't bill insurers or file claims. We do offer financing and layaway options though. Klarna or PayPal can cover the remaining balance after the deposit, or there's interest-free layaway.";

  it.each([
    LAST_RUN,
    "Unfortunately you can't use Medicaid, or any health insurance, for a hair transplant. It's cash-pay through Doctours. We do offer financing and layaway options though: Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway. I'm not able to submit anything to Medicaid or an insurer on your behalf.",
    "Unfortunately you can't use Medicaid or any other health insurance for a hair transplant. It's cash-pay through Doctours. We do offer financing and layaway options though: Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway. Klarna or PayPal approval is up to the lender, and they show your exact terms at checkout.",
    "Unfortunately you can't use Medicaid or any other health insurance for a hair transplant. It's cash-pay through Doctours. We do offer financing and layaway options though — Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway.",
    "Unfortunately you can't use Medicaid, or any health insurance, for a hair transplant. We do offer financing and layaway options though. Klarna or PayPal can cover the remaining balance after the deposit, or there's interest-free layaway.",
    // The three replies from the run made after the checks were rewritten.
    "Unfortunately you can't use Medicaid or any other health insurance for a hair transplant. It's cash-pay through Doctours. We do offer financing and layaway options though. Klarna or PayPal can cover the remaining balance after the deposit, or you can use interest-free layaway. Klarna and PayPal show your exact terms at checkout, and the lender approves each application.",
    "Unfortunately you can't use Medicaid or any other health insurance for a hair transplant. The procedure is cash-pay through Doctours. We do offer financing and layaway options though. Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway.",
    "Unfortunately you can't use Medicaid for a hair transplant. It's cash-pay, and that goes for any health insurance. We do offer financing and layaway options though. Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway. I also can't submit anything to an insurer.",
  ])("passes a real reply: %s", (response) => {
    expect(failuresOf("medicaid", response)).toEqual([]);
  });

  it("reads a curly apostrophe as a straight one", () => {
    expect(failuresOf("medicaid", LAST_RUN.replaceAll("'", "’"))).toEqual([]);
  });

  it("does not mind \"file claims\" in a sentence that says we do not", () => {
    expect(LAST_RUN).toContain("file claims");
    expect(failuresOf("medicaid", LAST_RUN)).toEqual([]);
  });

  it("fails a reply that holds out reimbursement", () => {
    expect(failuresOf("medicaid", "We don't bill Medicaid directly, but you may be able to get reimbursed after you pay.")).toEqual([
      messages.financingMissing,
      messages.layawayMissing,
      messages.forbidden("reimburs"),
      messages.hedge,
    ]);
  });

  it("fails it for the reimbursement and the hedge alone when the offer is there", () => {
    // The check this one replaced passed this reply: it has "don't bill" and "financing".
    const response =
      "We don't bill Medicaid directly, but you may be able to get reimbursed after you pay. We offer Klarna or PayPal financing and interest-free layaway.";
    expect(failuresOf("medicaid", response)).toEqual([messages.forbidden("reimburs"), messages.hedge]);
  });

  it("fails a reply that says it depends on the plan", () => {
    expect(failuresOf("medicaid", "It depends on your plan. Some plans cover hair transplants.")).toEqual([
      messages.noFirstMissing,
      messages.subjectFirstMissing,
      messages.financingMissing,
      messages.layawayMissing,
      messages.forbidden("depends on (your|the) plan"),
    ]);
  });

  it("fails a reply that gives the no second", () => {
    expect(failuresOf("medicaid", "We offer financing and layaway. Medicaid isn't accepted.")).toEqual([messages.noFirstMissing, messages.subjectFirstMissing]);
  });

  it("fails a reply that offers layaway and no financing", () => {
    expect(failuresOf("medicaid", "Unfortunately you can't use Medicaid for a hair transplant. We offer layaway.")).toEqual([messages.financingMissing]);
  });

  it("fails a hedge in a sentence about insurance, and allows the same word elsewhere", () => {
    const offer = "We do offer Klarna or PayPal financing and interest-free layaway.";
    expect(failuresOf("medicaid", `Unfortunately Medicaid can't be used, though some insurers might cover part of it. ${offer}`)).toEqual([messages.hedge]);
    expect(failuresOf("medicaid", `Unfortunately you can't use Medicaid for a hair transplant. ${offer} You could start layaway whenever you like.`)).toEqual([]);
  });

  it.each(["That is not medically necessary care, so Medicaid can't be billed.", "I can't send a superbill for Medicaid."])(
    "fails the other things the rule rules out: %s",
    (opening) => {
      const failures = failuresOf("medicaid", `${opening} We do offer Klarna or PayPal financing and interest-free layaway.`);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/^must not appear: /);
    },
  );
});

describe("carecredit: the no first, then our own financing and layaway, and no hedge", () => {
  const messages = messagesOf("carecredit");
  const OFFER = "Klarna or PayPal can finance the remaining balance after the deposit, and there's interest-free layaway.";

  it.each([
    "Unfortunately we don't accept CareCredit. We do offer our own financing and layaway options though — Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway.",
    "Unfortunately we don't accept CareCredit. We do offer our own financing and layaway options though. Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway.",
    "Unfortunately we don't accept CareCredit. We do offer our own financing and layaway options though — Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway. Klarna or PayPal show your exact terms at checkout, and approval is up to the lender.",
  ])("passes a real reply: %s", (response) => {
    expect(failuresOf("carecredit", response)).toEqual([]);
  });

  it.each([
    // The check this one replaced wanted the words "don't accept CareCredit" and failed both of these.
    `We can't take CareCredit, unfortunately. ${OFFER}`,
    "Care Credit isn't something we accept. We do have our own financing and layaway: Klarna or PayPal for the remaining balance, or interest-free layaway.",
  ])("passes a right answer in other words: %s", (response) => {
    expect(failuresOf("carecredit", response)).toEqual([]);
  });

  it("fails a reply that stops at the no", () => {
    expect(failuresOf("carecredit", "Unfortunately we don't accept CareCredit.")).toEqual([messages.financingMissing, messages.layawayMissing]);
  });

  it("fails a reply that offers layaway and no financing", () => {
    // The check this one replaced passed this reply: it accepted financing or layaway.
    expect(failuresOf("carecredit", "Unfortunately we don't accept CareCredit. We offer interest-free layaway.")).toEqual([messages.financingMissing]);
  });

  it("does not take \"CareCredit financing\" for an offer of ours", () => {
    expect(failuresOf("carecredit", "Unfortunately we don't accept CareCredit financing. We offer interest-free layaway.")).toEqual([messages.financingMissing]);
  });

  it("fails a reply that says yes if the clinic is a provider", () => {
    expect(failuresOf("carecredit", "You can put it on CareCredit if the clinic is a provider.")).toEqual([
      messages.noFirstMissing,
      messages.financingMissing,
      messages.layawayMissing,
      messages.forbidden("if the clinic"),
    ]);
  });

  it("fails a reply that opens with how checkout works and gives the no second", () => {
    const response = "Checkout collects the deposit first, then Klarna or PayPal can finance the remaining balance. We don't accept CareCredit, but interest-free layaway is available.";
    expect(failuresOf("carecredit", response)).toEqual([messages.noFirstMissing, messages.subjectFirstMissing]);
  });

  it("fails a hedge about CareCredit", () => {
    expect(failuresOf("carecredit", `We don't take CareCredit ourselves, but some of our partner clinics might take CareCredit. ${OFFER}`)).toEqual([messages.hedge]);
  });
});

describe("h-cherry: the same rule, for Cherry", () => {
  const messages = messagesOf("h-cherry");

  it("passes the real reply", () => {
    const response =
      "Unfortunately we don't accept Cherry. We do offer our own financing and layaway options though — Klarna or PayPal for the remaining balance after the deposit, or interest-free layaway.";
    expect(failuresOf("h-cherry", response)).toEqual([]);
  });

  it("fails a yes", () => {
    expect(failuresOf("h-cherry", "Yes, we offer financing through Cherry.")).toEqual([messages.noFirstMissing, messages.financingMissing, messages.layawayMissing]);
  });

  it("does not take \"Cherry financing\" for an offer of ours", () => {
    expect(failuresOf("h-cherry", "Unfortunately we don't accept Cherry financing. We offer interest-free layaway.")).toEqual([messages.financingMissing]);
  });

  it("fails a suggestion to try applying", () => {
    const response = "Unfortunately we don't accept Cherry, though you could try applying at the clinic. Klarna or PayPal can finance the balance, or there's interest-free layaway.";
    expect(failuresOf("h-cherry", response)).toEqual([messages.forbidden("try applying"), messages.hedge]);
  });
});
