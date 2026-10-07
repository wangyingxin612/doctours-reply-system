// Every line of prompt text that we wrote lives in this folder. Skills hold only the original prompt's text.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

export type PromptName = "router.md" | "responder-frame.md" | "repair.md" | "call-history.md" | "user-message.txt";

export const PROMPT_NAMES: PromptName[] = [
  "router.md",
  "responder-frame.md",
  "repair.md",
  "call-history.md",
  "user-message.txt",
];

const cache = new Map<PromptName, string>();

export function loadPrompt(name: PromptName): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(join(PROMPTS_DIR, name), "utf8").trimEnd();
    cache.set(name, text);
  }
  return text;
}

/** Replaces each {{NAME}} with its value. A placeholder with no value is an error, not an empty string. */
export function fillPrompt(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`No value for prompt placeholder ${placeholder}`);
    return value;
  });
}
