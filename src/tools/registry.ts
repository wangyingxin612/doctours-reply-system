// Names, kinds and input shapes for the packet's tools. These are the only tools the system has.
// Names keep the spelling the original prompt uses, so skill text can refer to them unchanged.

import { z } from "zod";
import * as packet from "./packet";

export type ToolKind = "read" | "write";

/** "model": the responder may call it when a loaded skill allows it. "code": only pipeline code calls it. */
export type ToolExposure = "model" | "code";

export interface ToolDefinition {
  kind: ToolKind;
  exposure: ToolExposure;
  description: string;
  inputSchema: z.ZodType;
  run: (input: unknown) => unknown;
}

const clinicRef = z.object({ clinicId: z.string().optional(), clinicName: z.string().optional() });
const userRef = z.object({ userId: z.string().optional() });

function define<Input>(
  definition: Omit<ToolDefinition, "run"> & { run: (input: Input) => unknown },
): ToolDefinition {
  return { ...definition, run: (input) => definition.run(input as Input) };
}

export const TOOL_REGISTRY = {
  getAllClinicsTool: define({
    kind: "read",
    exposure: "model",
    description: "Basic information for every partner clinic: name, id, slug, address, clinic_flags and ai_context.",
    inputSchema: z.object({}),
    run: () => packet.getAllClinics(),
  }),
  getClinicPackagesTool: define({
    kind: "read",
    exposure: "model",
    description:
      "Packages for one clinic: name, basePrice, depositAmount, currency, bookableWeekdays, included add-ons and aiContext. Accepts a clinic name or ID.",
    inputSchema: clinicRef,
    run: packet.getClinicPackages,
  }),
  getClinicDoctorsTool: define({
    kind: "read",
    exposure: "model",
    description: "Doctors for one clinic. Accepts a clinic ID or a clinic name.",
    inputSchema: clinicRef,
    run: packet.getClinicDoctors,
  }),
  getSavedClinicsTool: define({
    kind: "read",
    exposure: "model",
    description: "The clinics recommended in the patient's assessment.",
    inputSchema: userRef,
    run: packet.getSavedClinics,
  }),
  getPatientContextTool: define({
    kind: "read",
    exposure: "model",
    description:
      "Patient profile, pipeline status, clinic and package selection, and saved tentative procedure dates.",
    inputSchema: userRef,
    run: packet.getPatientContext,
  }),
  getLatestAssessmentTool: define({
    kind: "read",
    exposure: "model",
    description: "The patient's personal assessment link (assessmentUrl) and its share status.",
    inputSchema: userRef,
    run: packet.getLatestAssessment,
  }),
  getPatientImagesTool: define({
    kind: "read",
    exposure: "model",
    description: "Which intake photo angles the patient has uploaded, with their hosted URLs.",
    inputSchema: userRef,
    run: packet.getPatientImages,
  }),
  getConsultationRescheduleLinkTool: define({
    kind: "read",
    exposure: "model",
    description: "The trusted reschedule link for the patient's consultation call.",
    inputSchema: userRef,
    run: packet.getConsultationRescheduleLink,
  }),
  getFullCallsTool: define({
    kind: "read",
    exposure: "model",
    description: "Full call records for this chat, with summaries and transcripts.",
    inputSchema: z.object({ chatId: z.string().optional(), limit: z.number().optional() }),
    run: packet.getFullCalls,
  }),
  // Which link to send is a control decision, so code fetches payment links. The model never does.
  getPaymentLinkTool: define({
    kind: "read",
    exposure: "code",
    description: "The trusted deposit payment or checkout URL.",
    inputSchema: z.object({
      clinicPackageId: z.string().optional(),
      type: z.string().optional(),
      clinicId: z.string().optional(),
    }),
    run: packet.getPaymentLink,
  }),
  issuePromoCodeTool: define({
    kind: "write",
    exposure: "code",
    description: "Issues the promo code for a patient who was offered a campaign.",
    inputSchema: userRef,
    run: packet.issuePromoCode,
  }),
  updateUserTool: define({
    kind: "write",
    exposure: "code",
    description: "Saves the patient's name when none is on file.",
    inputSchema: z.object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      userId: z.string().optional(),
    }),
    run: packet.updateUser,
  }),
  updateUserClinicPreferencesTool: define({
    kind: "write",
    exposure: "code",
    description: "Saves clinic and package selection and tentative procedure dates.",
    inputSchema: z.object({
      clinicSelection: z.record(z.string(), z.unknown()).optional(),
      tentativeProcedureDates: z.object({ text: z.string(), strength: z.string() }).optional(),
      userId: z.string().optional(),
    }),
    run: packet.updateUserClinicPreferences,
  }),
  updateWorkingMemoryTool: define({
    kind: "write",
    exposure: "code",
    description: "Stores working-memory updates.",
    inputSchema: z.object({ memory: z.record(z.string(), z.unknown()).optional() }),
    run: packet.updateWorkingMemory,
  }),
} as const satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOL_REGISTRY;

export const TOOL_NAMES = Object.keys(TOOL_REGISTRY) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_REGISTRY, name);
}

/** Tools a skill may hand to the model: read-only and not reserved for code. */
export function isModelCallable(name: ToolName): boolean {
  const definition: ToolDefinition = TOOL_REGISTRY[name];
  return definition.kind === "read" && definition.exposure === "model";
}
