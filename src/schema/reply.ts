// The output contract from docs/packet.md. Strict: no extra keys, at the top level or nested.

import { z } from "zod";

export const COLLECTION_ITEMS = ["area", "name", "photos", "none"] as const;
export const COMMUNICATION_STYLES = ["detailed", "concise", "casual", "formal", "unknown"] as const;
export const PAYMENT_METHODS = ["financing", "layaway", "pay_in_full", "cash_preference", "unknown"] as const;
export const PROCEDURE_WINDOWS = [
  "within_3_months",
  "within_6_months",
  "within_8_months",
  "within_12_months",
  "over_12_months",
  "unknown",
] as const;

const askCount = z.number().nullable().optional();

export const collectionStateSchema = z.strictObject({
  areaAskCount: askCount,
  lastAskedItem: z.enum(COLLECTION_ITEMS).nullable().optional(),
  nameAskCount: askCount,
  photoAskCount: askCount,
});

export const workingMemoryUpdatesSchema = z.strictObject({
  collectionState: collectionStateSchema.nullable().optional(),
  communicationStyle: z.enum(COMMUNICATION_STYLES).nullable().optional(),
  escalationFlags: z.string().nullable().optional(),
  keyConcerns: z.string().nullable().optional(),
  patientName: z.string().nullable().optional(),
  preferredPaymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
  procedureArea: z.string().nullable().optional(),
  promisesMade: z.string().nullable().optional(),
  targetProcedureWindow: z.enum(PROCEDURE_WINDOWS).nullable().optional(),
});

export const MAX_ATTACHMENTS = 3;

export const replySchema = z.strictObject({
  response: z.string(),
  escalate: z.boolean(),
  escalationReason: z.string().nullable(),
  templateId: z.null(),
  intent: z.string(),
  shouldFollowUp: z.boolean(),
  followUpTiming: z.string().nullable(),
  attachmentUrls: z.array(z.string()).max(MAX_ATTACHMENTS).nullable(),
  highEngagement: z.boolean(),
  workingMemoryUpdates: workingMemoryUpdatesSchema.nullable(),
});

export type Reply = z.infer<typeof replySchema>;
export type WorkingMemoryUpdates = z.infer<typeof workingMemoryUpdatesSchema>;
export type CollectionState = z.infer<typeof collectionStateSchema>;

/** The CLI input: the same shape as the packet's HUMAN_MESSAGES. */
export const incomingMessageSchema = z.object({ id: z.string(), text: z.string() });
export const incomingMessagesSchema = z.array(incomingMessageSchema);
export type IncomingMessage = z.infer<typeof incomingMessageSchema>;
