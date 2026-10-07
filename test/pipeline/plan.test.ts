import { describe, expect, it } from "vitest";
import { buildPacketContext } from "../../src/context/fixture";
import type { PatientContext } from "../../src/context/types";
import { buildPlan } from "../../src/pipeline/plan";
import type { RouterOutput } from "../../src/pipeline/router";
import { computeAnchor } from "../../src/pipeline/stage";
import { loadSkills } from "../../src/skills/loader";
import { TurnLedger } from "../../src/tools/ledger";
import { HAKAN_CLINIC_ID, HEVA_CLINIC_ID } from "../../src/tools/packet";

const skills = loadSkills("hair");
const ASSESSMENT_URL = "https://www.doctours.com/assessment/c3d4e5f6-3333-4333-8333-333333333333";
const CONSULTATION_URL = "https://www.doctours.com/consultation";

type RouterOverrides = Omit<Partial<RouterOutput>, "entities"> & { entities?: Partial<RouterOutput["entities"]> };

function routed(overrides: RouterOverrides = {}): RouterOutput {
  const { entities, ...rest } = overrides;
  return {
    primaryIntent: "other",
    intents: ["other"],
    skills: [],
    requestType: "question",
    humanRequested: false,
    requestedActions: [],
    selfServe: [],
    rationale: "test",
    confidence: "high",
    ...rest,
    entities: {
      clinics: [],
      packages: [],
      clinicLean: null,
      statedTiming: null,
      statedName: null,
      linksRequested: [],
      ...entities,
    },
  };
}

function plan(router: RouterOutput, text = "a message", context: PatientContext = buildPacketContext()) {
  const ledger = new TurnLedger();
  return { plan: buildPlan({ router, text, context, skills, ledger }), ledger };
}

function calls(ledger: TurnLedger) {
  return ledger.calls.map((call) => `${call.name}:${call.source}:${JSON.stringify(call.input)}`);
}

describe("planner: skills and prefetch", () => {
  it("loads core, the stage skill and only the selected skills", () => {
    const { plan: built } = plan(routed({ skills: ["clinic-packages"], entities: { clinics: ["Dr. Hakan Clinic"] } }));

    expect(built.core.name).toBe("core");
    expect(built.stage?.name).toBe("stage-pre-clinical-sent");
    expect(built.selected.map((skill) => skill.name)).toEqual(["clinic-packages"]);
  });

  it("fetches packages only for the clinic the message names", () => {
    const { plan: built, ledger } = plan(routed({ skills: ["clinic-packages"], entities: { clinics: ["Dr. Hakan Clinic"] } }));

    expect(built.resolvedClinics.map((clinic) => clinic.id)).toEqual([HAKAN_CLINIC_ID]);
    expect(calls(ledger)).toEqual([
      "getAllClinicsTool:prefetch:{}",
      `getClinicPackagesTool:prefetch:{"clinicId":"${HAKAN_CLINIC_ID}"}`,
    ]);
    expect(ledger.money().map((fact) => fact.amount)).toEqual([3200, 500]);
  });

  it("falls back to the recommended clinics when no clinic is named", () => {
    const { ledger } = plan(routed({ skills: ["clinic-packages"] }), "how much does it cost?");
    const packageCalls = ledger.calls.filter((call) => call.name === "getClinicPackagesTool");

    expect(packageCalls.map((call) => call.input)).toEqual([{ clinicId: HEVA_CLINIC_ID }, { clinicId: HAKAN_CLINIC_ID }]);
    expect(ledger.calls.some((call) => call.name === "getSavedClinicsTool")).toBe(true);
  });

  it("still resolves a clinic when the router misses its name", () => {
    const { plan: built } = plan(routed({ skills: ["clinic-packages"] }), "and what about hakan, is it cheaper?");
    expect(built.resolvedClinics.map((clinic) => clinic.name)).toEqual(["Dr. Hakan Clinic"]);
  });

  it("makes no tool call for a message that needs no skill", () => {
    const { plan: built, ledger } = plan(routed({ requestType: "chit_chat" }), "thanks!");

    expect(built.selected).toEqual([]);
    expect(built.tools).toEqual([]);
    expect(ledger.calls).toEqual([]);
  });

  it("loads the pause rules for a pause even when the router did not list them", () => {
    const { plan: built } = plan(routed({ requestType: "pause", primaryIntent: "pause_followup" }), "let me think about it");
    expect(built.selected.map((skill) => skill.name)).toEqual(["pause-followup"]);
  });

  it("ignores skill names it does not have", () => {
    const { plan: built } = plan(routed({ skills: ["consultation", "no-such-skill" as never] }));
    expect(built.selected.map((skill) => skill.name)).toEqual(["consultation"]);
  });

  it("gives the responder only read tools from the selected skills", () => {
    const { plan: built } = plan(routed({ skills: ["clinic-packages", "payment-deposit"], entities: { clinics: ["Heva Clinic"] } }));

    expect(built.tools).toEqual(expect.arrayContaining(["getClinicPackagesTool", "getLatestAssessmentTool"]));
    expect(built.tools).not.toContain("getPaymentLinkTool");
    expect(built.tools).not.toContain("updateUserClinicPreferencesTool");
    expect(built.tools).not.toContain("getConsultationRescheduleLinkTool");
  });
});

describe("planner: side effects", () => {
  it("saves a lean toward one clinic, with the id a tool returned", () => {
    const { ledger } = plan(
      routed({ skills: ["clinic-packages"], entities: { clinics: ["Heva Clinic"], clinicLean: "selected" } }),
    );
    const saves = ledger.calls.filter((call) => call.source === "side_effect");

    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      name: "updateUserClinicPreferencesTool",
      input: { clinicSelection: { selectedClinicId: HEVA_CLINIC_ID } },
    });
    expect(saves[0]?.output).toMatchObject({ updated: true });
  });

  it("saves nothing when the patient is torn or names two clinics", () => {
    const torn = plan(routed({ entities: { clinics: ["Heva Clinic", "Dr. Hakan Clinic"], clinicLean: "torn" } }));
    const two = plan(routed({ entities: { clinics: ["Heva Clinic", "Dr. Hakan Clinic"], clinicLean: "selected" } }));

    expect(torn.ledger.calls.filter((call) => call.kind === "write")).toEqual([]);
    expect(two.ledger.calls.filter((call) => call.kind === "write")).toEqual([]);
  });
});

describe("planner: the link rule", () => {
  it("includes the assessment link when the message is about paying and there is no booking", () => {
    const { plan: built } = plan(routed({ skills: ["payment-deposit"], selfServe: ["pay_deposit"] }));

    expect(built.directives.links.include).toEqual([ASSESSMENT_URL]);
    // The link was sent earlier in the thread and nobody asked for it. The rule beats both objections.
    expect(built.precedence[0]).toMatchObject({
      rule: "self_serve_link",
      beats: ["no_next_step_cta", "no_repeated_links"],
    });
  });

  it("loads the paying rules even if the router flagged the step but not the skill", () => {
    const { plan: built } = plan(routed({ skills: [], selfServe: ["pay_deposit"] }));
    expect(built.selected.map((skill) => skill.name)).toEqual(["payment-deposit"]);
    expect(built.directives.links.include).toEqual([ASSESSMENT_URL]);
  });

  it("leaves the assessment link out when a booking is already on file", () => {
    const context = buildPacketContext();
    const booked = { ...context, booking: { ...context.booking, hasActive: true } };
    const { plan: built } = plan(routed({ skills: ["payment-deposit"], selfServe: ["pay_deposit"] }), "how do I pay?", booked);

    expect(built.directives.links.include).toEqual([]);
  });

  it("includes the consultation link when the message is about the consultation and none is on file", () => {
    const { plan: built } = plan(routed({ primaryIntent: "consultation", skills: ["consultation"] }));

    expect(built.directives.links.include).toEqual([CONSULTATION_URL]);
    // Never sent before in this thread, so only the no-CTA line is overridden.
    expect(built.precedence[0]).toMatchObject({ rule: "self_serve_link", beats: ["no_next_step_cta"] });
  });

  it("leaves the consultation link out when a consultation is already on file", () => {
    const context = buildPacketContext();
    const scheduled = { ...context, consultation: { time: "2026-10-01T15:00:00.000Z", id: "c-1" } };
    const { plan: built } = plan(routed({ primaryIntent: "consultation", skills: ["consultation"] }), "is it free?", scheduled);

    expect(built.directives.links.include).toEqual([]);
  });

  it("includes no link for a question that is not about a self-serve step", () => {
    const price = plan(routed({ primaryIntent: "clinic_packages", skills: ["clinic-packages"], entities: { clinics: ["Heva Clinic"] } }));
    const specialty = plan(routed({ primaryIntent: "clinic_specialty", skills: ["clinic-specialty"] }));
    const thanks = plan(routed({ primaryIntent: "chit_chat", requestType: "chit_chat" }));

    for (const { plan: built } of [price, specialty, thanks]) {
      expect(built.directives.links.include).toEqual([]);
    }
  });

  it("includes a link the patient explicitly asks for, even though it was sent before", () => {
    const { plan: built } = plan(routed({ entities: { linksRequested: ["assessment"] } }));

    expect(built.directives.links.include).toEqual([ASSESSMENT_URL]);
    expect(built.precedence[0]).toMatchObject({ rule: "explicit_link_request", beats: ["no_repeated_links"] });
  });

  it("never lists the same link twice", () => {
    const { plan: built } = plan(
      routed({ skills: ["payment-deposit"], selfServe: ["pay_deposit"], entities: { linksRequested: ["assessment"] } }),
    );
    expect(built.directives.links.include).toEqual([ASSESSMENT_URL]);
  });
});

describe("planner: directives", () => {
  it("asks for the deposit to be quoted with the price at the decision stage only", () => {
    const context = buildPacketContext();
    expect(plan(routed()).plan.directives.quoteDepositWithPrice).toBe(true);
    expect(plan(routed(), "hi", { ...context, pipelineStatus: "LEAD" }).plan.directives.quoteDepositWithPrice).toBe(false);
  });

  it("records the anchor decision in the precedence log", () => {
    const { plan: built } = plan(routed());
    expect(built.directives.anchor).toBe("none");
    expect(built.precedence.at(-1)).toMatchObject({ rule: "collection_anchor" });
  });
});

describe("collection anchor", () => {
  const base = buildPacketContext();
  const lead = (overrides: Partial<PatientContext>): PatientContext => ({
    ...base,
    pipelineStatus: "LEAD",
    procedure: { ...base.procedure, area: null },
    patient: { ...base.patient, name: null },
    images: { hasImages: false, count: 0 },
    workingMemory: {},
    ...overrides,
  });

  it("adds no anchor when everything is collected", () => {
    expect(computeAnchor(base, { pausing: false }).anchor).toBe("none");
  });

  it("asks for the area first, then the name, then photos", () => {
    expect(computeAnchor(lead({}), { pausing: false }).anchor).toBe("area");
    expect(computeAnchor(lead({ procedure: { ...base.procedure, area: "crown" } }), { pausing: false }).anchor).toBe("name");
    expect(
      computeAnchor(lead({ procedure: { ...base.procedure, area: "crown" }, patient: { ...base.patient, name: "Sam" } }), {
        pausing: false,
      }).anchor,
    ).toBe("photos");
  });

  it("asks each item once, then moves to the next unasked one", () => {
    const askedArea = lead({ workingMemory: { collectionState: { areaAskCount: 1 } } });
    expect(computeAnchor(askedArea, { pausing: false }).anchor).toBe("name");

    const askedAll = lead({ workingMemory: { collectionState: { areaAskCount: 1, nameAskCount: 1, photoAskCount: 1 } } });
    expect(computeAnchor(askedAll, { pausing: false }).anchor).toBe("none");
  });

  it("skips the anchor on a pause", () => {
    expect(computeAnchor(lead({}), { pausing: true }).anchor).toBe("none");
  });

  it("does not ask for photos outside the intake stages, or for beard and eyebrow work", () => {
    const known = { procedure: { ...base.procedure, area: "crown" }, patient: { ...base.patient, name: "Sam" } };
    expect(computeAnchor(lead({ ...known, pipelineStatus: "PRE_CLINICAL_SENT" }), { pausing: false }).anchor).toBe("none");
    expect(
      computeAnchor(lead({ ...known, procedure: { ...base.procedure, area: "beard" } }), { pausing: false }).anchor,
    ).toBe("none");
  });
});
