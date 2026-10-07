import { describe, expect, it } from "vitest";
import type { Reply } from "../../src/schema/reply";
import { TurnLedger } from "../../src/tools/ledger";
import { noCardEcho } from "../../src/validators/noCardEcho";
import { noMarkdown } from "../../src/validators/noMarkdown";
import { priceGrounding } from "../../src/validators/priceGrounding";
import { shape } from "../../src/validators/shape";
import { extractMoney, extractNumbers, extractUrls } from "../../src/validators/text";
import { EMPTY_VALIDATION_CONTEXT, type ValidationContext } from "../../src/validators/types";
import { urlLastLine } from "../../src/validators/urlLastLine";
import { urlProvenance } from "../../src/validators/urlProvenance";

const LINK = "https://www.doctours.com/consultation";
const OTHER_LINK = "https://www.doctours.com/image-upload";

function reply(overrides: Partial<Reply> = {}): Reply {
  return {
    response: "Yes, that works.",
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

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return { ...EMPTY_VALIDATION_CONTEXT, ...overrides };
}

function hevaMoney() {
  const ledger = new TurnLedger();
  ledger.call("getClinicPackagesTool", { clinicName: "Heva" }, "prefetch");
  return ledger.money();
}

describe("text helpers", () => {
  it("finds URLs and drops sentence punctuation after them", () => {
    expect(extractUrls(`See ${LINK}. Or ${OTHER_LINK}`)).toEqual([LINK, OTHER_LINK]);
    expect(extractUrls("mail molly@doctours.com for that")).toEqual([]);
  });

  it("reads money in the forms a reply might use", () => {
    const amounts = (text: string) => extractMoney(text).map((mention) => mention.amount);
    expect(amounts("It is $3,000 with a $500 deposit.")).toEqual([3000, 500]);
    expect(amounts("It is $3000.")).toEqual([3000]);
    expect(amounts("About $3k.")).toEqual([3000]);
    expect(amounts("It is 4,500 USD.")).toEqual([4500]);
    expect(amounts("It is USD 4500.")).toEqual([4500]);
    expect(amounts("A fee of 25 dollars applies.")).toEqual([25]);
    expect(amounts("They quoted €2,600.")).toEqual([2600]);
    expect(amounts("You need 2800 grafts over 3 nights.")).toEqual([]);
  });

  it("reads the currency when the text names one", () => {
    expect(extractMoney("$3,000 USD")[0]).toMatchObject({ amount: 3000, currency: "USD" });
    expect(extractMoney("$3,000")[0]).toMatchObject({ amount: 3000, currency: null });
    expect(extractMoney("£2,600")[0]).toMatchObject({ amount: 2600, currency: "GBP" });
  });

  it("reads bare numbers a patient may write without a currency sign", () => {
    expect(extractNumbers("Heva quoted me 2600, or was it 2,600? Maybe 3k.")).toEqual([2600, 2600, 3000]);
  });
});

describe("shape", () => {
  it("passes a well-formed reply", () => {
    expect(shape(reply(), context())).toEqual([]);
    expect(shape(reply({ shouldFollowUp: true, followUpTiming: "1 month" }), context())).toEqual([]);
  });

  it("ties escalationReason to escalate", () => {
    expect(shape(reply({ escalate: true }), context())).toHaveLength(1);
    expect(shape(reply({ escalationReason: "why" }), context())).toHaveLength(1);
    expect(shape(reply({ escalate: true, escalationReason: "why" }), context())).toEqual([]);
  });

  it("ties followUpTiming to shouldFollowUp", () => {
    expect(shape(reply({ shouldFollowUp: true }), context())).toHaveLength(1);
    expect(shape(reply({ followUpTiming: "1 month" }), context())).toHaveLength(1);
  });

  it("rejects an empty response, an empty attachment list and unknown keys", () => {
    expect(shape(reply({ response: "  " }), context())).toHaveLength(1);
    expect(shape(reply({ attachmentUrls: [] }), context())).toHaveLength(1);
    expect(shape({ ...reply(), id: "x" } as Reply, context()).length).toBeGreaterThan(0);
    expect(shape({ ...reply(), templateId: "t" } as unknown as Reply, context()).length).toBeGreaterThan(0);
  });
});

describe("url_last_line", () => {
  it("passes no URL, one URL on the last line, and stacked URLs at the end", () => {
    expect(urlLastLine(reply(), context())).toEqual([]);
    expect(urlLastLine(reply({ response: `You can book using the link below.\n${LINK}` }), context())).toEqual([]);
    expect(urlLastLine(reply({ response: `Both are below.\n${LINK}\n${OTHER_LINK}` }), context())).toEqual([]);
    expect(urlLastLine(reply({ response: `Use the link below.\n${LINK}\n` }), context())).toEqual([]);
  });

  it("blocks a URL inside a sentence", () => {
    expect(urlLastLine(reply({ response: `Book at ${LINK} when you can.` }), context())).toHaveLength(1);
    expect(urlLastLine(reply({ response: `You can book here: ${LINK}` }), context())).toHaveLength(1);
    expect(urlLastLine(reply({ response: `Use the link below.\n${LINK}.` }), context())).toHaveLength(1);
  });

  it("blocks text after the URL line", () => {
    const response = `Use the link below.\n${LINK}\nLet me know how it goes.`;
    expect(urlLastLine(reply({ response }), context())).toHaveLength(1);
  });
});

describe("url_provenance", () => {
  it("passes a URL that is allowed this turn", () => {
    const ok = urlProvenance(reply({ response: `Use the link below.\n${LINK}` }), context({ allowedUrls: new Set([LINK]) }));
    expect(ok).toEqual([]);
  });

  it("blocks a URL no tool returned and no skill lists", () => {
    expect(urlProvenance(reply({ response: `Use the link below.\n${LINK}` }), context())).toHaveLength(1);
    const invented = "https://www.doctours.com/payment/made-up";
    expect(
      urlProvenance(reply({ response: `Pay below.\n${invented}` }), context({ allowedUrls: new Set([LINK]) })),
    ).toHaveLength(1);
  });

  it("blocks a reply that leaves out a required link", () => {
    const missing = urlProvenance(reply(), context({ allowedUrls: new Set([LINK]), requiredUrls: new Set([LINK]) }));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain(LINK);
  });

  it("allows only the patient's photo URLs as attachments, at most three", () => {
    const photos = ["https://assets.example.invalid/a.jpg", "https://assets.example.invalid/b.jpg"];
    const withPhotos = context({ imageUrls: new Set(photos) });

    expect(urlProvenance(reply({ attachmentUrls: photos }), withPhotos)).toEqual([]);
    expect(urlProvenance(reply({ attachmentUrls: [LINK] }), withPhotos)).toHaveLength(1);
    expect(urlProvenance(reply({ attachmentUrls: photos }), context())).toHaveLength(2);
  });
});

describe("price_grounding", () => {
  const withHeva = () => context({ money: hevaMoney() });

  it("passes amounts a tool returned this turn, in any common format", () => {
    const response = "The Silver package costs $3,000 USD and its deposit is $500. Gold costs 4500 USD and its deposit is $600.";
    expect(priceGrounding(reply({ response }), withHeva())).toEqual([]);
  });

  it("blocks an amount no tool returned", () => {
    const violations = priceGrounding(reply({ response: "Silver is about $2,900." }), withHeva());
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("3000");
  });

  it("blocks every amount when no tool was called", () => {
    expect(priceGrounding(reply({ response: "It starts around $3,000." }), context())).toHaveLength(1);
  });

  it("passes a policy amount only when a loaded skill declares it", () => {
    const response = "The deposit is refundable less a $25 cancellation fee.";
    expect(priceGrounding(reply({ response }), context({ policyAmounts: [25] }))).toEqual([]);
    expect(priceGrounding(reply({ response }), context())).toHaveLength(1);
  });

  it("passes an amount the patient wrote, with or without a currency sign", () => {
    const patientText = "Heva quoted me 2600 directly";
    expect(priceGrounding(reply({ response: "Thanks for sharing the $2,600 quote." }), context({ patientText }))).toEqual([]);
  });

  it("passes an exact difference of two amounts for the same clinic", () => {
    const balance = "After the $500 deposit, $2,500 remains on Silver.";
    const gap = "Gold is $1,500 more than Silver.";
    expect(priceGrounding(reply({ response: balance }), withHeva())).toEqual([]);
    expect(priceGrounding(reply({ response: gap }), withHeva())).toEqual([]);
  });

  it("does not mix amounts across clinics", () => {
    const ledger = new TurnLedger();
    ledger.call("getClinicPackagesTool", { clinicName: "Heva" }, "prefetch");
    ledger.call("getClinicPackagesTool", { clinicName: "Hakan" }, "prefetch");
    // 3200 (Hakan) minus 3000 (Heva) is not a real figure for either clinic.
    const response = "Sapphire is $200 more than Silver.";
    expect(priceGrounding(reply({ response }), context({ money: ledger.money() }))).toHaveLength(1);
  });

  it("blocks a currency the tool did not return", () => {
    expect(priceGrounding(reply({ response: "Silver is €3,000." }), withHeva())).toHaveLength(1);
  });

  it("ignores numbers that are not money", () => {
    const response = "Your assessment estimates 2,500 to 3,200 grafts and Silver includes 3 hotel nights.";
    expect(priceGrounding(reply({ response }), context())).toEqual([]);
  });
});

describe("no_markdown", () => {
  it("passes plain text, including dashes, apostrophes and a multiplication sign", () => {
    const plain = [
      "Heva has two packages - Silver and Gold. That's all.",
      "It's 3 nights, so 3 * 1 night each.",
      "Take your time.\nI'll check in next month.",
      "You can reach her at molly@doctours.com for that.",
    ];
    for (const response of plain) expect(noMarkdown(reply({ response }), context())).toEqual([]);
  });

  it("blocks bold, italics, headers, lists, code and markdown links", () => {
    const marked = [
      "Silver is **$3,000**.",
      "Silver is __cheaper__.",
      "That is *really* common.",
      "# Packages",
      "They have:\n- Silver\n- Gold",
      "Steps:\n1. Open the assessment\n2. Pick a clinic",
      "Use `Book` to pay.",
      "Open [your assessment](https://example.invalid).",
    ];
    for (const response of marked) expect(noMarkdown(reply({ response }), context()).length).toBeGreaterThan(0);
  });
});

describe("no_card_echo", () => {
  it("passes when no card data was redacted or none is repeated", () => {
    expect(noCardEcho(reply({ response: "Silver is $3,000." }), context())).toEqual([]);
    expect(noCardEcho(reply({ response: "Silver is $3,000." }), context({ redactedTokens: ["1881"] }))).toEqual([]);
  });

  it("blocks last-four digits in the response or in any other field", () => {
    const tokens = context({ redactedTokens: ["1881"] });
    expect(noCardEcho(reply({ response: "I can't charge the card ending in 1881." }), tokens)).toHaveLength(1);
    expect(noCardEcho(reply({ workingMemoryUpdates: { keyConcerns: "card 1881 declined" } }), tokens)).toHaveLength(1);
    expect(noCardEcho(reply({ intent: "decline charge on 1881" }), tokens)).toHaveLength(1);
  });

  it("blocks a full card number even when the digits are regrouped", () => {
    const tokens = context({ redactedTokens: ["4111 1111 1111 1111"] });
    expect(noCardEcho(reply({ response: "Got 4111-1111-1111-1111, thanks." }), tokens)).toHaveLength(1);
    expect(noCardEcho(reply({ response: "Got 4111111111111111, thanks." }), tokens)).toHaveLength(1);
  });

  it("does not flag a short code inside a longer number", () => {
    expect(noCardEcho(reply({ response: "That is 18810 grafts." }), context({ redactedTokens: ["1881"] }))).toEqual([]);
  });

  it("never repeats the card data in its own message", () => {
    const [violation] = noCardEcho(reply({ response: "Card 1881." }), context({ redactedTokens: ["1881"] }));
    expect(violation?.message).not.toContain("1881");
  });
});
