// Builds skills/ from the original system prompt in docs/packet.md.
// Run with: npm run split
//
// Each skill is a list of line numbers from docs/packet.md. A line is copied whole, or with text
// deleted from it (`from`, `to`, `cut`). Nothing is ever added or reworded, so every word in a
// skill body comes from the original prompt. test/skills/provenance.test.ts rebuilds the skills
// from this file and fails if the committed files differ.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Trim {
  /** Keep from the first occurrence of this text, inclusive. */
  from?: string;
  /** Keep up to the first occurrence of this text, inclusive. */
  to?: string;
  /** Delete these exact pieces of text. */
  cut?: string[];
  /** Delete from the first marker through the next occurrence of the second marker. */
  cutBetween?: [string, string];
}

/** A packet line number, a blank line (""), or a line number with deletions. */
type Part = number | "" | [number, Trim];

interface SkillSpec {
  name: string;
  description: string;
  loadedBy: "always" | "status" | "router" | "code";
  status?: string;
  /** Tools the responder may call when this skill is loaded. */
  tools?: string[];
  /** The subset of tools that code runs up front. */
  prefetch?: string[];
  staticLinks?: string[];
  policyAmounts?: number[];
  version: number;
  /** Sections of the original prompt this skill came from. */
  source: string[];
  parts: Part[];
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

export const VERTICAL = "hair";

export const SKILL_SPECS: SkillSpec[] = [
  {
    name: "core",
    description: "Identity, voice, plain-text SMS rules, grounding, and the output fields. Always loaded.",
    loadedBy: "always",
    version: 1,
    source: [
      "IDENTITY",
      "OBJECTIVE",
      "RESPONSE MODE (CRITICAL)",
      "VOICE (SINGLE COMMUNICATOR)",
      "CONVERSATION AWARENESS",
      "CAPABILITIES & CONSTRAINTS",
      "BUSINESS POLICY GROUNDING (HARD RULE)",
      "GUIDELINES",
      "SPECIFICITY — RARELY USE VAGUE REFERENCES",
      "STRUCTURED OUTPUT FIELDS",
      "Workflow prompt (thread line, identity answer)",
    ],
    parts: [
      ...range(764, 767),
      "",
      ...range(769, 771),
      "",
      777,
      778,
      "",
      780,
      [781, { to: "do NOT nudge toward the deposit." }],
      [786, { from: "Outside these exceptions" }],
      "",
      ...range(876, 879),
      "",
      881,
      884,
      885,
      891,
      892,
      "",
      894,
      895,
      [896, { to: "in a future message." }],
      [897, { to: "track a document yourself." }],
      ...range(898, 900),
      [902, { to: "the ops team arranges ground logistics." }],
      ...range(904, 906),
      "",
      ...range(910, 912),
      [913, { to: "implies a capability you do not have." }],
      914,
      "",
      916,
      920,
      "",
      927,
      "",
      ...range(929, 931),
      936,
      "",
      991,
      992,
      993,
      // The example question inside this sentence repeats a packet test message, so it is deleted. The rule stays.
      [994, { cutBetween: [' ("is the ', '?")'] }],
      995,
      997,
      998,
      ...range(1001, 1003),
      [1005, { to: "in the order they are mentioned." }],
      "",
      ...range(1008, 1014),
      "",
      1019,
      1020,
      ...range(1022, 1025),
      "",
      1507,
      1512,
    ],
  },
  {
    name: "stage-pre-clinical-sent",
    description: "The decision stage: the patient has their assessment and clinic recommendations.",
    loadedBy: "status",
    status: "PRE_CLINICAL_SENT",
    version: 1,
    source: [
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT (intro, got-it rule, Pacing)",
      "OPERATIONAL KNOWLEDGE 1 (the goal)",
      "CONVERSATION AWARENESS (never re-ask a question verbatim)",
    ],
    parts: [1264, 1265, "", 1267, "", 1324, "", 1426, 1427, "", ...range(887, 890)],
  },
  {
    name: "clinic-packages",
    description:
      "What a clinic's packages are and cost: package names, prices, deposits, what is included, hotel nights, and which part of the surgery the doctor performs.",
    loadedBy: "router",
    tools: ["getClinicPackagesTool", "getClinicDoctorsTool", "getAllClinicsTool"],
    prefetch: ["getClinicPackagesTool"],
    version: 1,
    source: [
      "PACKAGE & CLINIC FACTS — TOOL-GROUNDED ONLY (HARD)",
      "OPERATIONAL KNOWLEDGE 9 (pricing)",
      "TOOL USAGE (getClinicPackagesTool, getClinicDoctorsTool)",
    ],
    parts: [
      960,
      961,
      "",
      963,
      ...range(965, 971),
      981,
      "",
      983,
      "",
      // Line 989, the hair-type example, repeats a packet expected reply and is left out.
      ...range(985, 988),
      "",
      1456,
      [1412, { to: "which airport to fly into, or which hotel they stay at." }],
      1413,
    ],
  },
  {
    name: "clinic-specialty",
    description:
      "Whether a clinic suits a hair type or need: afro, 4C, curly or textured hair, a clinic's speciality and practice type, its doctors, and which procedure areas clinics handle.",
    loadedBy: "router",
    tools: ["getAllClinicsTool", "getClinicDoctorsTool"],
    prefetch: ["getAllClinicsTool"],
    version: 1,
    source: [
      "PACKAGE & CLINIC FACTS (hair type is a clinic_flags fact)",
      "Clinic flags (workflow prompt)",
      "OPERATIONAL KNOWLEDGE 2 and 4",
      "TOOL USAGE (getAllClinicsTool, getClinicDoctorsTool)",
    ],
    parts: [
      964,
      "",
      1518,
      1519,
      "",
      1430,
      [1435, { from: "Use the Clinic flags section" }],
      [1416, { to: "Package names are not capability." }],
      1413,
    ],
  },
  {
    name: "payment-deposit",
    description:
      "How and where to pay the deposit: paying from the assessment, payment and checkout links, accepted payment methods, what the deposit covers, and a deposit paid directly to a clinic.",
    loadedBy: "router",
    tools: ["getLatestAssessmentTool", "getPatientContextTool", "getClinicPackagesTool", "getAllClinicsTool"],
    prefetch: ["getLatestAssessmentTool", "getPatientContextTool"],
    version: 1,
    source: [
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 0 (pay from the assessment) and Step 3",
      "OPERATIONAL KNOWLEDGE 6 (payment and deposits, the two links)",
      "CAPABILITIES & CONSTRAINTS (allowed and expected)",
      "DEPOSIT ELIGIBILITY RULE (CRITICAL)",
    ],
    parts: [
      1271,
      1272,
      "",
      ...range(1308, 1319),
      "",
      [1439, { to: "the bullet below governs what you say about that balance." }],
      1440,
      1441,
      ...range(1446, 1449),
      "",
      908,
      "",
      ...range(1030, 1036),
    ],
  },
  {
    name: "consultation",
    description:
      "The free consultation call: its cost and format, who it is with, booking or rescheduling it, and requests for any other kind of call.",
    loadedBy: "router",
    tools: ["getConsultationRescheduleLinkTool", "getFullCallsTool"],
    prefetch: ["getConsultationRescheduleLinkTool"],
    staticLinks: ["https://www.doctours.com/consultation"],
    version: 1,
    source: [
      "OPERATIONAL KNOWLEDGE 8 (consultations)",
      "CONSULTATION RESCHEDULING",
      "PHONE CONTACT",
      "TOOL USAGE (getConsultationRescheduleLinkTool, getFullCallsTool)",
      "BUSINESS POLICY GROUNDING (consultation format example)",
    ],
    parts: [...range(1453, 1455), "", ...range(1362, 1367), "", 1406, 1407, "", 1420, 1421, "", 946],
  },
];

function applyTrim(line: string, trim: Trim, lineNumber: number): string {
  let text = line;
  if (trim.from !== undefined) {
    const start = text.indexOf(trim.from);
    if (start === -1) throw new Error(`line ${lineNumber}: "from" text not found: ${trim.from}`);
    text = text.slice(start);
  }
  if (trim.to !== undefined) {
    const end = text.indexOf(trim.to);
    if (end === -1) throw new Error(`line ${lineNumber}: "to" text not found: ${trim.to}`);
    text = text.slice(0, end + trim.to.length);
  }
  for (const piece of trim.cut ?? []) {
    if (!text.includes(piece)) throw new Error(`line ${lineNumber}: "cut" text not found: ${piece}`);
    text = text.replace(piece, "");
  }
  if (trim.cutBetween !== undefined) {
    const [open, close] = trim.cutBetween;
    const start = text.indexOf(open);
    const end = start === -1 ? -1 : text.indexOf(close, start + open.length);
    if (end === -1) throw new Error(`line ${lineNumber}: "cutBetween" markers not found: ${open} ... ${close}`);
    text = text.slice(0, start) + text.slice(end + close.length);
  }
  return text;
}

function inlineList(values: readonly (string | number)[]): string {
  return `[${values.join(", ")}]`;
}

export function renderSkill(spec: SkillSpec, packetLines: readonly string[]): string {
  const body = spec.parts.map((part) => {
    if (part === "") return "";
    const [lineNumber, trim] = typeof part === "number" ? [part, {}] : part;
    const line = packetLines[lineNumber - 1];
    if (line === undefined) throw new Error(`${spec.name}: packet has no line ${lineNumber}`);
    return applyTrim(line, trim, lineNumber);
  });

  const frontmatter = [
    "---",
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    `loadedBy: ${spec.loadedBy}`,
    ...(spec.status ? [`status: ${spec.status}`] : []),
    `tools: ${inlineList(spec.tools ?? [])}`,
    `prefetch: ${inlineList(spec.prefetch ?? [])}`,
    `staticLinks: ${inlineList(spec.staticLinks ?? [])}`,
    `policyAmounts: ${inlineList(spec.policyAmounts ?? [])}`,
    `version: ${spec.version}`,
    "source:",
    ...spec.source.map((section) => `  - ${section}`),
    "---",
  ];
  return `${[...frontmatter, "", ...body].join("\n")}\n`;
}

export function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function readPacketLines(root = projectRoot()): string[] {
  return readFileSync(join(root, "docs", "packet.md"), "utf8").split("\n");
}

export function skillPath(name: string, root = projectRoot()): string {
  return join(root, "skills", VERTICAL, name, "SKILL.md");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packetLines = readPacketLines();
  for (const spec of SKILL_SPECS) {
    const path = skillPath(spec.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSkill(spec, packetLines));
    console.log(`wrote ${path}`);
  }
}
