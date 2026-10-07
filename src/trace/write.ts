import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCallRecord } from "../tools/ledger";
import type { ToolCallTrace, Trace } from "./types";

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return "{…}";
  if (typeof value === "string") return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}…` : value);
  return String(value);
}

/** A one-line description of a tool result: its top-level fields, with nested data reduced to sizes. */
export function summarizeResult(output: unknown): string {
  if (output === null || output === undefined || typeof output !== "object" || Array.isArray(output)) {
    return describeValue(output);
  }
  const fields = Object.entries(output).map(([key, value]) => `${key}: ${describeValue(value)}`);
  return `{ ${fields.join(", ")} }`;
}

export function toToolCallTraces(calls: readonly ToolCallRecord[]): ToolCallTrace[] {
  return calls.map((call) => ({
    name: call.name,
    kind: call.kind,
    source: call.source,
    input: call.input,
    result: summarizeResult(call.output),
  }));
}

/** File name for a trace: position in the input, then the message id made safe for a file system. */
export function traceFileName(index: number, messageId: string): string {
  const safeId = messageId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "message";
  return `${String(index).padStart(4, "0")}-${safeId}.json`;
}

export function writeTrace(runDir: string, trace: Trace): string {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, traceFileName(trace.index, trace.messageId));
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`);
  return path;
}
