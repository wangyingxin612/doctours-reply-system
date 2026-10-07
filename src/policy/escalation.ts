// The escalation table: what each reason code means for the reply. Edit a row here, bump
// POLICY_VERSION, and the Monday report can tie a change in the rate to that edit.

import type { Reply } from "../schema/reply";

export const POLICY_VERSION = "2026-10-07.1";

/** Listed in priority order. When several codes apply to one message, the first one is primary. */
export const REASON_CODES = [
  "HUMAN_REQUESTED",
  "PAYMENT_ACTION_NO_TOOL",
  "MONEY_MOVE_OR_REFUND_ACTION",
  "CLINIC_CONTACT_ACTION",
  "DATE_HOLD_OR_AVAILABILITY_ACTION",
  "BOOKING_CHANGE_ACTION",
  "PRICE_NEGOTIATION",
  "CALL_REQUEST",
  "SYSTEM_FAILURE",
  "LOW_CONFIDENCE",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** policy_required moves with what patients ask for. avoidable is ours to push down. */
export type EscalationCategory = "policy_required" | "avoidable";

export interface EscalationRule {
  escalate: boolean;
  category: EscalationCategory;
  /** One short sentence before the handoff sentence. Null means the handoff sentence alone. */
  decline: string | null;
  escalationReason: string;
  /** True where the request itself shows the patient is trying to pay or book. */
  highEngagement: boolean;
}

export const HANDOFF_SENTENCE = "I'm bringing in a person to help you.";

export const ESCALATION_INTENT = "hand off to a person";

export const ESCALATION_TABLE: Record<ReasonCode, EscalationRule> = {
  HUMAN_REQUESTED: {
    escalate: true,
    category: "policy_required",
    decline: null,
    escalationReason: "Patient asked for a person",
    highEngagement: false,
  },
  PAYMENT_ACTION_NO_TOOL: {
    escalate: true,
    category: "policy_required",
    decline: "Charging a card isn't something I can do.",
    escalationReason: "Patient asked us to charge a card",
    highEngagement: true,
  },
  MONEY_MOVE_OR_REFUND_ACTION: {
    escalate: true,
    category: "policy_required",
    decline: "Moving or refunding a payment isn't something I can do myself.",
    escalationReason: "Patient asked us to move or refund money already paid",
    highEngagement: false,
  },
  CLINIC_CONTACT_ACTION: {
    escalate: true,
    category: "policy_required",
    decline: "Contacting the clinic for you isn't something I can do.",
    escalationReason: "Patient asked us to contact the clinic",
    highEngagement: false,
  },
  DATE_HOLD_OR_AVAILABILITY_ACTION: {
    escalate: true,
    category: "policy_required",
    decline: "Holding or checking a specific date isn't something I can do.",
    escalationReason: "Patient asked us to hold or verify a date",
    highEngagement: true,
  },
  BOOKING_CHANGE_ACTION: {
    escalate: true,
    category: "policy_required",
    decline: "Changing a booking isn't something I can do directly.",
    escalationReason: "Patient asked us to change a booking",
    highEngagement: false,
  },
  PRICE_NEGOTIATION: {
    escalate: true,
    category: "policy_required",
    // No decline sentence: the original prompt says not to announce that we cannot apply a discount.
    decline: null,
    escalationReason: "Patient asked us to match or honor a price",
    highEngagement: false,
  },
  CALL_REQUEST: {
    escalate: true,
    category: "policy_required",
    decline: "A call outside the free consultation isn't something I can set up.",
    escalationReason: "Patient asked for a call outside the consultation",
    highEngagement: false,
  },
  SYSTEM_FAILURE: {
    escalate: true,
    category: "avoidable",
    decline: null,
    escalationReason: "Automated reply failed checks",
    highEngagement: false,
  },
  LOW_CONFIDENCE: {
    escalate: true,
    category: "avoidable",
    decline: null,
    escalationReason: "Could not map the requested action",
    highEngagement: false,
  },
};

export function escalationResponse(code: ReasonCode): string {
  const { decline } = ESCALATION_TABLE[code];
  return decline ? `${decline} ${HANDOFF_SENTENCE}` : HANDOFF_SENTENCE;
}

/** The whole reply for an escalated message. No model writes any part of it. */
export function buildEscalationReply(code: ReasonCode): Reply {
  const rule = ESCALATION_TABLE[code];
  return {
    response: escalationResponse(code),
    escalate: true,
    escalationReason: rule.escalationReason,
    templateId: null,
    intent: ESCALATION_INTENT,
    shouldFollowUp: false,
    followUpTiming: null,
    attachmentUrls: null,
    highEngagement: rule.highEngagement,
    workingMemoryUpdates: { escalationFlags: code },
  };
}
