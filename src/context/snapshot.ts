// Text views of the patient context. These are data for the models, built by code.

import type { PatientContext } from "./types";

/** The last few lines of the transcript. A transcript line that is only a URL stays with its message. */
export function recentTurns(context: PatientContext, turns: number): string {
  const lines = context.text.chatList.split("\n");
  const starts = lines.flatMap((line, index) => (line.startsWith("[") ? [index] : []));
  const from = starts[Math.max(0, starts.length - turns)] ?? 0;
  return lines.slice(from).join("\n");
}

/** What the router sees of the patient: enough to read the message in context, and nothing more. */
export function routerSnapshot(context: PatientContext): string {
  return [
    "# Patient",
    context.text.patientSummary,
    "",
    "# Clinic flags",
    context.text.clinicFlags,
    "",
    "# Recent conversation",
    recentTurns(context, 6),
  ].join("\n");
}

/**
 * What the responder sees of the patient. The headings follow the original prompt's workflow section.
 * The conversation itself arrives in the user message, as the packet's template has it, so it is not repeated here.
 */
export function patientContextBlock(context: PatientContext): string {
  return [
    "# PATIENT CONTEXT",
    "",
    `Current Date/Time: ${context.now}`,
    `Chat kind: ${context.chatKind}`,
    `Patient-facing coordinator name: ${context.coordinatorName}`,
    `Triggering sender: ${context.sender.displayName} (${context.sender.role})`,
    "",
    "## Patient Summary",
    context.text.patientSummary,
    "",
    "## Clinic flags",
    context.text.clinicFlags,
    "",
    "## Working memory",
    JSON.stringify(context.workingMemory),
    "",
    "## Recent Calls",
    context.text.recentCalls,
  ].join("\n");
}

/** Clinic names as the workflow lists them in the clinic flags, for example "Heva Clinic". */
export function knownClinicNames(context: PatientContext): string[] {
  return context.text.clinicFlags
    .split("\n")
    .map((line) => /^-\s*([^:]+):/.exec(line)?.[1]?.trim())
    .filter((name): name is string => Boolean(name));
}
