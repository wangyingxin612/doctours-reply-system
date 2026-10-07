// The planner: from the router's classification to everything the responder needs.
// It picks the skills, runs the tools, saves what the patient told us, and decides the links.
// All of it is code, so the same message always gets the same plan.

import { knownClinicNames } from "../context/snapshot";
import type { PatientContext } from "../context/types";
import type { Skill, SkillSet } from "../skills/loader";
import type { TurnLedger } from "../tools/ledger";
import type { ToolName } from "../tools/registry";
import type { RouterOutput, SelfServeStep } from "./router";
import { computeAnchor, type Anchor } from "./stage";

export interface Directives {
  links: { include: string[] };
  anchor: Anchor;
  /** The decision stage ends at the deposit, so a price is quoted together with its deposit. */
  quoteDepositWithPrice: boolean;
}

/** One entry per place where code chose between rules. Written to the trace. */
export interface PrecedenceDecision {
  rule: string;
  decision: string;
  /** Rules this decision overrode on this turn. */
  beats: string[];
}

export interface ResolvedClinic {
  id: string;
  name: string;
  slug: string;
}

export interface Plan {
  core: Skill;
  /** The skill for the patient's pipeline status, when the vertical has one. */
  stage: Skill | null;
  /** Skills chosen for this message, sorted by name so the same set always renders the same way. */
  selected: Skill[];
  resolvedClinics: ResolvedClinic[];
  /** Read tools the responder may call for anything prefetch missed. */
  tools: ToolName[];
  directives: Directives;
  precedence: PrecedenceDecision[];
  policyAmounts: number[];
}

export interface PlanInput {
  router: RouterOutput;
  /** The patient's message, already redacted. */
  text: string;
  context: PatientContext;
  skills: SkillSet;
  ledger: TurnLedger;
}

type Binding = "none" | "user" | "chat" | "clinic";

/** What each read tool needs as input. Code fills it in; the model never has to. */
const TOOL_BINDING: Partial<Record<ToolName, Binding>> = {
  getAllClinicsTool: "none",
  getSavedClinicsTool: "user",
  getPatientContextTool: "user",
  getLatestAssessmentTool: "user",
  getPatientImagesTool: "user",
  getConsultationRescheduleLinkTool: "user",
  getFullCallsTool: "chat",
  getClinicPackagesTool: "clinic",
  getClinicDoctorsTool: "clinic",
};

/** The skill that owns each self-serve step. The step's link is only offered with its rules loaded. */
const SELF_SERVE_SKILL: Record<SelfServeStep, string> = {
  pay_deposit: "payment-deposit",
  book_consultation: "consultation",
};

const PAUSE_SKILL = "pause-followup";

const CONSULTATION_URL = "https://www.doctours.com/consultation";

const GENERIC_NAME_WORDS = new Set(["clinic", "the", "hair", "center", "centre", "hospital", "medical", "transplant"]);

function distinctiveWords(clinicName: string): string[] {
  return clinicName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !GENERIC_NAME_WORDS.has(word));
}

function mentions(text: string, clinicName: string): boolean {
  const lower = text.toLowerCase();
  return distinctiveWords(clinicName).some((word) => new RegExp(String.raw`\b${word}\b`).test(lower));
}

interface ClinicRecord {
  id: string;
  name: string;
  slug: string;
}

function readOnce(ledger: TurnLedger, name: ToolName, input: unknown, source: "prefetch" | "link_plan"): unknown {
  const key = JSON.stringify(input);
  const earlier = ledger.calls.find((call) => call.name === name && JSON.stringify(call.input) === key);
  return earlier ? earlier.output : ledger.call(name, input, source);
}

function allClinics(ledger: TurnLedger): ClinicRecord[] {
  const result = readOnce(ledger, "getAllClinicsTool", {}, "prefetch") as { clinics?: ClinicRecord[] } | null;
  return result?.clinics ?? [];
}

/**
 * Clinics the message is about: the router's entities, plus a plain word match against clinic names.
 * The word match is a backstop, so a router miss on a clinic name does not lose the prefetch.
 */
function resolveClinics(input: PlanInput, needClinicData: boolean): ResolvedClinic[] {
  const { router, text, context, ledger } = input;
  const named = router.entities.clinics;
  const matchedByWord = knownClinicNames(context).filter((name) => mentions(text, name));
  if (named.length === 0 && matchedByWord.length === 0 && !needClinicData) return [];

  const clinics = allClinics(ledger);
  const wanted = [...named, ...matchedByWord].map((name) => name.toLowerCase());
  return clinics.filter((clinic) =>
    wanted.some((name) => name === clinic.name.toLowerCase() || mentions(name, clinic.name)),
  );
}

function savedClinics(input: PlanInput): ResolvedClinic[] {
  const result = readOnce(input.ledger, "getSavedClinicsTool", { userId: input.context.userId }, "prefetch") as {
    savedClinics?: Array<{ clinic: ClinicRecord }>;
  } | null;
  return (result?.savedClinics ?? []).map(({ clinic }) => ({ id: clinic.id, name: clinic.name, slug: clinic.slug }));
}

function prefetch(input: PlanInput, selected: readonly Skill[], resolved: readonly ResolvedClinic[]): void {
  const { context, ledger } = input;
  const tools = new Set(selected.flatMap((skill) => skill.prefetch));

  for (const tool of tools) {
    const binding = TOOL_BINDING[tool];
    if (binding === "none") readOnce(ledger, tool, {}, "prefetch");
    else if (binding === "user") readOnce(ledger, tool, { userId: context.userId }, "prefetch");
    else if (binding === "chat") readOnce(ledger, tool, { chatId: context.chatId }, "prefetch");
    else if (binding === "clinic") {
      // No clinic named: fall back to the clinics recommended in the patient's assessment.
      const clinics = resolved.length > 0 ? resolved : savedClinics(input);
      for (const clinic of clinics) readOnce(ledger, tool, { clinicId: clinic.id }, "prefetch");
    }
  }
}

/** A lean toward one clinic counts as selecting it, and is saved this turn with an id a tool returned. */
function saveClinicLean(input: PlanInput, resolved: readonly ResolvedClinic[]): void {
  const [only, ...others] = resolved;
  if (input.router.entities.clinicLean !== "selected" || only === undefined || others.length > 0) return;
  input.ledger.call(
    "updateUserClinicPreferencesTool",
    { clinicSelection: { selectedClinicId: only.id }, userId: input.context.userId },
    "side_effect",
  );
}

/**
 * The link rule. When the answer is about a step the patient can complete alone on a known page,
 * and nothing on file shows the step is done, that page's link is part of the answer. It is not a
 * next-step nudge, and it is sent even if it appeared earlier in the thread.
 */
function planLinks(input: PlanInput, loaded: ReadonlySet<string>): { include: string[]; precedence: PrecedenceDecision[] } {
  const { router, context, ledger } = input;
  const include: string[] = [];
  const precedence: PrecedenceDecision[] = [];
  const alreadySent = (url: string) => context.text.chatList.includes(url);

  const add = (url: string, why: string, explicit: boolean) => {
    if (include.includes(url)) return;
    include.push(url);
    precedence.push({
      rule: explicit ? "explicit_link_request" : "self_serve_link",
      decision: `Include ${url}. ${why}`,
      beats: explicit
        ? alreadySent(url) ? ["no_repeated_links"] : []
        : ["no_next_step_cta", ...(alreadySent(url) ? ["no_repeated_links"] : [])],
    });
  };

  const assessmentUrl = () => {
    const result = readOnce(ledger, "getLatestAssessmentTool", { userId: context.userId }, "link_plan") as {
      assessmentUrl?: string | null;
    } | null;
    return result?.assessmentUrl ?? null;
  };

  if (router.entities.linksRequested.includes("assessment")) {
    const url = assessmentUrl();
    if (url) add(url, "The patient asked for the assessment link.", true);
  }
  if (router.entities.linksRequested.includes("consultation") && loaded.has("consultation")) {
    add(CONSULTATION_URL, "The patient asked for the consultation link.", true);
  }

  if (router.selfServe.includes("pay_deposit") && loaded.has("payment-deposit") && !context.booking.hasActive) {
    const url = assessmentUrl();
    if (url) add(url, "The patient can pay from the assessment and has no booking on file.", false);
  }
  const aboutConsultation = router.selfServe.includes("book_consultation") || router.primaryIntent === "consultation";
  if (aboutConsultation && loaded.has("consultation") && context.consultation.time === null) {
    add(CONSULTATION_URL, "The patient can book the consultation and none is on file.", false);
  }

  return { include, precedence };
}

export function buildPlan(input: PlanInput): Plan {
  const { router, context, skills } = input;

  const selectedNames = new Set(router.skills.filter((name) => skills.has(name)));
  for (const step of router.selfServe) {
    const owner = SELF_SERVE_SKILL[step];
    if (skills.has(owner)) selectedNames.add(owner);
  }
  if (router.requestType === "pause" && skills.has(PAUSE_SKILL)) selectedNames.add(PAUSE_SKILL);
  const selected = [...selectedNames].sort().map((name) => skills.get(name));
  const stage = skills.stage(context.pipelineStatus);
  const loaded = [skills.core, ...(stage ? [stage] : []), ...selected];

  const needClinicData = selected.some((skill) => skill.prefetch.some((tool) => TOOL_BINDING[tool] === "clinic"));
  const resolvedClinics = resolveClinics(input, needClinicData);

  prefetch(input, selected, resolvedClinics);
  saveClinicLean(input, resolvedClinics);

  const links = planLinks(input, selectedNames);
  const anchor = computeAnchor(context, { pausing: router.requestType === "pause" });

  return {
    core: skills.core,
    stage,
    selected,
    resolvedClinics,
    tools: [...new Set(selected.flatMap((skill) => skill.tools))],
    directives: {
      links: { include: links.include },
      anchor: anchor.anchor,
      quoteDepositWithPrice: context.pipelineStatus === "PRE_CLINICAL_SENT",
    },
    precedence: [
      ...links.precedence,
      { rule: "collection_anchor", decision: `anchor: ${anchor.anchor}. ${anchor.reason}`, beats: [] },
    ],
    policyAmounts: [...new Set(loaded.flatMap((skill) => skill.policyAmounts))],
  };
}
