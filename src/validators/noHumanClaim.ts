import type { Validator } from "./types";

const NAME = "no_human_claim";

const PATTERNS = [
  /\bI(?:'m| am) (?:(?:definitely|really|actually|indeed) )?(?:a |an )?(?:real |actual |live )?(?:human(?: being)?|person)\b/i,
  /\bI(?:'m| am) not (?:a |an )?(?:bot|robot|chatbot|machine|program|computer|ai|a\.i\.|automated\b[^.?!]*|artificial\b[^.?!]*)/i,
  /\b(?:this is|you(?:'re| are) (?:talking|speaking|chatting|texting) (?:to|with)) (?:a |an )?(?:real |actual |live )?(?:human(?: being)?|person)\b/i,
  /\bno,? (?:I(?:'m| am)|this is) not (?:a |an )?(?:bot|robot|ai)\b/i,
];

/**
 * The reply never claims to be a human. A patient who asks gets the coordinator's name and role,
 * as the original prompt says, and a patient who asks for a person gets one.
 */
export const noHumanClaim: Validator = (reply) =>
  PATTERNS.some((pattern) => pattern.test(reply.response))
    ? [
        {
          validator: NAME,
          severity: "block",
          message:
            "The reply claims to be a human or denies being automated. Answer an identity question with your name and role only.",
        },
      ]
    : [];
