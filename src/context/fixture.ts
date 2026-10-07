// The one patient context the packet defines, as a typed object.

import { workingMemoryUpdatesSchema } from "../schema/reply";
import * as packet from "./packet";
import type { FinancingEligibility, PatientContext } from "./types";

/** From the "Current Date/Time" line of the packet's system prompt. */
export const PACKET_NOW = "September 27, 2026 at 07:37 PM UTC";

function financingEligibility(flag: boolean | null | undefined): FinancingEligibility {
  if (flag === true) return "yes";
  if (flag === false) return "no";
  return "unknown";
}

export function buildPacketContext(): PatientContext {
  return {
    now: PACKET_NOW,
    vertical: "hair",
    tier: packet.TIER,
    userId: packet.USER_ID,
    chatId: packet.SUPABASE_CHAT_ID,
    threadId: packet.THREAD_ID,
    chatKind: packet.CHAT_KIND,
    coordinatorName: packet.COORDINATOR_DISPLAY_NAME,
    sender: {
      displayName: packet.SENDER_DISPLAY_NAME,
      role: packet.SENDER_PARTICIPANT_ROLE,
      participantId: packet.SENDER_PARTICIPANT_ID,
      userId: packet.SENDER_USER_ID,
    },
    patient: {
      name: packet.PATIENT_NAME,
      sex: packet.PATIENT_SEX,
      email: packet.PATIENT_EMAIL,
      phone: packet.PATIENT_PHONE,
      countryCode: packet.PATIENT_COUNTRY_CODE,
      financingEligible: financingEligibility(packet.KLARNA_PAYPAL_FINANCING_ELIGIBLE),
    },
    pipelineStatus: packet.PIPELINE_STATUS,
    consultation: {
      time: packet.CONSULTATION_TIME,
      id: packet.CONSULTATION_ID,
    },
    booking: {
      hasActive: packet.HAS_ACTIVE_BOOKING,
      bookings: packet.BOOKINGS,
      selectedClinic: packet.SELECTED_CLINIC,
    },
    procedure: {
      area: packet.PROCEDURE_AREA,
      interest: packet.PROCEDURE_INTEREST,
      estimatedGrafts: packet.ESTIMATED_GRAFTS,
      graftRange: packet.GRAFT_RANGE,
    },
    savedClinicCount: packet.SAVED_CLINIC_COUNT,
    images: {
      hasImages: packet.HAS_PATIENT_IMAGES,
      count: packet.PATIENT_IMAGE_COUNT,
    },
    promoOffer: packet.PROMO_OFFER,
    intakeQa: packet.WEBSITE_INTAKE_QA,
    workingMemory: workingMemoryUpdatesSchema.parse(JSON.parse(packet.WORKING_MEMORY)),
    text: {
      patientSummary: packet.PATIENT_SUMMARY,
      clinicFlags: packet.CLINIC_FLAGS,
      recentCalls: packet.RECENT_CALLS,
      chatList: packet.CHAT_LIST,
      recentConversationSummary: packet.RECENT_CONVERSATION_SUMMARY,
      collectionStatus: packet.COLLECTION_STATUS,
    },
  };
}
