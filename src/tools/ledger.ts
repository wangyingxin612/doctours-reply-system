// The turn ledger: every tool call made for one message, plus the URLs and money amounts
// those calls returned. Validators check a reply against it, so nothing ungrounded ships.

import { TOOL_REGISTRY, type ToolDefinition, type ToolKind, type ToolName } from "./registry";

export type CallSource = "prefetch" | "side_effect" | "link_plan" | "responder" | "subtask" | "memory";

export interface ToolCallRecord {
  name: ToolName;
  kind: ToolKind;
  source: CallSource;
  input: unknown;
  output: unknown;
}

export interface MoneyFact {
  amount: number;
  currency: string | null;
  /** The clinic the amount belongs to, when the tool result names one. */
  clinicName: string | null;
  /** Where it came from, for example "Silver.basePrice". */
  label: string;
}

const URL_PATTERN = /^https?:\/\/\S+$/;
const MONEY_KEY = /price|amount|deposit|fee/i;
// listPrice is a compare-at number. The original prompt says never to quote it, so it grounds nothing.
const NOT_QUOTABLE = new Set(["listPrice"]);

function collectUrls(node: unknown, out: Set<string>): void {
  if (typeof node === "string") {
    if (URL_PATTERN.test(node)) out.add(node);
  } else if (Array.isArray(node)) {
    for (const child of node) collectUrls(child, out);
  } else if (node !== null && typeof node === "object") {
    for (const child of Object.values(node)) collectUrls(child, out);
  }
}

interface MoneyScope {
  clinicName: string | null;
  currency: string | null;
  owner: string;
}

function collectMoney(node: unknown, scope: MoneyScope, out: MoneyFact[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectMoney(child, scope, out);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  const inner: MoneyScope = {
    clinicName: typeof record.clinicName === "string" ? record.clinicName : scope.clinicName,
    currency: typeof record.currency === "string" ? record.currency : scope.currency,
    owner: typeof record.name === "string" ? record.name : scope.owner,
  };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && MONEY_KEY.test(key) && !NOT_QUOTABLE.has(key)) {
      out.push({
        amount: value,
        currency: inner.currency,
        clinicName: inner.clinicName,
        label: inner.owner ? `${inner.owner}.${key}` : key,
      });
    } else {
      collectMoney(value, inner, out);
    }
  }
}

export class TurnLedger {
  readonly calls: ToolCallRecord[] = [];

  /** Runs a tool and records the call. */
  call(name: ToolName, input: unknown, source: CallSource): unknown {
    const definition: ToolDefinition = TOOL_REGISTRY[name];
    const output = definition.run(input);
    this.calls.push({ name, kind: definition.kind, source, input, output });
    return output;
  }

  outputsOf(name: ToolName): unknown[] {
    return this.calls.filter((call) => call.name === name).map((call) => call.output);
  }

  /** Every URL any tool returned this turn. */
  urls(): Set<string> {
    const out = new Set<string>();
    for (const call of this.calls) collectUrls(call.output, out);
    return out;
  }

  /** The patient's own photo URLs, the only URLs a reply may attach. */
  imageUrls(): Set<string> {
    const out = new Set<string>();
    for (const output of this.outputsOf("getPatientImagesTool")) collectUrls(output, out);
    return out;
  }

  /** Every quotable money amount any tool returned this turn. */
  money(): MoneyFact[] {
    const out: MoneyFact[] = [];
    for (const call of this.calls) {
      collectMoney(call.output, { clinicName: null, currency: null, owner: "" }, out);
    }
    return out;
  }
}
