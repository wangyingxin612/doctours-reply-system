import type { Validator, Violation } from "./types";

const NAME = "banned_phrases";

interface Rule {
  pattern: RegExp;
  severity: "block" | "warn";
  message: string;
}

// Block: wording the original prompt bans with no exception.
// Warn: wording it bans in general but requires in some replies ("I'll check in next month",
// "send done and I'll check it", "I'll send you a link with flight options"). Blocking those would
// fail correct replies, so they are logged and counted instead.
const RULES: Rule[] = [
  {
    pattern: /\b(?:this|the) (?:chat|thread|text line)\b|\bover text\b|\bvia text\b|\bon my end here\b|\bin this reply\b/i,
    severity: "block",
    message:
      "The reply points at the chat or text channel. Say what you can or cannot do as a person, without naming the channel.",
  },
  {
    pattern:
      /\blet me (?:look into|check|find out|get back)\b|\bI(?:'ll| will) (?:get back to you|find out|look into|check on (?:that|this|it))\b|\bget back to you\b/i,
    severity: "block",
    message: "The reply stalls. No later message is coming. Answer now, or say plainly that you don't have that detail.",
  },
  {
    pattern: /\bI(?:'ll| will| can) (?:call|phone|ring)\b|\bgive you a call\b/i,
    severity: "block",
    message: "The reply offers a phone call. You cannot make or schedule calls. Remove the offer.",
  },
  {
    pattern: /\bI (?:checked|looked (?:in|into|at)|pulled up|verified)\b[^.?!]*\b(?:our|the) (?:system|side|records)\b/i,
    severity: "block",
    message: "The reply claims an internal lookup. State only what a tool returned this turn.",
  },
  {
    pattern:
      /\b(?:can(?:'t|not)|(?:am |'m )?not able to|unable to|won't be able to)\s+(?:match|honor|apply|verify|confirm|adjust|offer|give)\b[^.?!]{0,60}\b(?:quote|price|pricing|discount|promo|code)\b/i,
    severity: "block",
    message:
      "The reply announces that a price cannot be matched or a discount cannot be applied. Do not refuse and do not confirm. Acknowledge what the patient said and give the current Doctours price.",
  },
  {
    pattern: /\bI(?:'ll| will) send\b/i,
    severity: "warn",
    message: 'The reply says "I\'ll send". That is right for a flight link after the deposit or a revised plan, and wrong for anything else.',
  },
  {
    pattern: /\bI(?:'ll| will) check\b(?! in\b)/i,
    severity: "warn",
    message: 'The reply says "I\'ll check". That is right after "send done", and wrong as a promise to look something up.',
  },
];

export const bannedPhrases: Validator = (reply) => {
  const violations: Violation[] = [];
  for (const { pattern, severity, message } of RULES) {
    if (pattern.test(reply.response)) violations.push({ validator: NAME, severity, message });
  }
  return violations;
};
