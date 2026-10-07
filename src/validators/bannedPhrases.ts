import type { Validator, Violation } from "./types";

const NAME = "banned_phrases";

interface Rule {
  /** Names the rule in the trace and the report. */
  id: string;
  pattern: RegExp;
  severity: "block" | "warn";
  message: string;
}

const CANNOT = String.raw`(?:can(?:'t|not)|(?:am |'m )?not able to|unable to|won't be able to)`;
// A second verb may come first: "verify or apply it", "match or negotiate that number".
const OR_VERB = String.raw`(?:\w+\s+or\s+)?`;

/**
 * A refusal about a price: "can't match that", "not able to apply a discount", "can't verify what
 * the clinic quoted". The verbs and objects are kept narrow, so that "I can't confirm a price the
 * package list doesn't show" and "I can't apply on your behalf" still pass.
 */
const PRICE_REFUSAL = new RegExp(
  String.raw`\b${CANNOT}\s+${OR_VERB}(?:` +
    String.raw`(?:match|honor|beat|negotiate|apply)\s+(?:that|it|this)\b` +
    "|" +
    String.raw`(?:match|honor|apply|adjust|beat|lower|reduce|negotiate)\b[^.?!]{0,60}\b(?:quote|price|pricing|discount|promo|code)\b` +
    "|" +
    String.raw`(?:verify|confirm)\b[^.?!]{0,40}\bquote[ds]?\b` +
    ")",
  "i",
);

// Block: wording the original prompt bans with no exception.
// Warn: wording it bans in general but requires in some replies ("I'll check in next month",
// "send done and I'll check it", "I'll send you a link with flight options"). Blocking those would
// fail correct replies, so they are logged and counted instead.
const RULES: Rule[] = [
  {
    id: "channel_talk",
    pattern: /\b(?:this|the) (?:chat|thread|text line)\b|\bover text\b|\bvia text\b|\bon my end here\b|\bin this reply\b/i,
    severity: "block",
    message:
      "The reply points at the chat or text channel. Say what you can or cannot do as a person, without naming the channel.",
  },
  {
    id: "stalling",
    pattern:
      /\blet me (?:look into|check|find out|get back)\b|\bI(?:'ll| will) (?:get back to you|find out|look into|check on (?:that|this|it))\b|\bget back to you\b/i,
    severity: "block",
    message: "The reply stalls. No later message is coming. Answer now, or say plainly that you don't have that detail.",
  },
  {
    id: "call_offer",
    pattern: /\bI(?:'ll| will| can) (?:call|phone|ring)\b|\bgive you a call\b/i,
    severity: "block",
    message: "The reply offers a phone call. You cannot make or schedule calls. Remove the offer.",
  },
  {
    id: "internal_lookup",
    pattern: /\bI (?:checked|looked (?:in|into|at)|pulled up|verified)\b[^.?!]*\b(?:our|the) (?:system|side|records)\b/i,
    severity: "block",
    message: "The reply claims an internal lookup. State only what a tool returned this turn.",
  },
  {
    id: "price_refusal",
    pattern: PRICE_REFUSAL,
    severity: "block",
    message:
      "The reply announces that a price cannot be matched or a discount cannot be applied. Do not refuse and do not confirm. Acknowledge what the patient said and give the current Doctours price.",
  },
  {
    id: "will_send",
    pattern: /\bI(?:'ll| will) send\b/i,
    severity: "warn",
    message: 'The reply says "I\'ll send". That is right for a flight link after the deposit or a revised plan, and wrong for anything else.',
  },
  {
    id: "will_check",
    pattern: /\bI(?:'ll| will) check\b(?! in\b)/i,
    severity: "warn",
    message: 'The reply says "I\'ll check". That is right after "send done", and wrong as a promise to look something up.',
  },
];

export const bannedPhrases: Validator = (reply) => {
  const violations: Violation[] = [];
  for (const { id, pattern, severity, message } of RULES) {
    if (pattern.test(reply.response)) violations.push({ validator: NAME, rule: id, severity, message });
  }
  return violations;
};
