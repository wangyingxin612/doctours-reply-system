// The router: a small model that says what a message is. It never decides what to do about it.

import { z } from "zod";
import type { ModelConfig } from "../../config/models";
import { routerSnapshot } from "../context/snapshot";
import type { PatientContext } from "../context/types";
import { callModel, type LlmDeps } from "../llm/client";
import { ACTION_CATALOG, ACTION_TYPES, type ActionType } from "../policy/actions";
import { fillPrompt, loadPrompt } from "../prompts";
import type { SkillSet } from "../skills/loader";
import type { ModelCallTrace } from "../trace/types";
import { toModelCallTrace } from "../trace/write";

/** One label per message. The Monday report splits the escalation rate by these. */
export const INTENTS = [
  "clinic_packages",
  "package_choice",
  "clinic_specialty",
  "clinic_selection",
  "payment",
  "deposit_terms",
  "financing_insurance",
  "consultation",
  "assessment",
  "photos",
  "dates_availability",
  "travel",
  "clinic_website_contact",
  "pricing_promos",
  "aftercare_meds",
  "creator_partnership",
  "pause_followup",
  "human_request",
  "unsupported_action",
  "identity",
  "chit_chat",
  "other",
] as const;

export type Intent = (typeof INTENTS)[number];

/** Steps a patient can complete alone on a known page. See the link rule in the planner. */
export const SELF_SERVE_STEPS = ["pay_deposit", "book_consultation", "upload_photos"] as const;
export type SelfServeStep = (typeof SELF_SERVE_STEPS)[number];

export const LINK_KINDS = ["assessment", "payment", "consultation", "photo_upload", "clinic_page"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const REQUEST_TYPES = ["question", "action", "mixed", "pause", "chit_chat"] as const;

/** How committed the patient sounds about a stated month, season or date. */
export const TIMING_STRENGTHS = ["strong", "medium", "weak"] as const;

function routerSchema(skillNames: readonly string[]) {
  const [first, ...rest] = skillNames;
  if (first === undefined) throw new Error("The router needs at least one skill to choose from.");

  return z.object({
    primaryIntent: z.enum(INTENTS),
    intents: z.array(z.enum(INTENTS)),
    skills: z.array(z.enum([first, ...rest])),
    requestType: z.enum(REQUEST_TYPES),
    humanRequested: z.boolean(),
    requestedActions: z.array(
      z.object({
        type: z.enum(ACTION_TYPES as [ActionType, ...ActionType[]]),
        evidence: z.string(),
      }),
    ),
    /** The patient passes on a price a clinic quoted them directly, and does not ask us to match it. */
    sharedClinicQuote: z.boolean(),
    selfServe: z.array(z.enum(SELF_SERVE_STEPS)),
    entities: z.object({
      clinics: z.array(z.string()),
      packages: z.array(z.string()),
      clinicLean: z.enum(["selected", "torn"]).nullable(),
      packageLean: z.enum(["selected", "torn"]).nullable(),
      statedTiming: z.object({ text: z.string(), strength: z.enum(TIMING_STRENGTHS) }).nullable(),
      statedName: z.string().nullable(),
      linksRequested: z.array(z.enum(LINK_KINDS)),
    }),
    needsCallHistory: z.boolean(),
    confidence: z.enum(["high", "low"]),
  });
}

export type RouterOutput = z.infer<ReturnType<typeof routerSchema>>;

export function routerSystemPrompt(skills: SkillSet): string {
  const skillIndex = skills.routable.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  const actionCatalog = ACTION_TYPES.map((type) => {
    const rule: { definition: string; notThis?: string } = ACTION_CATALOG[type];
    return `- ${type}: ${rule.definition}${rule.notThis ? ` Not this: ${rule.notThis}` : ""}`;
  }).join("\n");
  return fillPrompt(loadPrompt("router.md"), { SKILL_INDEX: skillIndex, ACTION_CATALOG: actionCatalog });
}

export interface RouterInput {
  /** The patient's message, already redacted. */
  text: string;
  context: PatientContext;
  skills: SkillSet;
  config: ModelConfig;
}

export interface RouterResult {
  output: RouterOutput;
  call: ModelCallTrace;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export async function runRouter(input: RouterInput, deps: LlmDeps = {}): Promise<RouterResult> {
  const result = await callModel(
    {
      role: "router",
      system: [{ text: routerSystemPrompt(input.skills) }],
      prompt: `${routerSnapshot(input.context)}\n\n# Incoming message\n"${input.text}"`,
      schema: routerSchema(input.skills.routable.map((skill) => skill.name)),
      attemptTimeoutMs: input.config.routerAttemptTimeoutMs,
    },
    { config: input.config, ...deps },
  );

  const output: RouterOutput = {
    ...result.output,
    intents: unique([result.output.primaryIntent, ...result.output.intents]),
    skills: unique(result.output.skills),
    selfServe: unique(result.output.selfServe),
  };

  return { output, call: toModelCallTrace("router", result) };
}
