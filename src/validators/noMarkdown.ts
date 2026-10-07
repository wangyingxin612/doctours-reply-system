import type { Validator, Violation } from "./types";

const NAME = "no_markdown";

// The reply goes out as SMS. The patient sees the raw characters.
const RULES: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\*\*[^*\n]+\*\*/, what: "bold markers (**)" },
  { pattern: /__[^_\n]+__/, what: "bold markers (__)" },
  { pattern: /(?<![\w*])\*(?![\s*])[^*\n]+(?<![\s*])\*(?![\w*])/, what: "italic markers (*)" },
  { pattern: /(?<![\w_])_(?![\s_])[^_\n]+(?<![\s_])_(?![\w_])/, what: "italic markers (_)" },
  { pattern: /^\s{0,3}#{1,6}\s/m, what: "a header (#)" },
  { pattern: /^\s*[-*+•]\s+\S/m, what: "a bulleted list" },
  { pattern: /^\s*\d+[.)]\s+\S/m, what: "a numbered list" },
  { pattern: /`[^`\n]+`/, what: "code formatting (`)" },
  { pattern: /\[[^\]\n]+\]\([^)\n]+\)/, what: "a markdown link" },
];

export const noMarkdown: Validator = (reply) => {
  const violations: Violation[] = [];
  for (const { pattern, what } of RULES) {
    if (pattern.test(reply.response)) {
      violations.push({
        validator: NAME,
        severity: "block",
        message: `The reply uses ${what}. Write plain sentences with no markdown.`,
      });
    }
  }
  return violations;
};
