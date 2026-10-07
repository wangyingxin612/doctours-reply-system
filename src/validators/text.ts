// Finding URLs and money amounts in free text.

const URL_ANYWHERE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const URL_LINE = /^(?:https?:\/\/|www\.)\S+$/i;

/** URLs as written, with sentence punctuation after them removed. */
export function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_ANYWHERE)].map((match) => match[0].replace(/[.,;:!?)\]]+$/, ""));
}

export function containsUrl(line: string): boolean {
  URL_ANYWHERE.lastIndex = 0;
  return URL_ANYWHERE.test(line);
}

/** True when the line is one URL and nothing else, not even a closing period. */
export function isUrlLine(line: string): boolean {
  const trimmed = line.trim();
  return URL_LINE.test(trimmed) && !/[.,;:!?)\]]$/.test(trimmed);
}

export interface MoneyMention {
  amount: number;
  /** ISO code when the text shows one, otherwise null. "$" alone does not name a currency. */
  currency: string | null;
  raw: string;
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?`;
const WORD_TO_CODE: Record<string, string> = {
  usd: "USD",
  eur: "EUR",
  gbp: "GBP",
  cad: "CAD",
  try: "TRY",
  mxn: "MXN",
  dollar: "USD",
  dollars: "USD",
  euro: "EUR",
  euros: "EUR",
  pound: "GBP",
  pounds: "GBP",
  lira: "TRY",
};
const SYMBOL_TO_CODE: Record<string, string | null> = { $: null, "€": "EUR", "£": "GBP" };
const CODES = "USD|EUR|GBP|CAD|TRY|MXN";

const SYMBOL_FIRST = new RegExp(String.raw`([$€£])\s?${NUMBER}\s?(k\b)?(?:\s?(${CODES})\b)?`, "gi");
const WORD_AFTER = new RegExp(
  String.raw`(?<![$€£\d.,])\b${NUMBER}\s?(k)?\s?(${CODES}|dollars?|euros?|pounds?|lira)\b`,
  "gi",
);
const CODE_FIRST = new RegExp(String.raw`\b(${CODES})\s?${NUMBER}\s?(k\b)?`, "gi");

function toAmount(whole: string, fraction: string | undefined, thousands: string | undefined): number {
  const value = Number(whole.replaceAll(",", "") + (fraction ?? ""));
  return thousands ? value * 1000 : value;
}

/** Every amount written as money: "$3,000", "$3k", "3,000 USD", "USD 3000", "500 dollars", "€2,600". */
export function extractMoney(text: string): MoneyMention[] {
  const mentions: MoneyMention[] = [];

  for (const match of text.matchAll(SYMBOL_FIRST)) {
    const [raw, symbol, whole, fraction, thousands, code] = match;
    mentions.push({
      amount: toAmount(whole ?? "0", fraction, thousands),
      currency: code?.toUpperCase() ?? SYMBOL_TO_CODE[symbol ?? "$"] ?? null,
      raw,
    });
  }
  for (const match of text.matchAll(WORD_AFTER)) {
    const [raw, whole, fraction, thousands, word] = match;
    mentions.push({
      amount: toAmount(whole ?? "0", fraction, thousands),
      currency: WORD_TO_CODE[(word ?? "").toLowerCase()] ?? null,
      raw,
    });
  }
  for (const match of text.matchAll(CODE_FIRST)) {
    const [raw, code, whole, fraction, thousands] = match;
    mentions.push({ amount: toAmount(whole ?? "0", fraction, thousands), currency: code?.toUpperCase() ?? null, raw });
  }
  return mentions;
}

const BARE_NUMBER = /(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|(?<![\w.])\d+(?:\.\d{1,2})?(k\b)?/gi;

/** Every number in the text, money or not. Used for amounts the patient wrote, who may omit the "$". */
export function extractNumbers(text: string): number[] {
  return [...text.matchAll(BARE_NUMBER)].map((match) => {
    const thousands = /k$/i.test(match[0]);
    const value = Number(match[0].replace(/k$/i, "").replaceAll(",", ""));
    return thousands ? value * 1000 : value;
  });
}
