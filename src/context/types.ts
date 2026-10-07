import type { WorkingMemoryUpdates } from "../schema/reply";

export type FinancingEligibility = "yes" | "no" | "unknown";

/** Working memory as the upstream workflow stores it. Same fields as the updates the reply can send. */
export type WorkingMemory = WorkingMemoryUpdates;

export interface PatientContext {
  /** The packet's fixed clock. Runs never read the system clock, so they are reproducible. */
  now: string;
  /** Line of care. Selects the skills folder. */
  vertical: string;
  tier: string;
  userId: string;
  chatId: string;
  threadId: string;
  chatKind: string;
  coordinatorName: string;
  sender: {
    displayName: string;
    role: string;
    participantId: string;
    userId: string;
  };
  patient: {
    name: string | null;
    sex: string | null;
    email: string | null;
    phone: string | null;
    countryCode: string | null;
    financingEligible: FinancingEligibility;
  };
  pipelineStatus: string;
  consultation: {
    time: string | null;
    id: string | null;
  };
  booking: {
    hasActive: boolean;
    bookings: readonly unknown[];
    selectedClinic: unknown;
  };
  procedure: {
    area: string | null;
    interest: string | null;
    estimatedGrafts: number | null;
    graftRange: { min: number; max: number } | null;
  };
  savedClinicCount: number;
  images: {
    hasImages: boolean;
    count: number;
  };
  promoOffer: unknown;
  intakeQa: ReadonlyArray<{ question: string; answer: string }>;
  workingMemory: WorkingMemory;
  /** Text blocks the upstream workflow already formatted. They reach the model as data, never as rules. */
  text: {
    patientSummary: string;
    clinicFlags: string;
    recentCalls: string;
    chatList: string;
    recentConversationSummary: string;
    collectionStatus: string;
  };
}
