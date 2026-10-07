// The escalation decision. Inputs are classifications; the tables decide.

import type { GuardHit } from "../pipeline/guard";
import { handlingOf, type ActionType } from "./actions";
import { ESCALATION_TABLE, REASON_CODES, type EscalationCategory, type ReasonCode } from "./escalation";

export type DecidedBy = "guard" | "router_policy" | "validator_fallback" | "none";

export interface EscalationDecision {
  escalate: boolean;
  /** One primary code per message, so per-code rates add up to the total rate. */
  reasonCode: ReasonCode | null;
  /** Other codes that also applied. Trace only. */
  secondaryReasonCodes: ReasonCode[];
  decidedBy: DecidedBy;
  category: EscalationCategory | null;
}

export interface RouterClassification {
  humanRequested: boolean;
  actions: ActionType[];
}

const NO_ESCALATION: EscalationDecision = {
  escalate: false,
  reasonCode: null,
  secondaryReasonCodes: [],
  decidedBy: "none",
  category: null,
};

function byPriority(codes: Iterable<ReasonCode>): ReasonCode[] {
  const present = new Set(codes);
  return REASON_CODES.filter((code) => present.has(code) && ESCALATION_TABLE[code].escalate);
}

function decision(codes: ReasonCode[], decidedBy: DecidedBy): EscalationDecision {
  const [primary, ...secondary] = codes;
  if (primary === undefined) return NO_ESCALATION;
  return {
    escalate: true,
    reasonCode: primary,
    secondaryReasonCodes: secondary,
    decidedBy,
    category: ESCALATION_TABLE[primary].category,
  };
}

export function codesFromRouter(classification: RouterClassification): ReasonCode[] {
  const codes: ReasonCode[] = [];
  if (classification.humanRequested) codes.push("HUMAN_REQUESTED");
  for (const action of classification.actions) {
    const handling = handlingOf(action);
    if (handling.by === "escalation") codes.push(handling.reasonCode);
  }
  return codes;
}

/** Guard hits decide alone: when the guard fires, the router is never called. */
export function decideFromGuard(hits: GuardHit[]): EscalationDecision {
  return decision(byPriority(hits.map((hit) => hit.reasonCode)), "guard");
}

export function decideFromRouter(classification: RouterClassification): EscalationDecision {
  return decision(byPriority(codesFromRouter(classification)), "router_policy");
}

/** A model error, a refusal, or a reply that still fails validation after one repair. */
export function systemFailureDecision(): EscalationDecision {
  return decision(["SYSTEM_FAILURE"], "validator_fallback");
}
