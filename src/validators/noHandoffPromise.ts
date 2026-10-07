import type { Validator } from "./types";

const NAME = "no_handoff_promise";

// A Doctours person. The clinic, the surgeon and the medical team are real third parties and may be named.
const PERSON = String.raw`(?:coordinator|specialist|team member|member of (?:our|the) team|representative|agent|colleague|manager|advisor|supervisor|someone|somebody|a person|a human)`;
const WILL_ACT = String.raw`(?:will|is going to|are going to|can|'ll|should)\s+(?:\w+\s+)?(?:reach out|follow up|get back|be in touch|contact|call|text|message|take over|take it from here|help you|assist|be with you|step in)`;

const PATTERNS = [
  new RegExp(String.raw`\b${PERSON}\b[^.?!]{0,50}\b${WILL_ACT}\b`, "i"),
  new RegExp(
    String.raw`\b(?:I(?:'ll| will|'m going to| am going to|'m| am| can| could)|let me)\s+(?:have|get|ask|loop(?:ing)? in|bring(?:ing)? in|connect(?:ing)? you (?:with|to)|pass(?:ing)? (?:this|you)|hand(?:ing)? (?:this|you)|forward(?:ing)?|transfer(?:ring)?|escalat(?:e|ing))\b[^.?!]{0,60}\b${PERSON}\b`,
    "i",
  ),
  /\b(?:escalat(?:e|ed|ing)|hand(?:ed|ing)? (?:you|this) (?:off|over))\b/i,
];

/**
 * A reply that does not escalate must not say a person will take over, call or follow up.
 * Nobody is alerted unless `escalate` is true, so such a sentence would be a false promise.
 */
export const noHandoffPromise: Validator = (reply) => {
  if (reply.escalate) return [];
  return PATTERNS.some((pattern) => pattern.test(reply.response))
    ? [
        {
          validator: NAME,
          severity: "block",
          message:
            "The reply says a person will take over, reach out or follow up. Nobody is alerted for this message. Remove that, and say what the patient can do instead.",
        },
      ]
    : [];
};
