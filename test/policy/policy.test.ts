import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, ACTION_TYPES, handlingOf } from "../../src/policy/actions";
import { decideFromGuard, decideFromRouter, systemFailureDecision } from "../../src/policy/decide";
import {
  buildEscalationReply,
  ESCALATION_TABLE,
  escalationResponse,
  HANDOFF_SENTENCE,
  REASON_CODES,
} from "../../src/policy/escalation";
import { blocking, runValidators } from "../../src/validators";
import { EMPTY_VALIDATION_CONTEXT } from "../../src/validators/types";

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

describe("escalation table", () => {
  it.each(REASON_CODES)("%s has a short reply that ends with the handoff sentence", (code) => {
    const response = escalationResponse(code);

    expect(response.endsWith(HANDOFF_SENTENCE)).toBe(true);
    expect(sentences(response).length).toBeLessThanOrEqual(2);
    expect(response.length).toBeLessThanOrEqual(110);
    expect(response).not.toMatch(/\d/);
    expect(response).not.toMatch(/https?:|www\./);
    expect(response).not.toContain("?");
  });

  it.each(REASON_CODES)("%s builds a reply that passes every validator", (code) => {
    const reply = buildEscalationReply(code);

    expect(blocking(runValidators(reply, EMPTY_VALIDATION_CONTEXT))).toEqual([]);
    expect(reply).toMatchObject({
      escalate: true,
      templateId: null,
      shouldFollowUp: false,
      followUpTiming: null,
      attachmentUrls: null,
      workingMemoryUpdates: { escalationFlags: code },
    });
    expect(reply.escalationReason).toBe(ESCALATION_TABLE[code].escalationReason);
  });

  it("marks only our own failures as avoidable", () => {
    const avoidable = REASON_CODES.filter((code) => ESCALATION_TABLE[code].category === "avoidable");
    expect(avoidable).toEqual(["SYSTEM_FAILURE", "LOW_CONFIDENCE"]);
  });

  it("does not announce that a price cannot be changed", () => {
    expect(escalationResponse("PRICE_NEGOTIATION")).toBe(HANDOFF_SENTENCE);
  });

  it("flags a patient who is trying to pay or book as high engagement", () => {
    expect(buildEscalationReply("PAYMENT_ACTION_NO_TOOL").highEngagement).toBe(true);
    expect(buildEscalationReply("DATE_HOLD_OR_AVAILABILITY_ACTION").highEngagement).toBe(true);
    expect(buildEscalationReply("HUMAN_REQUESTED").highEngagement).toBe(false);
  });
});

describe("action catalog", () => {
  it("gives every action a definition the router can read", () => {
    for (const type of ACTION_TYPES) {
      expect(ACTION_CATALOG[type].definition.length).toBeGreaterThan(20);
    }
  });

  it("reaches every action reason code from some action", () => {
    const reachable = new Set(
      ACTION_TYPES.map(handlingOf).flatMap((handling) => (handling.by === "escalation" ? [handling.reasonCode] : [])),
    );
    const setElsewhere = new Set(["HUMAN_REQUESTED", "SYSTEM_FAILURE"]);
    for (const code of REASON_CODES) {
      expect(reachable.has(code) || setElsewhere.has(code)).toBe(true);
    }
  });

  it("does not escalate what a tool or a rule already handles", () => {
    const handled = ["send_link", "reschedule_consultation", "revise_assessment", "request_discount", "creator_partnership"] as const;
    for (const type of handled) {
      expect(handlingOf(type).by).not.toBe("escalation");
    }
  });
});

describe("escalation decision", () => {
  it("does not escalate a plain question", () => {
    expect(decideFromRouter({ humanRequested: false, actions: [] })).toEqual({
      escalate: false,
      reasonCode: null,
      secondaryReasonCodes: [],
      decidedBy: "none",
      category: null,
    });
  });

  it("does not escalate actions a tool or rule handles", () => {
    const decision = decideFromRouter({ humanRequested: false, actions: ["send_link", "request_discount"] });
    expect(decision.escalate).toBe(false);
  });

  it("escalates an action no tool can perform", () => {
    expect(decideFromRouter({ humanRequested: false, actions: ["move_or_refund_money"] })).toEqual({
      escalate: true,
      reasonCode: "MONEY_MOVE_OR_REFUND_ACTION",
      secondaryReasonCodes: [],
      decidedBy: "router_policy",
      category: "policy_required",
    });
  });

  it("escalates the whole message when one part needs a person", () => {
    const decision = decideFromRouter({ humanRequested: false, actions: ["send_link", "contact_clinic"] });
    expect(decision).toMatchObject({ escalate: true, reasonCode: "CLINIC_CONTACT_ACTION" });
  });

  it("picks one primary code in table order and keeps the rest as secondary", () => {
    const decision = decideFromRouter({
      humanRequested: true,
      actions: ["arrange_call", "hold_or_verify_date", "contact_clinic"],
    });
    expect(decision.reasonCode).toBe("HUMAN_REQUESTED");
    expect(decision.secondaryReasonCodes).toEqual([
      "CLINIC_CONTACT_ACTION",
      "DATE_HOLD_OR_AVAILABILITY_ACTION",
      "CALL_REQUEST",
    ]);
  });

  it("treats an unmapped action as an avoidable escalation", () => {
    expect(decideFromRouter({ humanRequested: false, actions: ["other_action"] })).toMatchObject({
      escalate: true,
      reasonCode: "LOW_CONFIDENCE",
      category: "avoidable",
    });
  });

  it("records guard decisions as decided by the guard", () => {
    const decision = decideFromGuard([
      { reasonCode: "PAYMENT_ACTION_NO_TOOL", rule: "instruction_to_charge_a_card" },
      { reasonCode: "HUMAN_REQUESTED", rule: "asks_to_talk_to_a_human" },
    ]);
    expect(decision).toMatchObject({
      escalate: true,
      reasonCode: "HUMAN_REQUESTED",
      secondaryReasonCodes: ["PAYMENT_ACTION_NO_TOOL"],
      decidedBy: "guard",
    });
    expect(decideFromGuard([]).escalate).toBe(false);
  });

  it("records a system failure as an avoidable fallback", () => {
    expect(systemFailureDecision()).toEqual({
      escalate: true,
      reasonCode: "SYSTEM_FAILURE",
      secondaryReasonCodes: [],
      decidedBy: "validator_fallback",
      category: "avoidable",
    });
  });
});
