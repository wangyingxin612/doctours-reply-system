// Loads skills/<vertical>/<name>/SKILL.md: frontmatter that code reads, and a body the model reads.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PatientContext } from "../context/types";
import { isModelCallable, isToolName, TOOL_REGISTRY, type ToolDefinition, type ToolName } from "../tools/registry";

const SKILLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

const frontmatterSchema = z.strictObject({
  name: z.string().min(1),
  /** One line. The router picks skills from these descriptions and never sees the bodies. */
  description: z.string().min(1),
  /** always: every turn. status: by pipeline status. router: when the router selects it. code: when code decides. */
  loadedBy: z.enum(["always", "status", "router", "code"]),
  status: z.string().optional(),
  /** Tools the responder may call while this skill is loaded. */
  tools: z.array(z.string()),
  /** Tools code runs up front when this skill is loaded. A clinic tool with no clinic named runs for each recommended clinic. */
  prefetch: z.array(z.string()),
  /** Clinic tools code runs up front only for the clinics the message names. Keeps unasked-for facts out of the prompt. */
  prefetchNamed: z.array(z.string()),
  staticLinks: z.array(z.string()),
  /** Real policy amounts in the body. The price validator accepts these and no other amount from a skill. */
  policyAmounts: z.array(z.number()),
  version: z.number(),
  /** Sections of the original prompt the body came from. */
  source: z.array(z.string()).min(1),
});

export interface Skill extends Omit<z.infer<typeof frontmatterSchema>, "tools" | "prefetch" | "prefetchNamed"> {
  tools: ToolName[];
  prefetch: ToolName[];
  prefetchNamed: ToolName[];
  body: string;
  /** The whole file, for the policy version hash. */
  raw: string;
}

function parseValue(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => parseValue(item.trim()));
  }
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

/** A small subset of YAML: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
function parseFrontmatter(lines: readonly string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;

  for (const line of lines) {
    if (line.startsWith("  - ")) {
      if (listKey === null) throw new Error(`list item without a key: ${line}`);
      (data[listKey] as unknown[]).push(line.slice(4).trim());
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`not a "key: value" line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (value === "") {
      data[key] = [];
      listKey = key;
    } else {
      data[key] = parseValue(value);
      listKey = null;
    }
  }
  return data;
}

export function parseSkill(raw: string, path: string): Skill {
  const lines = raw.split("\n");
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close === -1) throw new Error(`${path}: missing frontmatter`);

  const parsed = frontmatterSchema.safeParse(parseFrontmatter(lines.slice(1, close)));
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  const frontmatter = parsed.data;

  for (const name of [...frontmatter.tools, ...frontmatter.prefetch, ...frontmatter.prefetchNamed]) {
    if (!isToolName(name)) throw new Error(`${path}: unknown tool "${name}"`);
  }
  const tools = frontmatter.tools as ToolName[];
  const prefetch = [...frontmatter.prefetch, ...frontmatter.prefetchNamed] as ToolName[];
  const prefetchNamed = frontmatter.prefetchNamed as ToolName[];

  const notCallable = tools.filter((name) => !isModelCallable(name));
  if (notCallable.length > 0) throw new Error(`${path}: the model may not call ${notCallable.join(", ")}`);
  const writes = prefetch.filter((name) => (TOOL_REGISTRY[name] as ToolDefinition).kind !== "read");
  if (writes.length > 0) throw new Error(`${path}: prefetch may only read, not ${writes.join(", ")}`);
  if (frontmatter.loadedBy === "status" && !frontmatter.status) throw new Error(`${path}: a stage skill needs a status`);

  return {
    ...frontmatter,
    tools,
    prefetch: frontmatter.prefetch as ToolName[],
    prefetchNamed,
    body: lines.slice(close + 1).join("\n").trim(),
    raw,
  };
}

export interface SkillSet {
  vertical: string;
  skills: Skill[];
  core: Skill;
  get(name: string): Skill;
  has(name: string): boolean;
  /** The stage skill for a pipeline status, or null when the vertical has none for it. */
  stage(status: string): Skill | null;
  /** Skills the router may select. */
  routable: Skill[];
}

const cache = new Map<string, SkillSet>();

export function loadSkills(vertical: string, root: string = SKILLS_ROOT): SkillSet {
  const cacheKey = `${root}:${vertical}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const dir = join(root, vertical);
  if (!existsSync(dir)) throw new Error(`No skills folder for vertical "${vertical}" at ${dir}`);

  const skills = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name, "SKILL.md"))
    .filter((path) => existsSync(path))
    .sort()
    .map((path) => parseSkill(readFileSync(path, "utf8"), path));

  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const core = byName.get("core");
  if (!core) throw new Error(`Vertical "${vertical}" has no core skill`);

  const set: SkillSet = {
    vertical,
    skills,
    core,
    get(name) {
      const skill = byName.get(name);
      if (!skill) throw new Error(`Unknown skill "${name}" in vertical "${vertical}"`);
      return skill;
    },
    has: (name) => byName.has(name),
    stage: (status) => skills.find((skill) => skill.loadedBy === "status" && skill.status === status) ?? null,
    routable: skills.filter((skill) => skill.loadedBy === "router"),
  };
  cache.set(cacheKey, set);
  return set;
}

const GATE_OPEN = /^<!-- when ([a-z]+)=([a-z_]+) -->$/;
const GATE_CLOSE = "<!-- end -->";

/** Patient flags a skill may gate a block on. Code knows them, so the model never has to pick a branch. */
export function patientFlags(context: PatientContext): Record<string, string> {
  return { financing: context.patient.financingEligible };
}

/**
 * The text of a skill for one patient: gated blocks are kept only when their flag matches, and the
 * placeholders the original prompt used are filled. Unknown placeholders are left as written.
 */
export function renderSkillBody(skill: Skill, context: PatientContext): string {
  const flags = patientFlags(context);
  const kept: string[] = [];
  let keeping = true;

  for (const line of skill.body.split("\n")) {
    const gate = GATE_OPEN.exec(line);
    if (gate) {
      const [, flag, value] = gate;
      if (flag === undefined || !(flag in flags)) throw new Error(`${skill.name}: unknown flag in "${line}"`);
      keeping = flags[flag] === value;
    } else if (line === GATE_CLOSE) {
      keeping = true;
    } else if (keeping) {
      kept.push(line);
    }
  }
  return kept.join("\n").replaceAll("{{COORDINATOR_DISPLAY_NAME}}", context.coordinatorName);
}
