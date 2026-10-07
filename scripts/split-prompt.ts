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

/** Lines shown only when a patient flag has a given value, for example "financing=yes". */
interface Gate {
  when: string;
  parts: Part[];
}

/** A packet line number, a blank line (""), a line number with deletions, or a gated group of parts. */
type Part = number | "" | [number, Trim] | Gate;

export const GATE_OPEN = /^<!-- when ([a-z]+)=([a-z_]+) -->$/;
export const GATE_CLOSE = "<!-- end -->";

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
      1422,
      1423,
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
  {
    name: "package-choice",
    description:
      "Choosing between packages or add-ons at one clinic: what matters for the result and what is optional, comparing tiers, extra hotel nights, and the patient's package choice.",
    loadedBy: "router",
    tools: ["getClinicPackagesTool", "getPatientContextTool"],
    prefetch: ["getClinicPackagesTool", "getPatientContextTool"],
    version: 1,
    source: [
      "WHAT MATTERS vs NICE TO HAVE — DO NOT LET PATIENTS OVER-BUY",
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 2",
    ],
    parts: [...range(1212, 1246), "", ...range(1299, 1306)],
  },
  {
    name: "clinic-selection",
    description:
      "Choosing a clinic: comparing or recommending clinics, a patient torn between clinics, a clinic outside their recommended list, a preferred country or city, and why to book through Doctours.",
    loadedBy: "router",
    tools: [
      "getSavedClinicsTool",
      "getAllClinicsTool",
      "getClinicPackagesTool",
      "getClinicDoctorsTool",
      "getPatientContextTool",
    ],
    prefetch: ["getSavedClinicsTool", "getPatientContextTool", "getClinicPackagesTool"],
    version: 1,
    source: [
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 1",
      "CLINIC STATUS TIERS (clinic.ai_context.status)",
      "OPERATIONAL KNOWLEDGE 4 and 7",
      "TOOL USAGE (getPatientContextTool, getSavedClinicsTool)",
    ],
    parts: [...range(1276, 1297), "", ...range(1369, 1385), "", 1435, 1452, "", 1410, 1411],
  },
  {
    name: "deposit-terms",
    description:
      "Deposit terms and changing your mind: refunds and the cancellation fee, the lock-in date, moving the deposit to another package or clinic, the price lock, how a date gets confirmed, and whether a choice is final.",
    loadedBy: "router",
    policyAmounts: [25],
    version: 1,
    source: [
      "REVERSIBILITY — TAKE THE WEIGHT OFF THE DECISION",
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 3 (deposit terms)",
      "OPERATIONAL KNOWLEDGE 5 and 6 (refund, transfer, price lock, date confirmation)",
      "BUSINESS POLICY GROUNDING (date locking example)",
    ],
    parts: [
      ...range(1134, 1168),
      "",
      1320,
      [1439, { from: "Until the deposit lock-in date" }],
      1444,
      1438,
      "",
      945,
    ],
  },
  {
    name: "financing-insurance",
    description:
      "Paying over time and insurance: financing, instalments, monthly payments, Klarna, PayPal, layaway, health insurance, Medicare, HSA or FSA, CareCredit and Cherry.",
    loadedBy: "router",
    version: 1,
    source: [
      "FINANCING GEOGRAPHY (HARD RULE — Klarna/PayPal)",
      "HEALTH INSURANCE (HARD RULE)",
      "CARECREDIT / CHERRY (HARD RULE)",
      "OPERATIONAL KNOWLEDGE 6 (insurance, CareCredit, Klarna account holder, balance options, layaway)",
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 3 (financing)",
      "BUSINESS POLICY GROUNDING (financing schedules and examples)",
    ],
    // Each of the three rules has a yes, a no and an unknown branch. Code knows the patient's flag,
    // so the model only ever sees the branch that applies.
    parts: [
      ...range(809, 812),
      "",
      { when: "financing=yes", parts: [814] },
      { when: "financing=no", parts: [815] },
      { when: "financing=unknown", parts: [816] },
      817,
      "",
      ...range(821, 828),
      "",
      { when: "financing=yes", parts: [830] },
      { when: "financing=no", parts: [831] },
      { when: "financing=unknown", parts: [832] },
      ...range(833, 838),
      "",
      ...range(842, 849),
      "",
      { when: "financing=yes", parts: [851] },
      { when: "financing=no", parts: [852] },
      { when: "financing=unknown", parts: [853] },
      ...range(854, 858),
      "",
      1442,
      1443,
      { when: "financing=yes", parts: [1445] },
      1450,
      1451,
      1321,
      "",
      932,
      "",
      938,
      940,
      { when: "financing=no", parts: [941] },
      942,
      943,
    ],
  },
  {
    name: "assessment",
    description:
      "The patient's assessment: what it contains, the graft estimate, hairline planning, getting its link again, asking to change the hairline or plan, adding a note, and when an assessment will be ready.",
    loadedBy: "router",
    tools: ["getLatestAssessmentTool", "getSavedClinicsTool", "getPatientContextTool"],
    prefetch: ["getLatestAssessmentTool"],
    version: 1,
    source: [
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 0",
      "OPERATIONAL KNOWLEDGE 3 (assessment, revisions)",
      "CAPABILITIES & CONSTRAINTS (assessment edits and notes)",
      "GUIDELINES (no assessment turnaround promises)",
      "TOOL USAGE (getLatestAssessmentTool)",
    ],
    parts: [1269, 1270, 1273, 1274, "", ...range(1431, 1434), "", 895, 901, "", 916, 918, "", 1000, 1418],
  },
  {
    name: "photos-intake",
    description:
      "Intake photos: how to upload them and which angles, confirming they arrived, upload trouble, sending photos by text, getting their own photos back, why the back photo is needed, and delays such as a weave, braids or a shaved head.",
    loadedBy: "router",
    tools: ["getPatientImagesTool"],
    prefetch: ["getPatientImagesTool"],
    staticLinks: ["https://www.doctours.com/image-upload"],
    version: 1,
    source: [
      "IMAGE GUIDANCE",
      "IMAGE DELAY HANDLING",
      "CAPABILITIES & CONSTRAINTS (attaching the patient's own photos)",
      "TOOL USAGE (getPatientImagesTool)",
    ],
    parts: [...range(1101, 1132), "", ...range(1344, 1360), "", 895, 896, "", 1417],
  },
  {
    name: "pause-followup",
    description:
      "A patient who is stepping back: needs time, is still thinking or reviewing, is saving money, is waiting on something, or asks us to check back later.",
    loadedBy: "router",
    version: 1,
    source: ["TIME-BOUND PAUSE — NEVER OPEN-ENDED", "GUIDELINES (confirming a requested follow-up)"],
    parts: [...range(1170, 1210), "", 996],
  },
  {
    name: "dates-availability",
    description:
      "Dates and availability: when the procedure can be booked, which weekdays a package runs, busy months, how a date is requested and confirmed, and the timing the patient has in mind.",
    loadedBy: "router",
    tools: ["getClinicPackagesTool", "getPatientContextTool"],
    prefetch: ["getClinicPackagesTool", "getPatientContextTool"],
    version: 1,
    source: [
      "OPERATIONAL KNOWLEDGE 5 (scheduling) and 10 (availability)",
      "TOOL USAGE (tentative procedure dates, bookable weekdays, getPatientContextTool)",
      "GUIDELINES (weekday and date pairings)",
      "CAPABILITIES & CONSTRAINTS (date hold and availability examples)",
    ],
    parts: [
      ...range(1436, 1438),
      ...range(1457, 1460),
      "",
      1415,
      1006,
      [1412, { from: "Bookable days are a PACKAGE property", to: "never as a single fact about the clinic." }],
      1410,
      "",
      916,
      921,
      922,
    ],
  },
  {
    name: "travel",
    description:
      "Travel and logistics: flights and help finding them, when to arrive and how long to stay, passports, airports, hotels and hotel upgrades, staying at your own hotel, and transfers.",
    loadedBy: "router",
    tools: ["getClinicPackagesTool"],
    prefetch: ["getClinicPackagesTool"],
    version: 1,
    source: [
      "TRAVEL READINESS (passport / logistics)",
      "OPERATIONAL KNOWLEDGE 1 (flight help, travel timing)",
      "PACKAGE & CLINIC FACTS (own hotel and transport, hotels, passport)",
      "TOOL USAGE (airports, hotels)",
      "CAPABILITIES & CONSTRAINTS (flights before a deposit)",
      "BUSINESS POLICY GROUNDING (drive times, transfer coverage)",
    ],
    parts: [
      ...range(1397, 1404),
      "",
      1428,
      1429,
      "",
      972,
      ...range(973, 976),
      978,
      "",
      [
        1412,
        {
          from: "Follow each hotel list description",
          cutBetween: ["Bookable days are a PACKAGE property", "never as a single fact about the clinic. "],
        },
      ],
      [902, { from: "Pre-deposit, you cannot search", to: "then give interim browse guidance." }],
      "",
      934,
      935,
      "",
      938,
      948,
      949,
      951,
      952,
    ],
  },
  {
    name: "clinic-website-contact",
    description:
      "A clinic's website or page, and reaching a clinic: asking for a clinic's site or link, its phone number, WhatsApp or email, or whether the patient can message the clinic.",
    loadedBy: "router",
    tools: ["getAllClinicsTool", "getSavedClinicsTool"],
    prefetch: ["getAllClinicsTool"],
    version: 1,
    source: [
      "CLINIC WEBSITE (HARD RULE)",
      "PACKAGE & CLINIC FACTS (can they message the clinic themselves)",
      "CAPABILITIES & CONSTRAINTS (contacting the clinic example)",
      "TOOL USAGE (getAllClinicsTool: slug and url)",
      "OPERATIONAL KNOWLEDGE 11 (clinic pages)",
    ],
    parts: [
      ...range(862, 873),
      "",
      980,
      "",
      916,
      919,
      "",
      [1416, { from: "slug builds the Doctours clinic page." }],
      1464,
    ],
  },
  {
    name: "pricing-promos",
    description:
      "Discounts and quotes: asking for a discount or a promo code, a price seen in an ad, a price a clinic quoted directly, and price matching.",
    loadedBy: "router",
    tools: ["getClinicPackagesTool"],
    prefetch: ["getClinicPackagesTool"],
    version: 1,
    source: [
      "ACTIVE PROMO OFFER (HARD RULE)",
      "DIRECT-FROM-CLINIC PRICE QUOTES (partner clinic)",
      "STAGE-SPECIFIC BEHAVIOR: PRE_CLINICAL_SENT Step 3 (discounts)",
      "CAPABILITIES & CONSTRAINTS (discounts)",
    ],
    // Line 1041, the GOOD example, states a real clinic's price and inclusions and is left out.
    parts: [...range(1523, 1528), "", ...range(1038, 1040), "", 1322, "", 895, 903, "", 916, 923],
  },
  {
    name: "creator-partnership",
    description:
      "Content creators and partnerships: collaborations, sponsorships, creator or influencer discounts, and media kits.",
    loadedBy: "router",
    version: 1,
    source: ["CREATOR / PARTNERSHIP BUSINESS — HARD BOUNDARY"],
    parts: [...range(954, 958)],
  },
  {
    name: "aftercare-meds",
    description:
      "Medication and aftercare basics: where to get finasteride or minoxidil, and wearing a hat or other head covering after the procedure.",
    loadedBy: "router",
    staticLinks: ["hims.com", "keeps.com"],
    version: 1,
    source: ["PACKAGE & CLINIC FACTS (finasteride and minoxidil)", "GUIDELINES (no head-covering advice)"],
    parts: [979, 999],
  },
];

/**
 * Sections of the original prompt that no skill carries, each with the reason.
 * test/skills/provenance.test.ts fails if a section is neither used by a skill nor listed here.
 */
export const SECTIONS_OUTSIDE_SKILLS: Record<string, string> = {
  "# COLLECTION PERSISTENCE (CRITICAL)": "Code: the anchor logic in src/pipeline/stage.ts decides whether and what to ask.",
  "# DATA COLLECTION": "Code: the planner saves a stated name with updateUserTool.",
  "# FIRST-CONTACT INTRODUCTION (ONE TIME ONLY)": "Not reachable in the packet's context. Planned for the last milestone.",
  "# INSTANT FORM AREA CONFIRMATION": "Not reachable in the packet's context. Planned for the last milestone.",
  "# INFORMATION COLLECTION — ONE THING AT A TIME": "Not reachable in the packet's context. Planned for the last milestone.",
  "# CONCERN REFLECTION (when the patient describes their hair concern)": "Not reachable in the packet's context. Planned for the last milestone.",
  "## LEAD (new patient, images may or may not exist)": "Another pipeline status. Planned for the last milestone.",
  "## PREP_PRE_CLINICAL (images received, assessment being built)": "Another pipeline status. Planned for the last milestone.",
  "## MEETING_BOOKED / MEETING_COMPLETED": "Another pipeline status. Planned for the last milestone.",
  "### CONSULTATION BOOKING CONFIRMATION": "Another pipeline status. Planned for the last milestone.",
  "## MEETING_MISSED": "Another pipeline status. Planned for the last milestone.",
  "## WAITING": "Another pipeline status. Planned for the last milestone.",
  "# PRE-ASSESSMENT CLINIC AND PRICING ANSWERS (LENGTH CAP)": "Applies before the assessment is sent. Planned for the last milestone.",
  "# Patient Summary": "Data, not rules. Code builds the patient context block.",
  "# Message Classification": "Dropped. It was hard-coded to pricing for every message. The router replaces it.",
  "# Available Context (use tools to fetch details)": "Data, not rules. Code builds the patient context block and prefetches the tools.",
  "# Recent Calls": "Data, not rules. Code builds the patient context block.",
  "# Recent Conversation (canonical transcript from Supabase)": "Data, plus the no-repeat rule, which the link plan applies in code. The Mastra memory note is dropped.",
};

function flatten(parts: readonly Part[]): Array<number | "" | [number, Trim]> {
  return parts.flatMap((part) => (typeof part === "object" && !Array.isArray(part) ? flatten(part.parts) : [part]));
}

/** Every packet line number that some skill copies from. */
export function usedPacketLines(): Set<number> {
  const used = new Set<number>();
  for (const spec of SKILL_SPECS) {
    for (const part of flatten(spec.parts)) {
      if (part !== "") used.add(typeof part === "number" ? part : part[0]);
    }
  }
  return used;
}

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
  const renderParts = (parts: readonly Part[]): string[] =>
    parts.flatMap((part) => {
      if (part === "") return [""];
      if (typeof part === "object" && !Array.isArray(part)) {
        return [`<!-- when ${part.when} -->`, ...renderParts(part.parts), GATE_CLOSE];
      }
      const [lineNumber, trim] = typeof part === "number" ? [part, {}] : part;
      const line = packetLines[lineNumber - 1];
      if (line === undefined) throw new Error(`${spec.name}: packet has no line ${lineNumber}`);
      return [applyTrim(line, trim, lineNumber)];
    });
  const body = renderParts(spec.parts);

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
