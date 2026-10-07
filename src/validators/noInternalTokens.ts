import { REASON_CODES } from "../policy/escalation";
import { TOOL_NAMES } from "../tools/registry";
import type { Validator } from "./types";

const NAME = "no_internal_tokens";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
/** PRE_CLINICAL_SENT, HUMAN_REQUESTED, do_not_recommend, no_consultation, clinic_flags and the like. */
const SNAKE_CASE = /\b[A-Za-z]+(?:_[A-Za-z]+)+\b/;

const NAMES = [
  ...TOOL_NAMES,
  ...TOOL_NAMES.map((name) => name.replace(/Tool$/, "")),
  ...REASON_CODES,
  "aiContext",
  "bookableWeekdays",
  "includedAddons",
  "availableAddons",
  "basePrice",
  "depositAmount",
  "selectedClinicId",
  "selectedPackageId",
  "shareStatus",
  "assessmentUrl",
  "workingMemory",
  "escalationFlags",
  "quoteDepositWithPrice",
  "links.include",
  "system prompt",
  "directive",
];
const KNOWN_NAME = new RegExp(String.raw`(?<![\w])(?:${NAMES.map((name) => name.replace(/[.]/g, String.raw`\.`)).join("|")})(?![\w])`, "i");

/** Talk about the machinery behind the reply: "the tool shows", "in my data". The rules say "tool" often, and the model echoes it. */
const MACHINERY =
  /\b(?:(?:the|my|our) tools?\s+(?:shows?|says?|lists?|returns?|returned|gives?|gave|has|have|only|does(?:n't| not)|do(?:n't| not))\b|tool (?:results?|calls?|outputs?)\b|according to (?:the|my|our) (?:tools?|data|system)\b|in (?:my|our) data\b|(?:the|my) data I have\b)/i;

/** The reply must read as a person's text message: no ids, tool names, field names, status labels or reason codes. */
export const noInternalTokens: Validator = (reply) => {
  // URLs legitimately contain ids, so they are set aside first.
  const prose = reply.response.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
  const found = [UUID, SNAKE_CASE, KNOWN_NAME, MACHINERY].map((pattern) => pattern.exec(prose)?.[0]).filter(Boolean);
  return found.length > 0
    ? [
        {
          validator: NAME,
          severity: "block",
          message: `The reply shows internal vocabulary (${found.map((token) => `"${token}"`).join(", ")}). Say it in a coordinator's own words.`,
        },
      ]
    : [];
};
