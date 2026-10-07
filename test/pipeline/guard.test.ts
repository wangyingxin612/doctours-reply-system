import { describe, expect, it } from "vitest";
import { loadCases } from "../../eval/lib";
import { runGuard } from "../../src/pipeline/guard";

function reasonCodes(text: string): string[] {
  return runGuard(text).hits.map((hit) => hit.reasonCode);
}

describe("guard: card redaction", () => {
  it("removes a card number written with spaces, dashes or nothing", () => {
    for (const number of ["4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111"]) {
      const result = runGuard(`My card is ${number} ok?`);
      expect(result.redactedText).toBe("My card is [card number removed] ok?");
      expect(result.redactions).toEqual([{ type: "card_number", token: number }]);
      expect(result.cardDataPresent).toBe(true);
    }
  });

  it("removes last-four digits, a CVV and an expiry date", () => {
    const result = runGuard("Card ending in 1881, cvv 912, exp 04/29. Also the last four are 7733.");
    expect(result.redactedText).not.toMatch(/1881|912|04\/29|7733/);
    expect(result.redactions.map((redaction) => redaction.type).sort()).toEqual([
      "card_last4",
      "card_last4",
      "cvv",
      "expiry",
    ]);
  });

  it("removes last-four digits written without 'in'", () => {
    const result = runGuard("The site refused my card ending 9034 again.");
    expect(result.redactedText).toBe("The site refused my card ending [digits removed] again.");
    expect(result.redactions).toEqual([{ type: "card_last4", token: "9034" }]);
  });

  it("removes masked card numbers", () => {
    expect(runGuard("It was the card **** 5521").redactedText).not.toContain("5521");
    expect(runGuard("xxxx-xxxx-xxxx-9034 is the one").redactedText).not.toContain("9034");
  });

  it("leaves prices, graft counts, dates, phone numbers and ids alone", () => {
    const untouched = [
      "Is it $3,000 or $4,500 for 2800 grafts?",
      "Can I come on 12/08/2026?",
      "Call me on +1 555 555 0123",
      "My id is 7c2e1a40-6b8f-4d3a-9e15-2f0a8b6c4d11",
      "Reference 44444444-4444-4444-8444-444444444441",
      "I counted 1881 hairs",
    ];
    for (const text of untouched) {
      const result = runGuard(text);
      expect(result.redactedText).toBe(text);
      expect(result.cardDataPresent).toBe(false);
    }
  });
});

describe("guard: explicit requests for a human", () => {
  const positives = [
    "I want to talk to a human",
    "Can I speak with a real person please?",
    "I'd like to speak to an agent.",
    "let me talk to a person",
    "I need to speak with a representative about this",
    "Could I please chat with a live agent",
    "I have to speak to the manager",
    "I demand to speak with a supervisor right now",
    "Transfer me to a human",
    "can you connect me with a manager",
    "Put me through to an operator",
    "Get me a human.",
    "I need a real person",
    "I want an agent to help me with this",
    "agent please",
    "Human!",
    "Thanks for the info. Can I talk to a human about financing?",
    // "Someone", where nothing says the someone is anybody but us.
    "Can I talk to someone about this?",
    "Let me talk to someone.",
    "I'd like to speak with somebody about my options",
    "I need to speak to someone from your team.",
    "Can I talk to someone else?",
    "Is there someone I can talk to?",
    "Is there anyone I can speak with about financing?",
    "Is there a person I can speak to?",
    "Can I get a rep on this?",
    "Could I have a manager please?",
    "I want customer service.",
    "Can I talk to customer support?",
  ];

  it.each(positives)("escalates: %s", (text) => {
    expect(reasonCodes(text)).toEqual(["HUMAN_REQUESTED"]);
  });

  const negatives = [
    "Will a human do my surgery?",
    "Is the consultation with a real person?",
    "Are you a real person?",
    "I spoke with a representative at the clinic yesterday.",
    "I don't want to talk to a person, text is fine.",
    "No need to transfer me to an agent, just send the link.",
    "Does the doctor or a technician do the hairline?",
    "Can I talk to the surgeon before the procedure?",
    "I want a person who specializes in afro hair.",
    "I need a real person to do the surgery, not a machine.",
    "My agent booked my flights already.",
    "Is there a manager at the clinic?",
    "How human does the new hairline look?",
    // A question about whether a person is needed is not a request for one.
    "Do I need to talk to a person before paying?",
    "Do I have to speak with an agent first?",
    "Would I need to speak to a representative to book?",
    "Do I need to talk to someone before I pay?",
    "Do I need an agent?",
    // "Someone" who is not one of us, or might not be.
    "I need to talk to someone in my family first.",
    "I have to talk to someone first.",
    "Can I talk to someone who has had this done?",
    "Can I speak with someone at the clinic?",
    "Is there someone I can talk to at the clinic?",
    "Is there anyone I can talk to who had the surgery there?",
    // A call may be the free consultation, which the patient books alone. The router tells the two apart.
    "Can someone call me?",
    "Can I talk to someone on the phone?",
    "Please have somebody from your team contact me.",
    "Who will I be talking to on the consultation call?",
    "Can I have a human do the extraction?",
    "What are your customer service hours?",
  ];

  it.each(negatives)("leaves to the router: %s", (text) => {
    expect(reasonCodes(text)).toEqual([]);
  });
});

describe("guard: instructions to charge a card", () => {
  const positives = [
    "Please charge my Visa for the deposit.",
    "Run my card ending in 1881 for the deposit today.",
    "Can you bill the card on file?",
    "Go ahead and put the deposit on my card.",
    "Yes, take the $500 from my debit card.",
    "Charge the remaining balance to my amex",
    "ok, charge it to my card",
    "Just use my card ending in 1881 for the deposit",
    "Here's my card 4111 1111 1111 1111, exp 12/27, cvv 123",
    "My card number is 4111-1111-1111-1111 for the deposit",
  ];

  it.each(positives)("escalates: %s", (text) => {
    expect(reasonCodes(text)).toEqual(["PAYMENT_ACTION_NO_TOOL"]);
  });

  const negatives = [
    "My card got declined, what else can I use?",
    "My card ending in 1881 was declined on the checkout page. What other options are there?",
    "Will you charge my card automatically every month on layaway?",
    "Do you charge the card in dollars?",
    "How do I pay the deposit with a card?",
    "Can I use my card to pay?",
    "I was charged twice on my card",
    "Is it safe to put my card details on the site?",
    "Run me through how the deposit works on a card",
    "Please don't charge my card yet.",
    "I don't want you to charge my card until I pick a clinic.",
    "Which cards do you take?",
  ];

  it.each(negatives)("leaves to the router: %s", (text) => {
    expect(reasonCodes(text)).toEqual([]);
  });

  it("never shows card digits to later stages, even when it escalates", () => {
    const result = runGuard("Run my card ending in 1881 for the deposit today.");
    expect(result.redactedText).toBe("Run my card ending in [digits removed] for the deposit today.");
    expect(result.redactions).toEqual([{ type: "card_last4", token: "1881" }]);
  });
});

describe("guard: more than one hit", () => {
  it("reports both, with the human request first", () => {
    expect(reasonCodes("Charge my card for the deposit. Actually, let me talk to a person.")).toEqual([
      "HUMAN_REQUESTED",
      "PAYMENT_ACTION_NO_TOOL",
    ]);
  });
});

// The eval cases are the largest set of real wordings there is. The guard decides alone when it
// fires, so it is held to every one of them: it may not fire on a message that should be answered,
// and when it fires its code has to be one the case accepts.
describe("guard: against every eval case", () => {
  const cases = loadCases();
  const hitsOf = (text: string) => runGuard(text).hits.map((hit) => hit.reasonCode);

  it("never fires on a message that should be answered", () => {
    const wrong = cases.filter((testCase) => !testCase.expect.escalate && hitsOf(testCase.text).length > 0).map((testCase) => testCase.id);
    expect(wrong).toEqual([]);
    expect(cases.filter((testCase) => !testCase.expect.escalate).length).toBeGreaterThan(40);
  });

  it("gives a reason code the case accepts whenever it fires", () => {
    const fired = cases.filter((testCase) => hitsOf(testCase.text).length > 0);
    for (const testCase of fired) {
      const accepted = testCase.expect.reasonCode ? [testCase.expect.reasonCode] : testCase.expect.reasonCodeIn;
      if (accepted) expect(accepted, testCase.id).toContain(hitsOf(testCase.text)[0]);
    }
    expect(fired.length).toBeGreaterThanOrEqual(6);
  });
});
