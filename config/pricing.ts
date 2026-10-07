// US dollars per million tokens, from Anthropic's pricing page as read on 2026-10-07.
// Cache writes use the 5-minute rate, the only cache lifetime this system asks for.

export interface ModelPrice {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/** Matched by prefix, so a dated id such as claude-haiku-4-5-20251001 finds its price. */
const PRICES: Array<{ prefix: string; price: ModelPrice }> = [
  { prefix: "claude-sonnet-5-5", price: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 } },
  { prefix: "claude-haiku-4-5", price: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } },
];

export function priceFor(model: string): ModelPrice | null {
  return PRICES.find(({ prefix }) => model.startsWith(prefix))?.price ?? null;
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Cost of one model call in dollars, or null when the model has no price here. */
export function costOf(usage: TokenUsage): number | null {
  const price = priceFor(usage.model);
  if (price === null) return null;
  return (
    (usage.inputTokens * price.input +
      usage.cacheWriteTokens * price.cacheWrite +
      usage.cacheReadTokens * price.cacheRead +
      usage.outputTokens * price.output) /
    1_000_000
  );
}
