import type { Reply } from "../schema/reply";
import { noCardEcho } from "./noCardEcho";
import { noMarkdown } from "./noMarkdown";
import { priceGrounding } from "./priceGrounding";
import { shape } from "./shape";
import type { ValidationContext, Validator, Violation } from "./types";
import { urlLastLine } from "./urlLastLine";
import { urlProvenance } from "./urlProvenance";

export const VALIDATORS: Validator[] = [shape, urlLastLine, urlProvenance, priceGrounding, noMarkdown, noCardEcho];

export function runValidators(reply: Reply, context: ValidationContext): Violation[] {
  return VALIDATORS.flatMap((validator) => validator(reply, context));
}

export function blocking(violations: readonly Violation[]): Violation[] {
  return violations.filter((violation) => violation.severity === "block");
}

export type { ValidationContext, Validator, Violation } from "./types";
