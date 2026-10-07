// Skills may only contain words from the original prompt. Two independent checks:
// 1. Each committed SKILL.md equals what scripts/split-prompt.ts builds from docs/packet.md.
// 2. Each body line is a line of the original prompt with text deleted, never added or reordered.

import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { readPacketLines, renderSkill, SKILL_SPECS, skillPath } from "../../scripts/split-prompt";

const packetLines = readPacketLines();
const promptStart = packetLines.indexOf("### System prompt");
const promptLines = packetLines.slice(promptStart).map((line) => line.trim().split(/\s+/));

function isSubsequence(words: readonly string[], of: readonly string[]): boolean {
  let position = 0;
  for (const word of of) {
    if (word === words[position]) position += 1;
    if (position === words.length) return true;
  }
  return words.length === 0;
}

function bodyOf(file: string): string[] {
  const lines = file.split("\n");
  return lines.slice(lines.indexOf("---", 1) + 1);
}

describe("skill provenance", () => {
  it.each(SKILL_SPECS.map((spec) => [spec.name, spec] as const))("%s is exactly what the split script builds", (name, spec) => {
    expect(readFileSync(skillPath(name), "utf8")).toBe(renderSkill(spec, packetLines));
  });

  it("has a spec for every skill folder, and a folder for every spec", () => {
    const folders = readdirSync(dirname(dirname(skillPath("core")))).sort();
    expect(folders).toEqual(SKILL_SPECS.map((spec) => spec.name).sort());
  });

  it.each(SKILL_SPECS.map((spec) => spec.name))("%s adds no words to the original prompt", (name) => {
    const added: string[] = [];
    for (const line of bodyOf(readFileSync(skillPath(name), "utf8"))) {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      if (!promptLines.some((promptLine) => isSubsequence(words, promptLine))) added.push(line);
    }
    expect(added).toEqual([]);
  });
});
