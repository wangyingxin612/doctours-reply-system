import type { Reply } from "../schema/reply";
import { bannedPhrases } from "./bannedPhrases";
import { noCardEcho } from "./noCardEcho";
import { noHandoffPromise } from "./noHandoffPromise";
import { noHumanClaim } from "./noHumanClaim";
import { noInternalTokens } from "./noInternalTokens";
import { noMarkdown } from "./noMarkdown";
import { noTurnaroundWindow } from "./noTurnaroundWindow";
import { priceGrounding } from "./priceGrounding";
import { shape } from "./shape";
import type { ValidationContext, Validator, Violation } from "./types";
import { urlLastLine } from "./urlLastLine";
import { urlProvenance } from "./urlProvenance";

export const VALIDATORS: Validator[] = [
  shape,
  urlLastLine,
  urlProvenance,
  priceGrounding,
  noMarkdown,
  noCardEcho,
  bannedPhrases,
  noHandoffPromise,
  noTurnaroundWindow,
  noInternalTokens,
  noHumanClaim,
];

export function runValidators(reply: Reply, context: ValidationContext): Violation[] {
  return VALIDATORS.flatMap((validator) => validator(reply, context));
}

export function blocking(violations: readonly Violation[]): Violation[] {
  return violations.filter((violation) => violation.severity === "block");
}

export type { ValidationContext, Validator, Violation } from "./types";
