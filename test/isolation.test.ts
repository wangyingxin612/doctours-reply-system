// Two guards against leaking the packet's answers into the system.
// 1. Isolation: nothing under src/ or skills/ reads from eval/ or docs/.
// 2. Leak: no packet test message and no sentence of an expected reply appears anywhere outside docs/ and eval/.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const SKIP_DIRS = new Set(["node_modules", ".git", "traces", "dist", "coverage"]);
const SKIP_FILES = new Set(["package-lock.json"]);

/** Not source: a key file, the lock file, or the file of replies the README's command writes. */
function skipped(name: string): boolean {
  return SKIP_FILES.has(name) || (name.startsWith(".env") && name !== ".env.example") || /^replies.*\.json$/.test(name);
}

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) filesUnder(path, out);
    } else if (!skipped(name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every file that is in the repository or could be added to it: tracked files, and untracked files
 * git does not ignore. What a run writes (replies, traces) is ignored by git and is not checked.
 * A good reply can share a sentence with an expected reply, and that is not a leak.
 * Outside a git checkout this falls back to walking the folder.
 */
function repositoryFiles(): string[] {
  try {
    const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = listed.split("\0").filter((path) => path !== "" && existsSync(path) && !skipped(basename(path)));
    if (files.length > 0) return files;
  } catch {
    // Not a git checkout, or no git on this machine.
  }
  return filesUnder(".");
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .trim();
}

describe("isolation", () => {
  const runtimeFiles = [...filesUnder("src"), ...filesUnder("skills"), ...filesUnder("config")];

  it("finds runtime files to check", () => {
    expect(runtimeFiles.length).toBeGreaterThan(10);
  });

  it("keeps src/, skills/ and config/ from referring to eval/", () => {
    const offenders = runtimeFiles.filter((path) => /\beval\//.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("keeps src/, skills/ and config/ from importing or reading docs/", () => {
    const reads = /(?:\bfrom\s+["'`]|\bimport\s*\(|\brequire\s*\(|readFile|readdir|createReadStream|\bjoin\s*\()[^\n]*\bdocs\b/;
    const offenders = runtimeFiles.filter((path) => reads.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("which files the leak check reads", () => {
  const files = repositoryFiles();

  it("reads the source, the skills and the tests", () => {
    expect(files).toEqual(expect.arrayContaining(["src/pipeline/guard.ts", "skills/hair/core/SKILL.md", "test/isolation.test.ts", "README.md"]));
  });

  it("leaves out what a run writes, the key file and installed packages", () => {
    expect(files.filter((path) => /^(traces|node_modules)\//.test(path))).toEqual([]);
    expect(files.filter((path) => /(^|\/)replies.*\.json$/.test(path) || /(^|\/)\.env$/.test(path))).toEqual([]);
    expect(skipped("replies.json")).toBe(true);
    expect(skipped(".env")).toBe(true);
    expect(skipped(".env.example")).toBe(false);
  });
});

describe("leak", () => {
  const messages = JSON.parse(readFileSync("eval/packet/messages.json", "utf8")) as Array<{ text: string }>;
  const expected = JSON.parse(readFileSync("eval/packet/expected.json", "utf8")) as Array<{
    response: string;
    escalationReason: string | null;
  }>;

  const sentences = expected
    .flatMap((reply) => [reply.response, reply.escalationReason ?? ""])
    .flatMap((text) => text.split(/(?<=[.!?])\s+|\n/))
    .filter((sentence) => !/^https?:/.test(sentence));

  const needles = [...messages.map((message) => message.text), ...sentences]
    .map(normalize)
    .filter((needle) => needle.split(" ").length >= 4);

  it("has the packet's wording to look for", () => {
    expect(messages).toHaveLength(5);
    expect(needles.length).toBeGreaterThanOrEqual(12);
  });

  it("finds no packet message or expected-reply sentence outside docs/ and eval/", () => {
    const checked = repositoryFiles().filter((path) => !/^(docs|eval)\//.test(path));
    const leaks: string[] = [];
    for (const path of checked) {
      const content = normalize(readFileSync(path, "utf8"));
      for (const needle of needles) {
        if (content.includes(needle)) leaks.push(`${path}: "${needle}"`);
      }
    }
    expect(checked.length).toBeGreaterThan(30);
    expect(leaks).toEqual([]);
  });
});
