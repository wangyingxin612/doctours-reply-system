import type { Validator, Violation } from "./types";

const NAME = "no_card_echo";

function stringsIn(node: unknown, out: string[]): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const child of node) stringsIn(child, out);
  else if (node !== null && typeof node === "object") for (const child of Object.values(node)) stringsIn(child, out);
  return out;
}

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** None of the card data the guard removed may appear in any output field, in any spacing. */
export const noCardEcho: Validator = (reply, context) => {
  const violations: Violation[] = [];
  const fields = stringsIn(reply, []);

  if (fields.some((field) => /\[(?:card number|digits|code|date) removed\]/i.test(field))) {
    violations.push({
      validator: NAME,
      severity: "block",
      message: "The reply repeats a marker that stands for removed card data. Leave the card details out entirely.",
    });
  }

  for (const token of context.redactedTokens) {
    const digits = digitsOf(token);
    if (digits.length < 3) continue;

    const echoed = fields.some((field) =>
      digits.length >= 8
        ? // A full number: compare digit runs, so regrouping the digits does not hide it.
          digitsOf(field).includes(digits)
        : // A short code such as last-four digits: match it as a whole number only.
          new RegExp(String.raw`(?<!\d)${digits}(?!\d)`).test(field),
    );
    if (echoed) {
      violations.push({
        validator: NAME,
        severity: "block",
        // The message never repeats the token itself.
        message: "The reply repeats card data from the patient's message. Remove every card digit.",
      });
      break;
    }
  }
  return violations;
};
