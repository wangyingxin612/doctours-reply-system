// The action catalog: for each kind of thing a patient can ask us to do, how it is handled.
// The router only names the type. This table decides what happens. Flipping a row is a policy change.

import type { ReasonCode } from "./escalation";

export type ActionHandling =
  /** No tool and no rule can do it. A person takes over. */
  | { by: "escalation"; reasonCode: ReasonCode }
  /** Code does it with a tool. */
  | { by: "tool"; how: string }
  /** A rule from the original prompt answers it, usually a plain decline plus what the patient can do. */
  | { by: "skill"; skill: string };

export interface ActionRule {
  handling: ActionHandling;
  /** Shown to the router. */
  definition: string;
  /** Shown to the router: near misses that are not this action. */
  notThis?: string;
}

export const ACTION_CATALOG = {
  charge_card: {
    handling: { by: "escalation", reasonCode: "PAYMENT_ACTION_NO_TOOL" },
    definition: "Asks us to charge, run or bill a card, or sends card details to pay.",
    notThis:
      "Asking how or where to pay, asking for a payment link, saying they are ready to pay, or asking which cards are accepted.",
  },
  move_or_refund_money: {
    handling: { by: "escalation", reasonCode: "MONEY_MOVE_OR_REFUND_ACTION" },
    definition:
      "Asks us to move, transfer, reallocate or refund money that was already paid, whether through Doctours or directly to a clinic.",
    notThis:
      "Asking what the refund, cancellation or transfer terms are. Telling us they paid a clinic directly, or asking whether that counts or whether they must pay again.",
  },
  contact_clinic: {
    handling: { by: "escalation", reasonCode: "CLINIC_CONTACT_ACTION" },
    definition:
      "Asks us to contact, call, email or message a clinic, hotel, medical team or other third party for them, including to ask it to hold a date. Also a repeat request for the clinic's phone number, WhatsApp or email after the thread already answered a first one.",
    notThis:
      "A first request for a clinic contact. Asking whether they can message the clinic themselves. Asking for the clinic's website.",
  },
  hold_or_verify_date: {
    handling: { by: "escalation", reasonCode: "DATE_HOLD_OR_AVAILABILITY_ACTION" },
    definition:
      "Asks us to hold, reserve or pencil in a specific date or week without paying, or to check or confirm that a specific date is open.",
    notThis:
      "General questions about availability, busy months, how a date gets confirmed, or which weekdays can be booked.",
  },
  change_booking: {
    handling: { by: "escalation", reasonCode: "BOOKING_CHANGE_ACTION" },
    definition:
      "Asks us to change, cancel or move a booking or procedure date, or to add or change something on a booking, such as a companion, a hotel stay or a transfer.",
    notThis: "Rescheduling the free consultation call. Asking whether a date can be moved later.",
  },
  match_or_honor_price: {
    handling: { by: "escalation", reasonCode: "PRICE_NEGOTIATION" },
    definition:
      "Asks us to match a clinic's direct quote or another provider's price, or to honor a price or discount they claim from a screenshot, an ad or an earlier conversation.",
    notThis: "Only sharing a quote. Asking whether a discount or promo exists. Asking for a discount in general.",
  },
  arrange_call: {
    handling: { by: "escalation", reasonCode: "CALL_REQUEST" },
    definition: "Asks for a callback, or for a phone or video call with the coordinator, a surgeon or the clinic.",
    notThis: "Asking about, booking or rescheduling the free consultation call.",
  },
  other_action: {
    handling: { by: "escalation", reasonCode: "LOW_CONFIDENCE" },
    definition: "A concrete request for us to do something that fits no other type in this list.",
    notThis: "Any question, including a question about whether or how something can be done.",
  },

  send_link: {
    handling: { by: "tool", how: "link plan" },
    definition:
      "Asks us, in so many words, to send a link: payment, checkout, assessment, consultation booking, photo upload or a clinic page. Includes saying they are ready to pay or book now.",
    notThis: "Asking whether or how they can pay, book or upload. That is a question.",
  },
  reschedule_consultation: {
    handling: { by: "tool", how: "getConsultationRescheduleLinkTool" },
    definition: "Asks to move or rebook the free consultation call.",
  },
  send_own_photos: {
    handling: { by: "tool", how: "getPatientImagesTool" },
    definition: "Asks to see or get back the photos they uploaded.",
  },

  schedule_follow_up: {
    handling: { by: "skill", skill: "pause-followup" },
    definition: "Asks us to check back later, or says they need time before the next step.",
  },
  revise_assessment: {
    handling: { by: "skill", skill: "assessment" },
    definition: "Asks to change the hairline, the graft plan, the assessment or the recommended clinics.",
  },
  add_assessment_note: {
    handling: { by: "skill", skill: "assessment" },
    definition: "Asks us to add a note or a preference to the assessment.",
  },
  send_document_or_form: {
    handling: { by: "skill", skill: "core" },
    definition:
      "Asks us to send, fill in, email or file a document, letter, form, or insurance or financing paperwork.",
  },
  share_clinic_contact: {
    handling: { by: "skill", skill: "clinic-website-contact" },
    definition:
      "Asks for the clinic's phone number, WhatsApp or email for the first time, or asks whether they can message the clinic themselves.",
  },
  arrange_travel: {
    handling: { by: "skill", skill: "travel" },
    definition: "Asks us to find or book flights for them.",
    notThis: "Adding a person, a hotel night or a transfer to a booking. That is a booking change.",
  },
  request_discount: {
    handling: { by: "skill", skill: "pricing-promos" },
    definition: "Asks for a discount or a promo code.",
  },
  creator_partnership: {
    handling: { by: "skill", skill: "creator-partnership" },
    definition: "Proposes a creator, influencer or brand partnership.",
  },
} as const satisfies Record<string, ActionRule>;

export type ActionType = keyof typeof ACTION_CATALOG;

export const ACTION_TYPES = Object.keys(ACTION_CATALOG) as ActionType[];

export function handlingOf(type: ActionType): ActionHandling {
  return ACTION_CATALOG[type].handling;
}
