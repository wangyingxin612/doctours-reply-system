import { describe, expect, it } from "vitest";
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
