// Deterministic checks that run before any model sees the message.
// 1. Card data is redacted. 2. Two escalations are decided here, with high-precision patterns only.
// Anything ambiguous is left to the router.

export type RedactionType = "card_number" | "card_last4" | "cvv" | "expiry";

export interface Redaction {
  type: RedactionType;
  /** The removed text. Kept in memory for the no_card_echo validator. Never written to a trace. */
  token: string;
}

export type GuardReasonCode = "HUMAN_REQUESTED" | "PAYMENT_ACTION_NO_TOOL";

/** A guard decision never reaches the router, so its intent for the report follows from its code. */
export const GUARD_INTENT: Record<GuardReasonCode, string> = {
  HUMAN_REQUESTED: "human_request",
  PAYMENT_ACTION_NO_TOOL: "payment",
};

export interface GuardHit {
  reasonCode: GuardReasonCode;
  rule: string;
}

export interface GuardResult {
  redactedText: string;
  cardDataPresent: boolean;
  redactions: Redaction[];
  hits: GuardHit[];
}

const PLACEHOLDER: Record<RedactionType, string> = {
  card_number: "[card number removed]",
  card_last4: "[digits removed]",
  cvv: "[code removed]",
  expiry: "[date removed]",
};

// 12 to 19 digits, single spaces or dashes allowed between them. The lookarounds keep the match
// from starting or ending inside a longer run, so ids made of digits and dashes are left alone.
const CARD_NUMBER = /(?<![\d-])\d(?:[ -]?\d){11,18}(?![\d-])/g;

const SENSITIVE_DIGITS: Array<{ type: RedactionType; pattern: RegExp }> = [
  { type: "cvv", pattern: /\b(?:cvv2?|cvc2?|cid|security\s+code)\b\s*(?:is|[:=#])?\s*(\d{3,4})\b/gi },
  {
    type: "expiry",
    pattern: /\bexp(?:iry|iration|ires|\.)?(?:\s+date)?\s*(?:is|on|[:=])?\s*(\d{1,2}\s*[/-]\s*\d{2,4})\b/gi,
  },
  { type: "card_last4", pattern: /\b(?:ending|ends|end)(?:\s+(?:in|with))?\s+#?(\d{4})\b/gi },
  {
    type: "card_last4",
    pattern: /\blast\s+(?:four|4)(?:\s+digits)?(?:\s+(?:are|is|of(?:\s+\w+){0,3}))?\s*[:#]?\s*(\d{4})\b/gi,
  },
  { type: "card_last4", pattern: /(?:[x*•]{2,}[\s-]*)+(\d{4})\b/gi },
];

function redact(text: string): { redactedText: string; redactions: Redaction[] } {
  const redactions: Redaction[] = [];

  let redactedText = text.replace(CARD_NUMBER, (match) => {
    redactions.push({ type: "card_number", token: match });
    return PLACEHOLDER.card_number;
  });

  for (const { type, pattern } of SENSITIVE_DIGITS) {
    redactedText = redactedText.replace(pattern, (match: string, digits: string) => {
      redactions.push({ type, token: digits });
      return match.replace(digits, PLACEHOLDER[type]);
    });
  }

  return { redactedText, redactions };
}

// --- Explicit requests for a human -------------------------------------------------------------

const HUMAN_STRICT = String.raw`(?:human(?:\s+being)?|agent|representative|rep|operator|manager|supervisor|(?:real|live|actual)\s+person)`;
const QUALIFIER = String.raw`(?:(?:real|live|actual|human|customer\s+service|support)\s+){0,2}`;
const ARTICLE = String.raw`(?:(?:a|an|the|some|another|any|your)\s+)?`;
const TARGET = String.raw`${ARTICLE}${QUALIFIER}(?:${HUMAN_STRICT}|person)\b`;
const TARGET_STRICT = String.raw`${ARTICLE}${QUALIFIER}${HUMAN_STRICT}\b`;

const WANT = String.raw`\bi(?:'d|\s+would)?\s+(?:want|need|like|wanna|prefer|demand|require|wish)\s+(?:to\s+)?`;
const MAY_I = String.raw`\b(?:can|could|may|might)\s+i\s+(?:please\s+|just\s+)?`;
const LET_ME = String.raw`\blet\s+me\s+`;
const MUST = String.raw`\bi\s+(?:have|need|got)\s+to\s+`;
const CONTACT = String.raw`(?:talk|speak|chat|get\s+in\s+touch|be\s+connected|be\s+transferred|connect)\s+(?:to|with)\s+`;

const HUMAN_REQUEST_RULES: Array<{ rule: string; pattern: RegExp }> = [
  {
    rule: "asks_to_talk_to_a_human",
    pattern: new RegExp(`(?:${WANT}|${MAY_I}|${LET_ME}|${MUST})${CONTACT}${TARGET}`, "i"),
  },
  {
    rule: "asks_to_be_transferred",
    pattern: new RegExp(
      String.raw`\b(?:transfer|connect|put|pass|hand)\s+me\s+(?:over\s+|through\s+)?(?:to|with)\s+${TARGET}`,
      "i",
    ),
  },
  {
    // "I need a real person" is a request. "I need a real person to do the surgery" is not, so the
    // target has to end the clause or be followed by a word about talking or helping.
    rule: "asks_for_a_human",
    pattern: new RegExp(
      String.raw`(?:\b(?:get|give|send|find)\s+me\s+|\bi(?:'d|\s+would)?\s+(?:want|need|like|demand|require)\s+)${TARGET_STRICT}(?=\s*(?:$|[.!?,;]|please\b|now\b|right\s+now\b|asap\b|here\b|instead\b|to\s+(?:talk|speak|chat|help)\b|on\s+(?:the\s+)?(?:phone|line)\b))`,
      "i",
    ),
  },
  {
    rule: "bare_human_request",
    pattern: new RegExp(String.raw`^\W*(?:please\s+)?${TARGET_STRICT}(?:\s+please)?\W*$`, "i"),
  },
];

// "No need to transfer me to an agent" is not a request. A negation just before the match defers to the router.
const NEGATION_BEFORE = /\b(?:don'?t|do\s+not|not|no|never|without|rather\s+not|instead\s+of)\b[^.?!]{0,24}$/i;

function findHumanRequest(text: string): GuardHit | null {
  for (const { rule, pattern } of HUMAN_REQUEST_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (NEGATION_BEFORE.test(text.slice(0, match.index))) continue;
    return { reasonCode: "HUMAN_REQUESTED", rule };
  }
  return null;
}

// --- Instructions to charge a card ------------------------------------------------------------

const CARD = String.raw`(?:card|visa|mastercard|amex|american\s+express)`;
const MY_CARD = String.raw`(?:my|the|this|that)\s+(?:\w+\s+){0,2}${CARD}\b`;

// An instruction, not a question: at the start of a clause, or after "please", "can you" and the like.
// "Will you charge my card each month?" is a question about how payment works and goes to the router.
const INSTRUCTION = String.raw`(?:^|[.!?;,:]\s*|\b(?:please|pls|just|ok|okay|yes|yeah|sure|go\s+ahead\s+and|can\s+you|could\s+you|would\s+you|i\s+want\s+you\s+to|i\s+need\s+you\s+to|i'd\s+like\s+you\s+to|you\s+can|you\s+may|feel\s+free\s+to)\s+)(?:(?:please|just|now|and|then)\s+)*`;

// What is being charged: "it", "the deposit", "my remaining balance", "$500". Kept short on purpose,
// so "run me through how paying by card works" does not look like "run my card".
const OBJECT = String.raw`(?:(?:it|that|this|them)\s+|(?:the|my|a)\s+(?:[\w$]+\s+){1,3}?|\$?\d[\d,.]*\s+)`;

const CHARGE_RULES: Array<{ rule: string; pattern: RegExp }> = [
  {
    rule: "instruction_to_charge_a_card",
    pattern: new RegExp(
      String.raw`${INSTRUCTION}(?:charge|bill|debit|run|process|swipe)\s+(?:me\s+)?${OBJECT}?(?:(?:on|to|with|through|against|from|for)\s+)?${MY_CARD}`,
      "i",
    ),
  },
  {
    rule: "instruction_to_put_it_on_a_card",
    pattern: new RegExp(String.raw`${INSTRUCTION}(?:put|place)\s+${OBJECT}on\s+${MY_CARD}`, "i"),
  },
  {
    rule: "instruction_to_take_payment_from_a_card",
    pattern: new RegExp(String.raw`${INSTRUCTION}take\s+${OBJECT}(?:from|off|out\s+of)\s+${MY_CARD}`, "i"),
  },
  {
    rule: "instruction_to_use_a_card",
    pattern: new RegExp(
      String.raw`${INSTRUCTION}use\s+${MY_CARD}[^.?!]{0,40}\b(?:for|to\s+pay|deposit|payment)\b`,
      "i",
    ),
  },
];

const PAYMENT_WORD = /\b(?:pay|paying|payment|deposit|charge|book|booking|use)\b/i;

function findChargeInstruction(text: string, redactions: Redaction[]): GuardHit | null {
  for (const { rule, pattern } of CHARGE_RULES) {
    if (pattern.test(text)) return { reasonCode: "PAYMENT_ACTION_NO_TOOL", rule };
  }

  // A full card number sent along with a payment word, a CVV or an expiry date is card details sent to pay.
  const types = new Set(redactions.map((redaction) => redaction.type));
  if (types.has("card_number") && (types.has("cvv") || types.has("expiry") || PAYMENT_WORD.test(text))) {
    return { reasonCode: "PAYMENT_ACTION_NO_TOOL", rule: "card_details_sent_to_pay" };
  }
  return null;
}

export function runGuard(text: string): GuardResult {
  const { redactedText, redactions } = redact(text);

  const hits: GuardHit[] = [];
  const humanRequest = findHumanRequest(redactedText);
  if (humanRequest) hits.push(humanRequest);
  const chargeInstruction = findChargeInstruction(redactedText, redactions);
  if (chargeInstruction) hits.push(chargeInstruction);

  return { redactedText, cardDataPresent: redactions.length > 0, redactions, hits };
}
