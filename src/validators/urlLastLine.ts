import { containsUrl, isUrlLine } from "./text";
import type { Validator, Violation } from "./types";

const NAME = "url_last_line";

/**
 * Every URL sits alone on a final line, with nothing after the URL lines.
 * The delivery service splits a message at each link, so a link inside a sentence becomes extra messages.
 */
export const urlLastLine: Validator = (reply) => {
  const violations: Violation[] = [];
  const lines = reply.response.split("\n");

  let sawUrlLine = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (isUrlLine(line)) {
      sawUrlLine = true;
      continue;
    }
    if (containsUrl(line)) {
      violations.push({
        validator: NAME,
        severity: "block",
        message:
          'A URL appears inside a sentence. Say "using the link below" in the text and put the URL alone on the last line.',
      });
    } else if (sawUrlLine) {
      violations.push({
        validator: NAME,
        severity: "block",
        message: "Text follows a URL line. URLs go at the very end, one per line, with nothing after them.",
      });
    }
  }
  return violations;
};
