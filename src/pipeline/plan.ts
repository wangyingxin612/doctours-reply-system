// The planner: from the router's classification to everything the responder needs.
// It picks the skills, runs the tools, saves what the patient told us, and decides the links.
// All of it is code, so the same classification always gets the same plan.

import { knownClinicNames } from "../context/snapshot";
import type { PatientContext } from "../context/types";
import { ACTION_CATALOG, type ActionHandling } from "../policy/actions";
import type { Skill, SkillSet } from "../skills/loader";
import type { TurnLedger } from "../tools/ledger";
import type { ToolName } from "../tools/registry";
import type { ExtraFact } from "../subtasks/callHistory";
import type { TraceEvent } from "../trace/types";
import type { Intent, LinkKind, RouterOutput, SelfServeStep } from "./router";
import { computeAnchor, type Anchor } from "./stage";

export interface Directives {
  links: { include: string[] };
  anchor: Anchor;
  /** The decision stage ends at the deposit, so a price is quoted together with its deposit. */
  quoteDepositWithPrice: boolean;
  /** The patient is stepping back. The reply is the dated check-in close and nothing else. */
  pause: boolean;
  /** The patient's wording matches more than one of these packages. The reply asks which one. */
  clarifyPackage: string[] | null;
  /** The patient asked who or what they are talking to. The core rules have the answer: name and role. */
  identityQuestion: boolean;
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
  /** The clinic's own website, when the tool has one. */
  url: string | null;
}

export interface ResolvedPackage {
  id: string;
  name: string;
  clinicId: string;
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
  /** Things a production system would act on, such as a revision request. Written to the trace. */
  events: TraceEvent[];
  /** Facts a subtask prepared for the responder, in place of raw tool output. */
  extraFacts: ExtraFact[];
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

/** True when code fills in the tool's whole input. A second call could only return the same thing. */
export function hasFixedInput(tool: ToolName): boolean {
  const binding = TOOL_BINDING[tool];
  return binding !== undefined && binding !== "clinic";
}

/** The skill that holds the rules for each self-serve step and each kind of link. */
const SELF_SERVE_SKILL: Record<SelfServeStep, string> = {
  pay_deposit: "payment-deposit",
  book_consultation: "consultation",
  upload_photos: "photos-intake",
};

const LINK_SKILL: Record<LinkKind, string> = {
  assessment: "assessment",
  payment: "payment-deposit",
  consultation: "consultation",
  photo_upload: "photos-intake",
  clinic_page: "clinic-website-contact",
};

/** Actions a tool performs still need the rules that say how to talk about the result. */
const TOOL_ACTION_SKILL: Partial<Record<keyof typeof ACTION_CATALOG, string>> = {
  reschedule_consultation: "consultation",
  send_own_photos: "photos-intake",
};

/** The self-serve step a message with this primary intent is mainly about. */
const INTENT_STEP: Partial<Record<Intent, SelfServeStep>> = {
  payment: "pay_deposit",
  consultation: "book_consultation",
  photos: "upload_photos",
};

const PAUSE_SKILL = "pause-followup";
const INTAKE_SKILL = "intake-collection";

const CONSULTATION_URL = "https://www.doctours.com/consultation";
const IMAGE_UPLOAD_URL = "https://www.doctours.com/image-upload";
const clinicPageUrl = (slug: string) => `https://www.doctours.com/clinic/${slug}`;

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

function readOnce(ledger: TurnLedger, name: ToolName, input: unknown, source: "prefetch" | "link_plan"): unknown {
  const key = JSON.stringify(input);
  const earlier = ledger.calls.find((call) => call.name === name && JSON.stringify(call.input) === key);
  return earlier ? earlier.output : ledger.call(name, input, source);
}

type ClinicRecord = { id: string; name: string; slug: string; url?: string | null };

const toClinic = (clinic: ClinicRecord): ResolvedClinic => ({
  id: clinic.id,
  name: clinic.name,
  slug: clinic.slug,
  url: clinic.url ?? null,
});

function allClinics(ledger: TurnLedger): ResolvedClinic[] {
  const result = readOnce(ledger, "getAllClinicsTool", {}, "prefetch") as { clinics?: ClinicRecord[] } | null;
  return (result?.clinics ?? []).map(toClinic);
}

function savedClinics(input: PlanInput): ResolvedClinic[] {
  const result = readOnce(input.ledger, "getSavedClinicsTool", { userId: input.context.userId }, "prefetch") as {
    savedClinics?: Array<{ clinic: ClinicRecord }>;
  } | null;
  return (result?.savedClinics ?? []).map(({ clinic }) => toClinic(clinic));
}

function packagesOf(ledger: TurnLedger, clinic: ResolvedClinic): ResolvedPackage[] {
  const result = readOnce(ledger, "getClinicPackagesTool", { clinicId: clinic.id }, "prefetch") as {
    packages?: Array<{ id: string; name: string }>;
  } | null;
  return (result?.packages ?? []).map((pkg) => ({ id: pkg.id, name: pkg.name, clinicId: clinic.id }));
}

/** Clinic and package the patient saved on an earlier turn. Ground truth comes from the tool, not from memory. */
function storedSelection(input: PlanInput): { clinicId: string | null; packageId: string | null } {
  const result = readOnce(input.ledger, "getPatientContextTool", { userId: input.context.userId }, "prefetch") as {
    clinicSelectionPreferences?: { selectedClinicId?: string | null; selectedPackageId?: string | null };
  } | null;
  const preferences = result?.clinicSelectionPreferences;
  return { clinicId: preferences?.selectedClinicId ?? null, packageId: preferences?.selectedPackageId ?? null };
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

  const wanted = [...named, ...matchedByWord].map((name) => name.toLowerCase());
  return allClinics(ledger).filter((clinic) =>
    wanted.some((name) => name === clinic.name.toLowerCase() || mentions(name, clinic.name)),
  );
}

function matchPackages(named: readonly string[], packages: readonly ResolvedPackage[]): ResolvedPackage[] {
  const wanted = named.map((name) => name.toLowerCase().replace(/\bpackage\b/g, "").trim()).filter(Boolean);
  return packages.filter((pkg) => {
    const name = pkg.name.toLowerCase();
    return wanted.some((want) => want === name || want.includes(name) || name.includes(want));
  });
}

/** What the patient has decided, from this message first and from what was saved before second. */
interface Selection {
  clinic: ResolvedClinic | null;
  pkg: ResolvedPackage | null;
  /** True when the clinic or package was chosen in this message, so it must be saved now. */
  clinicChosenNow: boolean;
  packageChosenNow: boolean;
  tornClinics: ResolvedClinic[];
  tornPackages: ResolvedPackage[];
  /** Package names when the patient's wording matches more than one. */
  ambiguousPackages: string[] | null;
}

function readSelection(input: PlanInput, resolved: readonly ResolvedClinic[], wantsPayment: boolean): Selection {
  const { router, ledger } = input;
  const { clinicLean, packageLean, packages: namedPackages } = router.entities;
  const choosingPackage = packageLean === "selected" || (namedPackages.length > 0 && wantsPayment);

  const selection: Selection = {
    clinic: null,
    pkg: null,
    clinicChosenNow: false,
    packageChosenNow: false,
    tornClinics: clinicLean === "torn" && resolved.length >= 2 ? [...resolved] : [],
    tornPackages: [],
    ambiguousPackages: null,
  };

  const [onlyClinic, ...otherClinics] = resolved;
  if (onlyClinic && otherClinics.length === 0 && (clinicLean === "selected" || choosingPackage)) {
    selection.clinic = onlyClinic;
    selection.clinicChosenNow = true;
  }

  const needsStored = selection.clinic === null && (wantsPayment || namedPackages.length > 0);
  const stored = needsStored || wantsPayment ? storedSelection(input) : { clinicId: null, packageId: null };
  if (selection.clinic === null && stored.clinicId !== null) {
    selection.clinic = allClinics(ledger).find((clinic) => clinic.id === stored.clinicId) ?? null;
  }

  if (namedPackages.length > 0) {
    // Package ids must come from the chosen clinic's own list. With no clinic yet, look across the
    // recommended clinics: a name that fits exactly one package also tells us the clinic.
    const candidates = selection.clinic
      ? packagesOf(ledger, selection.clinic)
      : savedClinics(input).flatMap((clinic) => packagesOf(ledger, clinic));
    const matches = matchPackages(namedPackages, candidates);
    const [onlyMatch, ...otherMatches] = matches;

    if (packageLean === "torn" && matches.length >= 2) {
      selection.tornPackages = matches;
    } else if (choosingPackage && onlyMatch && otherMatches.length === 0) {
      selection.pkg = onlyMatch;
      selection.packageChosenNow = true;
      if (selection.clinic === null) {
        selection.clinic = allClinics(ledger).find((clinic) => clinic.id === onlyMatch.clinicId) ?? null;
        selection.clinicChosenNow = selection.clinic !== null;
      }
    } else if (choosingPackage && matches.length > 1) {
      selection.ambiguousPackages = matches.map((pkg) => pkg.name);
    }
  }

  if (selection.pkg === null && selection.clinic !== null && stored.packageId !== null) {
    selection.pkg = packagesOf(ledger, selection.clinic).find((pkg) => pkg.id === stored.packageId) ?? null;
  }
  return selection;
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

  // Some skills only need clinic data when the patient names a clinic. Without a name they get none,
  // which keeps facts nobody asked about out of the prompt. The responder can still call the tool.
  for (const tool of new Set(selected.flatMap((skill) => skill.prefetchNamed))) {
    for (const clinic of resolved) readOnce(ledger, tool, { clinicId: clinic.id }, "prefetch");
  }
}

/**
 * Saves what the patient told us this turn, with ids a tool returned. A lean toward one clinic
 * counts as selecting it. Being torn is saved as soft interest, never as a selection.
 */
function saveWhatThePatientSaid(input: PlanInput, selection: Selection): void {
  const { router, context, ledger } = input;

  const clinicSelection: Record<string, unknown> = {};
  if (selection.clinic && selection.clinicChosenNow) clinicSelection.selectedClinicId = selection.clinic.id;
  if (selection.pkg && selection.packageChosenNow) {
    clinicSelection.selectedClinicId = selection.pkg.clinicId;
    clinicSelection.selectedPackageId = selection.pkg.id;
  }
  if (selection.tornClinics.length > 0) clinicSelection.softClinicInterestIds = selection.tornClinics.map((clinic) => clinic.id);
  if (selection.tornPackages.length > 0) clinicSelection.softPackageInterestIds = selection.tornPackages.map((pkg) => pkg.id);

  const dates = procedureTiming(router);
  if (Object.keys(clinicSelection).length > 0 || dates !== null) {
    ledger.call(
      "updateUserClinicPreferencesTool",
      {
        ...(Object.keys(clinicSelection).length > 0 ? { clinicSelection } : {}),
        ...(dates !== null ? { tentativeProcedureDates: dates } : {}),
        userId: context.userId,
      },
      "side_effect",
    );
  }

  const name = router.entities.statedName?.trim();
  if (name) {
    const [firstName, ...rest] = name.split(/\s+/);
    ledger.call(
      "updateUserTool",
      { firstName, ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}), userId: context.userId },
      "side_effect",
    );
  }
}

interface LinkPlan {
  include: string[];
  precedence: PrecedenceDecision[];
}

/**
 * The link rules.
 * 1. A link the patient explicitly asks for is sent, even if it was sent before.
 * 2. When the answer is about a step the patient can complete alone on a known page, and nothing on
 *    file shows the step is done, that page's link is part of the answer. It is not a next-step
 *    nudge, and it is sent even if it appeared earlier in the thread.
 * 3. Paying has three pages. A patient who has decided on a clinic and a package gets the payment
 *    link. A patient who has a clinic and is ready to pay gets the checkout link. Anyone else is
 *    pointed at the assessment. Never more than one of the three.
 * 4. A pause carries no link, unless the patient explicitly asked for one.
 */
function planLinks(
  input: PlanInput,
  loaded: ReadonlySet<string>,
  resolved: readonly ResolvedClinic[],
  selection: Selection,
  pausing: boolean,
): LinkPlan {
  const { router, context, ledger } = input;
  const include: string[] = [];
  const precedence: PrecedenceDecision[] = [];
  const asked = new Set(router.entities.linksRequested);

  // A message can touch two self-serve steps ("do I need a consultation before I pay?"). The reply
  // carries the link for the step the message is mainly about, not one for each.
  let steps: readonly SelfServeStep[] = router.selfServe;
  const mainStep = INTENT_STEP[router.primaryIntent];
  if (steps.length > 1 && mainStep && steps.includes(mainStep)) {
    precedence.push({
      rule: "one_self_serve_step",
      decision: `The message is mainly about ${mainStep}. Links for ${steps.filter((step) => step !== mainStep).join(", ")} are left out.`,
      beats: [],
    });
    steps = [mainStep];
  }
  const alreadySent = (url: string) => context.text.chatList.includes(url);

  const add = (url: string, rule: string, why: string) => {
    if (include.includes(url)) return;
    include.push(url);
    const beats = [
      ...(rule === "self_serve_link" ? ["no_next_step_cta"] : []),
      ...(alreadySent(url) ? ["no_repeated_links"] : []),
    ];
    precedence.push({ rule, decision: `Include ${url}. ${why}`, beats });
  };

  const assessmentUrl = () => {
    const result = readOnce(ledger, "getLatestAssessmentTool", { userId: context.userId }, "link_plan") as {
      assessmentUrl?: string | null;
    } | null;
    return result?.assessmentUrl ?? null;
  };

  // --- Paying: payment link, checkout link or the assessment. Exactly one. ---
  const askedToPay = asked.has("payment") || selection.packageChosenNow;
  const aboutPaying = steps.includes("pay_deposit") && !pausing;
  if ((askedToPay || aboutPaying) && loaded.has("payment-deposit") && !context.booking.hasActive) {
    const rule = askedToPay ? "explicit_link_request" : "self_serve_link";
    let url: string | null = null;

    if (selection.clinic && selection.pkg) {
      const link = ledger.call("getPaymentLinkTool", { type: "payment", clinicPackageId: selection.pkg.id }, "link_plan") as {
        status?: string;
        url?: string | null;
      } | null;
      if (link?.status === "ready" && link.url) {
        url = link.url;
        add(url, rule, `Clinic and package are decided (${selection.clinic.name}, ${selection.pkg.name}), so the patient gets the payment link, not the assessment.`);
      }
    } else if (selection.clinic && askedToPay) {
      const link = ledger.call("getPaymentLinkTool", { type: "checkout", clinicId: selection.clinic.id }, "link_plan") as {
        status?: string;
        url?: string | null;
      } | null;
      if (link?.status === "ready" && link.url) {
        url = link.url;
        add(url, rule, `The clinic is decided (${selection.clinic.name}), the package is not, and the patient is ready to pay, so they get the checkout link.`);
      }
    }
    if (url === null) {
      const assessment = assessmentUrl();
      if (assessment) add(assessment, rule, "The patient can book and pay from the assessment and has no booking on file.");
    }
  }

  // --- The assessment itself, when asked for by name. ---
  if (asked.has("assessment")) {
    const url = assessmentUrl();
    if (url) add(url, "explicit_link_request", "The patient asked for the assessment link.");
  }

  // --- The consultation. ---
  if (loaded.has("consultation")) {
    const rescheduling = router.requestedActions.some((action) => action.type === "reschedule_consultation");
    const reschedule = rescheduling
      ? (readOnce(ledger, "getConsultationRescheduleLinkTool", { userId: context.userId }, "link_plan") as {
          status?: string;
          url?: string | null;
        } | null)
      : null;
    const noneOnFile = context.consultation.time === null;

    if (reschedule?.status === "ready" && reschedule.url) {
      add(reschedule.url, "explicit_link_request", "The patient asked to move the consultation, and the tool returned a reschedule link.");
    } else if (asked.has("consultation") || (rescheduling && noneOnFile)) {
      add(CONSULTATION_URL, "explicit_link_request", "The patient asked for the consultation link, or asked to move a consultation that is not on file.");
    } else if (!pausing && noneOnFile && aboutBookingAConsultation(router, steps)) {
      add(CONSULTATION_URL, "self_serve_link", "The patient can book the consultation and none is on file.");
    }
  }

  // --- Photo upload. ---
  if (loaded.has("photos-intake")) {
    if (asked.has("photo_upload")) {
      add(IMAGE_UPLOAD_URL, "explicit_link_request", "The patient asked for the photo upload link.");
    } else if (!pausing && steps.includes("upload_photos") && !context.images.hasImages) {
      add(IMAGE_UPLOAD_URL, "self_serve_link", "The patient can upload photos and none are on file.");
    }
  }

  // --- A clinic's website: the Doctours clinic page first, the clinic's own site only on a repeat ask. ---
  if (asked.has("clinic_page") && loaded.has("clinic-website-contact")) {
    for (const clinic of resolved.slice(0, 2)) {
      const page = clinicPageUrl(clinic.slug);
      if (!alreadySent(page)) {
        add(page, "explicit_link_request", `First ask for ${clinic.name}'s website: send the Doctours clinic page.`);
      } else if (clinic.url) {
        add(clinic.url, "explicit_link_request", `Repeat ask after the Doctours page for ${clinic.name} was sent: send the clinic's own site.`);
      }
    }
  }

  return { include, precedence };
}

/**
 * The router flags the step. As a backstop, a message whose main intent is the consultation counts
 * too, unless it is about what was said on a past call.
 */
function aboutBookingAConsultation(router: RouterOutput, steps: readonly SelfServeStep[]): boolean {
  return steps.includes("book_consultation") || (router.primaryIntent === "consultation" && !router.needsCallHistory);
}

/** Timing for the procedure. A time the patient wants for a consultation call is not that. */
function procedureTiming(router: RouterOutput): RouterOutput["entities"]["statedTiming"] {
  const aboutACall =
    router.primaryIntent === "consultation" ||
    router.requestedActions.some((action) => action.type === "reschedule_consultation" || action.type === "arrange_call");
  return aboutACall ? null : router.entities.statedTiming;
}

/** Skills a classification implies even when the router did not list them. */
function impliedSkills(router: RouterOutput): string[] {
  const implied: string[] = [];
  for (const step of router.selfServe) implied.push(SELF_SERVE_SKILL[step]);
  for (const kind of router.entities.linksRequested) implied.push(LINK_SKILL[kind]);
  for (const action of router.requestedActions) {
    const handling: ActionHandling = ACTION_CATALOG[action.type].handling;
    if (handling.by === "skill") implied.push(handling.skill);
    const forTool = TOOL_ACTION_SKILL[action.type];
    if (forTool) implied.push(forTool);
  }
  if (router.requestType === "pause") implied.push(PAUSE_SKILL);
  if (router.entities.packageLean === "selected") implied.push("payment-deposit");
  if (router.entities.packages.length > 0) implied.push("clinic-packages");
  return implied;
}

export function buildPlan(input: PlanInput): Plan {
  const { router, context, skills } = input;
  const pausing = router.requestType === "pause";

  // Code decides whether a collection question rides on this reply. If one does, its rules load too.
  const anchor = computeAnchor(context, { pausing });
  const collecting = anchor.anchor === "none" ? [] : [INTAKE_SKILL];

  const selectedNames = new Set(
    [...router.skills, ...impliedSkills(router), ...collecting].filter((name) => skills.has(name) && name !== "core"),
  );
  const selected = [...selectedNames].sort().map((name) => skills.get(name));
  const stage = skills.stage(context.pipelineStatus);
  const loaded = [skills.core, ...(stage ? [stage] : []), ...selected];

  const needClinicData = selected.some((skill) => skill.prefetch.some((tool) => TOOL_BINDING[tool] === "clinic"));

  const resolvedClinics = resolveClinics(input, needClinicData);
  prefetch(input, selected, resolvedClinics);

  const wantsPayment = router.entities.linksRequested.includes("payment") || router.selfServe.includes("pay_deposit");
  const selection = readSelection(input, resolvedClinics, wantsPayment);
  saveWhatThePatientSaid(input, selection);

  const links = planLinks(input, selectedNames, resolvedClinics, selection, pausing);

  const precedence: PrecedenceDecision[] = [...links.precedence];
  if (pausing) {
    precedence.push({
      rule: "time_bound_pause",
      decision: "The patient is pausing: the reply is the dated check-in close, with no anchor, no funnel step and no unrequested link.",
      beats: ["collection_anchor", "funnel_guidance", "self_serve_link"],
    });
  }
  precedence.push({ rule: "collection_anchor", decision: `anchor: ${anchor.anchor}. ${anchor.reason}`, beats: [] });

  // A revision request is a promise the reply makes. In production a detector files it for the
  // team. Here the event in the trace is what makes the promise traceable.
  const events: TraceEvent[] = router.requestedActions
    .filter((action) => action.type === "revise_assessment")
    .map((action) => ({ type: "revision_request", detail: { requested: action.evidence } }));

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
      pause: pausing,
      clarifyPackage: selection.ambiguousPackages,
      identityQuestion: router.intents.includes("identity"),
    },
    precedence,
    policyAmounts: [...new Set(loaded.flatMap((skill) => skill.policyAmounts))],
    events,
    extraFacts: [],
  };
}
