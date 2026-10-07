import type { MoneyFact } from "../tools/ledger";
import { extractMoney, extractNumbers } from "./text";
import type { Validator, Violation } from "./types";

const NAME = "price_grounding";

/** Differences of two amounts for the same clinic: a remaining balance, or the gap between two tiers. */
function derivedAmounts(money: readonly MoneyFact[]): Set<number> {
  const byClinic = new Map<string, number[]>();
  for (const fact of money) {
    const key = fact.clinicName ?? "";
    byClinic.set(key, [...(byClinic.get(key) ?? []), fact.amount]);
  }
  const derived = new Set<number>();
  for (const amounts of byClinic.values()) {
    for (const a of amounts) {
      for (const b of amounts) {
        if (a > b) derived.add(a - b);
      }
    }
  }
  return derived;
}

/**
 * Every money amount in the reply must be one of:
 * an amount a tool returned this turn, a policy amount a loaded skill declares,
 * an amount the patient wrote, or an exact difference of two tool amounts for one clinic.
 */
export const priceGrounding: Validator = (reply, context) => {
  const violations: Violation[] = [];

  const fromTools = new Set(context.money.map((fact) => fact.amount));
  const grounded = new Set<number>([
    ...fromTools,
    ...context.policyAmounts,
    ...extractNumbers(context.patientText),
    ...derivedAmounts(context.money),
  ]);
  const toolCurrencies = new Set(context.money.map((fact) => fact.currency).filter((code) => code !== null));

  const seen = new Set<string>();
  for (const mention of extractMoney(reply.response)) {
    if (seen.has(mention.raw)) continue;
    seen.add(mention.raw);

    if (!grounded.has(mention.amount)) {
      const known = [...fromTools].sort((a, b) => a - b).join(", ") || "none";
      violations.push({
        validator: NAME,
        severity: "block",
        message: `The amount "${mention.raw.trim()}" is not in this turn's tool data. Amounts the tools returned: ${known}. State only those, or say you don't have the figure.`,
      });
    } else if (
      mention.currency !== null &&
      fromTools.has(mention.amount) &&
      toolCurrencies.size > 0 &&
      !toolCurrencies.has(mention.currency)
    ) {
      violations.push({
        validator: NAME,
        severity: "block",
        message: `"${mention.raw.trim()}" uses ${mention.currency}, but the tool returned ${[...toolCurrencies].join(", ")}. Quote the tool's currency.`,
      });
    }
  }
  return violations;
};
