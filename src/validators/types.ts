import type { Reply } from "../schema/reply";
import type { MoneyFact } from "../tools/ledger";

export type Severity = "block" | "warn";

export interface Violation {
  validator: string;
  severity: Severity;
  /** Written so it can be fed back to the model in a repair attempt. */
  message: string;
}

/** Everything a validator may compare a reply against. Built by code for each message. */
export interface ValidationContext {
  /** URLs the reply may contain: tool results from this turn plus the loaded skills' static links. */
  allowedUrls: ReadonlySet<string>;
  /** URLs the link plan says the reply must contain. */
  requiredUrls: ReadonlySet<string>;
  /** The patient's own photo URLs returned this turn. Only these may be attached. */
  imageUrls: ReadonlySet<string>;
  /** Money amounts tools returned this turn. */
  money: readonly MoneyFact[];
  /** Real policy amounts declared by the loaded skills, for example the cancellation fee. */
  policyAmounts: readonly number[];
  /** The patient's message after redaction. Amounts the patient wrote may be repeated back. */
  patientText: string;
  /** Card data removed by the guard. Must never appear in any output field. */
  redactedTokens: readonly string[];
}

export type Validator = (reply: Reply, context: ValidationContext) => Violation[];

export const EMPTY_VALIDATION_CONTEXT: ValidationContext = {
  allowedUrls: new Set(),
  requiredUrls: new Set(),
  imageUrls: new Set(),
  money: [],
  policyAmounts: [],
  patientText: "",
  redactedTokens: [],
};
