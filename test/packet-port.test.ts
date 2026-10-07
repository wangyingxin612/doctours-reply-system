// Guards the claim "ported verbatim": the two packet.ts files must equal the packet's code blocks,
// with nothing changed except the added `export` keywords.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packet = readFileSync("docs/packet.md", "utf8").split("\n");

function codeBlockUnder(heading: string): string {
  const start = packet.indexOf(heading);
  if (start === -1) throw new Error(`heading not found: ${heading}`);
  const open = packet.findIndex((line, index) => index > start && line.startsWith("```"));
  const close = packet.findIndex((line, index) => index > open && line === "```");
  return packet.slice(open + 1, close).join("\n");
}

function portedBody(path: string): string {
  const lines = readFileSync(path, "utf8").split("\n");
  const firstCode = lines.findIndex((line) => line !== "" && !line.startsWith("//"));
  return lines
    .slice(firstCode)
    .join("\n")
    .replace(/^export /gm, "")
    .trimEnd();
}

describe("packet port", () => {
  it("keeps the constants identical to the packet", () => {
    expect(portedBody("src/context/packet.ts")).toBe(codeBlockUnder("### Constants"));
  });

  it("keeps the tool data and functions identical to the packet", () => {
    expect(portedBody("src/tools/packet.ts")).toBe(codeBlockUnder("### Tools"));
  });
});
