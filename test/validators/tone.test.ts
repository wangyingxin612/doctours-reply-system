// Validators that guard what a reply may promise or reveal. The passing examples include wording
// the original prompt requires, so a rule here can never fail a correct reply.

import { describe, expect, it } from "vitest";
import type { Reply } from "../../src/schema/reply";
import { blocking, runValidators } from "../../src/validators";
import { bannedPhrases } from "../../src/validators/bannedPhrases";
import { noHandoffPromise } from "../../src/validators/noHandoffPromise";
import { noHumanClaim } from "../../src/validators/noHumanClaim";
import { noInternalTokens } from "../../src/validators/noInternalTokens";
import { noTurnaroundWindow } from "../../src/validators/noTurnaroundWindow";
import { EMPTY_VALIDATION_CONTEXT as context } from "../../src/validators/types";
import { urlProvenance } from "../../src/validators/urlProvenance";

function reply(response: string, overrides: Partial<Reply> = {}): Reply {
  return {
    response,
    escalate: false,
    escalationReason: null,
    templateId: null,
    intent: "answer a question",
    shouldFollowUp: false,
    followUpTiming: null,
    attachmentUrls: null,
    highEngagement: false,
    workingMemoryUpdates: null,
    ...overrides,
  };
}

const severities = (response: string) => bannedPhrases(reply(response), context).map((violation) => violation.severity);

describe("banned_phrases", () => {
  it.each([
    "I'm also not able to transfer or reallocate the $300 from this chat.",
    "I don't have a way to issue a refund over text.",
    "I can't change your procedure date through this thread.",
    "Let me look into that for you.",
    "I'll get back to you shortly.",
    "I know you're waiting on the details, I'll find out.",
    "I'll call you tomorrow to go over it.",
    "I checked our side and I don't see the promo active in our system.",
  ])("blocks: %s", (response) => {
    expect(severities(response)).toContain("block");
  });

  it.each([
    "Take as much time as you need. I'll check in after a month if I don't hear from you. If you'd like more or less time, tell me and I'll adjust.",
    "Refunds aren't something I can process myself.",
    "I'll get the hairline redrawn lower and send you the updated plan.",
    "The Doctours consultant calls you at the scheduled time.",
    "Holding specific dates isn't something I can do. The deposit is what secures your date request.",
  ])("passes wording the original prompt uses: %s", (response) => {
    expect(severities(response)).toEqual([]);
  });

  it.each([
    "When you're finished, just send done and I'll check it.",
    "Yes, I can help with flights! After the deposit I'll send you a link with flight options.",
  ])("warns without blocking, because the original prompt requires it in places: %s", (response) => {
    expect(severities(response)).toEqual(["warn"]);
    expect(blocking(bannedPhrases(reply(response), context))).toEqual([]);
  });
});

describe("no_handoff_promise", () => {
  it.each([
    "Let me have a coordinator follow up with you on Tijuana.",
    "Someone from our team will reach out shortly.",
    "A team member will be with you soon.",
    "I'll have a specialist contact you about that.",
    "I'm escalating this to my manager.",
    "I can ask a colleague to help with the refund.",
  ])("blocks when the reply does not escalate: %s", (response) => {
    expect(noHandoffPromise(reply(response), context)).toHaveLength(1);
  });

  it.each([
    "The clinic confirms the date after the deposit is paid.",
    "The medical team is working on your assessment and they will send it as soon as it is ready.",
    "The team is reviewing your photos and will follow up.",
    "The Doctours consultant calls you at the scheduled time.",
    "You can reach her at molly@doctours.com and she can see if it would be a good fit.",
    "The surgeon determines the final graft count in person on procedure day.",
    "The deposit can be transferred to a different clinic as long as flights have not been purchased.",
    "A family member can be the Klarna account holder and make the payments.",
  ])("passes real third parties and plain facts: %s", (response) => {
    expect(noHandoffPromise(reply(response), context)).toEqual([]);
  });

  it("does not apply to an escalation, where a person really does take over", () => {
    const escalated = reply("Someone from our team will reach out shortly.", { escalate: true, escalationReason: "x" });
    expect(noHandoffPromise(escalated, context)).toEqual([]);
  });
});

describe("no_turnaround_window", () => {
  it.each([
    "Your assessment should be ready in 24-48 hours.",
    "You'll get your assessment by tomorrow.",
    "The assessment typically takes a few days to come back.",
    "Thanks! The team will send your assessment within a day.",
  ])("blocks: %s", (response) => {
    expect(noTurnaroundWindow(reply(response), context)).toHaveLength(1);
  });

  it.each([
    "The medical team is working on your assessment and you'll get it as soon as it's ready.",
    "The clinic confirms your date after the deposit, normally within 24 hours.",
    "Nothing's come through yet. I'll follow up in a few hours if I haven't heard from you.",
    "Your assessment is ready. You can open it using the link below.",
    "Most patients arrive a day or two before the procedure and stay about 3 nights.",
  ])("passes windows that are real commitments or have nothing to do with the assessment: %s", (response) => {
    expect(noTurnaroundWindow(reply(response), context)).toEqual([]);
  });
});

describe("no_internal_tokens", () => {
  it.each([
    "Your status is PRE_CLINICAL_SENT, so you can book now.",
    "That clinic is marked do_not_recommend.",
    "I ran getClinicPackagesTool and it shows two packages.",
    "The aiContext says the doctor draws the hairline.",
    "Your id is 7c2e1a40-6b8f-4d3a-9e15-2f0a8b6c4d11.",
    "That falls under PRICE_NEGOTIATION.",
  ])("blocks: %s", (response) => {
    expect(noInternalTokens(reply(response), context)).toHaveLength(1);
  });

  it.each([
    "You can open your assessment using the link below.\nhttps://www.doctours.com/assessment/c3d4e5f6-3333-4333-8333-333333333333",
    "After the deposit, Klarna or PayPal can finance the remaining balance.",
    "Layaway is interest-free and has no application.",
    "You can reach her at molly@doctours.com.",
    "Silver books Mon, Tue, Thu and Fri.",
  ])("passes ordinary text, and ids inside a link: %s", (response) => {
    expect(noInternalTokens(reply(response), context)).toEqual([]);
  });
});

describe("no_human_claim", () => {
  it.each([
    "Yes, I'm a real person.",
    "I'm not a bot, promise.",
    "You're talking to a real person.",
    "No, I am not an AI.",
    "I am a human being, yes.",
  ])("blocks: %s", (response) => {
    expect(noHumanClaim(reply(response), context)).toHaveLength(1);
  });

  it.each([
    "I'm Alex, your Patient Care Coordinator at Doctours.",
    "The doctor draws the hairline in person.",
    "The consultation is a phone call with the Doctours team.",
  ])("passes the coordinator's name and role, and facts about other people: %s", (response) => {
    expect(noHumanClaim(reply(response), context)).toEqual([]);
  });
});

describe("one payment or checkout link", () => {
  const payment = "https://www.doctours.com/payment/44444444-4444-4444-8444-444444444441";
  const checkout = "https://www.doctours.com/clinic/heva/checkout";
  const allowed = { ...context, allowedUrls: new Set([payment, checkout]) };

  it("passes one and blocks both together", () => {
    expect(urlProvenance(reply(`Pay using the link below.\n${payment}`), allowed)).toEqual([]);
    expect(urlProvenance(reply(`Either works.\n${payment}\n${checkout}`), allowed)).toHaveLength(1);
  });
});

describe("all validators together", () => {
  it.each([
    "Dr. Hakan Clinic has one package, and its doctor draws the hairline.",
    "Take as much time as you need. I'll check in after a month if I don't hear from you. If you'd like more or less time, tell me and I'll adjust.",
    "Unfortunately you can't use health insurance for a hair transplant. We do offer financing and layaway options though.",
    "Creator collaborations are handled by Molly, our partnerships manager. You can reach her at molly@doctours.com.",
  ])("pass a correct reply with nothing to ground: %s", (response) => {
    expect(blocking(runValidators(reply(response), context))).toEqual([]);
  });
});
