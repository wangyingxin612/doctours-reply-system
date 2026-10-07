// Skills may only contain words from the original prompt. Two independent checks:
// 1. Each committed SKILL.md equals what scripts/split-prompt.ts builds from docs/packet.md.
// 2. Each body line is a line of the original prompt with text deleted, never added or reordered.

import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATE_CLOSE,
  GATE_OPEN,
  readPacketLines,
  renderSkill,
  SECTIONS_OUTSIDE_SKILLS,
  SKILL_SPECS,
  skillPath,
  usedPacketLines,
} from "../../scripts/split-prompt";

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
      // Gate markers are the one thing in a skill body that is ours. They hold no rule text.
      if (GATE_OPEN.test(line) || line === GATE_CLOSE) continue;
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      if (!promptLines.some((promptLine) => isSubsequence(words, promptLine))) added.push(line);
    }
    expect(added).toEqual([]);
  });
});

describe("coverage of the original prompt", () => {
  // A section runs from one heading to the next. The working-memory block has no markdown heading.
  const isHeading = (line: string) => /^#{1,3} /.test(line) || line === "WORKING_MEMORY_SYSTEM_INSTRUCTION:";
  const promptEnd = packetLines.findIndex((line, index) => index > promptStart + 2 && line === "```");
  const used = usedPacketLines();

  const sections: Array<{ heading: string; usedBySkill: boolean; hasContent: boolean }> = [];
  for (let index = promptStart + 3; index < promptEnd; index += 1) {
    const line = packetLines[index] ?? "";
    if (isHeading(line)) {
      sections.push({ heading: line, usedBySkill: false, hasContent: false });
    } else if (line.trim() !== "") {
      const current = sections.at(-1);
      if (!current) continue;
      current.hasContent = true;
      if (used.has(index + 1)) current.usedBySkill = true;
    }
  }

  it("finds the sections of the original prompt", () => {
    expect(sections.length).toBeGreaterThan(45);
    expect(sections[0]?.heading).toBe("# IDENTITY");
  });

  it("accounts for every section: a skill uses it, or the list says why none does", () => {
    const unaccounted = sections
      .filter((section) => section.hasContent && !section.usedBySkill && !(section.heading in SECTIONS_OUTSIDE_SKILLS))
      .map((section) => section.heading);
    expect(unaccounted).toEqual([]);
  });

  it("lists only real sections that no skill uses", () => {
    for (const heading of Object.keys(SECTIONS_OUTSIDE_SKILLS)) {
      const section = sections.find((candidate) => candidate.heading === heading);
      expect(section, heading).toBeDefined();
      expect(section?.usedBySkill, heading).toBe(false);
    }
  });
});
