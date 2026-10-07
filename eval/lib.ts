// Shared by the eval runner and the baseline runner: loading cases and printing results.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { costOf } from "../config/pricing";
import { percentile } from "../src/report/aggregate";
import type { ModelCallTrace, Trace } from "../src/trace/types";
import { caseSchema, type CaseResult, type EvalCase } from "./assert";

const EVAL_DIR = import.meta.dirname;

export type LoadedCase = EvalCase & { text: string };

export function loadCases(): LoadedCase[] {
  const cases = z.array(caseSchema).parse(JSON.parse(readFileSync(join(EVAL_DIR, "cases.json"), "utf8")));
  const packet = JSON.parse(readFileSync(join(EVAL_DIR, "packet", "messages.json"), "utf8")) as Array<{
    id: string;
    text: string;
  }>;
  const packetText = new Map(packet.map((message) => [message.id, message.text]));

  const ids = new Set<string>();
  return cases.map((testCase) => {
    if (ids.has(testCase.id)) throw new Error(`Duplicate eval case id: ${testCase.id}`);
    ids.add(testCase.id);
    const text = testCase.source === "packet" ? packetText.get(testCase.id) : testCase.text;
    if (text === undefined) throw new Error(`Eval case ${testCase.id} has no text`);
    return { ...testCase, text };
  });
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(0)}%`;
}

export interface CaseRuns {
  testCase: LoadedCase;
  runs: CaseResult[];
}

/** The parts of a trace the printed results read. A baseline record has them too. */
export type RunRecord = Pick<Trace, "failure" | "modelCalls" | "repairAttempts" | "latencyMs">;

const inputOf = (calls: readonly ModelCallTrace[]) =>
  calls.reduce((sum, call) => sum + call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens, 0);

/** Dollars for a set of calls, as run and as if every input token had been billed at the full rate. */
function costsOf(calls: readonly ModelCallTrace[]): { asRun: number; uncached: number; unpriced: string[] } {
  const unpriced = new Set<string>();
  let asRun = 0;
  let uncached = 0;
  for (const call of calls) {
    const cost = costOf(call);
    if (cost === null) {
      unpriced.add(call.model);
      continue;
    }
    asRun += cost;
    uncached += costOf({ ...call, inputTokens: inputOf([call]), cacheReadTokens: 0, cacheWriteTokens: 0 }) ?? 0;
  }
  return { asRun, uncached, unpriced: [...unpriced] };
}

/** Prints the results of a run. Returns true when every case passed on every run. */
export function report(cases: readonly CaseRuns[], traces: readonly RunRecord[], repeat: number): boolean {
  for (const { testCase, runs } of cases) {
    const passed = runs.filter((run) => run.passed).length;
    const label = passed === runs.length ? "PASS" : passed === 0 ? "FAIL" : "FLAKY";
    const count = repeat > 1 ? ` ${passed}/${runs.length}` : "";
    console.log(`${label}${count}  ${testCase.id}  [${testCase.tags.join(", ")}]`);
    const failures = new Set(runs.flatMap((run) => run.failures));
    for (const failure of failures) console.log(`      ${failure}`);
  }

  const allRuns = cases.flatMap(({ runs }) => runs);
  const line = (name: string, selected: readonly CaseResult[]) =>
    console.log(`  ${name.padEnd(22)} ${selected.filter((run) => run.passed).length}/${selected.length}`);

  console.log("\nBy behavior tag:");
  for (const tag of [...new Set(cases.flatMap(({ testCase }) => testCase.tags))].sort()) {
    line(tag, cases.filter(({ testCase }) => testCase.tags.includes(tag)).flatMap(({ runs }) => runs));
  }

  console.log("\nBy split (tune on dev only, report holdout):");
  for (const split of ["dev", "holdout"] as const) {
    line(split, cases.filter(({ testCase }) => testCase.split === split).flatMap(({ runs }) => runs));
  }

  const escalated = allRuns.filter((run) => run.actualEscalate);
  const shouldEscalate = allRuns.filter((run) => run.expectedEscalate);
  const correct = escalated.filter((run) => run.expectedEscalate).length;
  console.log("\nEscalation on this set:");
  console.log(`  rate       ${percent(escalated.length, allRuns.length)} (${escalated.length}/${allRuns.length}); expected ${percent(shouldEscalate.length, allRuns.length)}`);
  console.log(`  precision  ${percent(correct, escalated.length)} of escalated replies should have escalated`);
  console.log(`  recall     ${percent(correct, shouldEscalate.length)} of cases that should escalate did`);

  const failures = traces.filter((trace) => trace.failure !== null);
  if (failures.length > 0) {
    const causes = new Map<string, number>();
    for (const trace of failures) causes.set(trace.failure!.cause, (causes.get(trace.failure!.cause) ?? 0) + 1);
    console.log(`  failures   ${[...causes].map(([cause, count]) => `${cause}: ${count}`).join(", ")}`);
  }

  if (repeat > 1) {
    // A case flips when the same message escalates on some runs and not on others.
    const flipped = cases.filter(({ runs }) => new Set(runs.map((run) => run.actualEscalate)).size > 1);
    console.log(`\nStability over ${repeat} runs per case:`);
    console.log(`  escalate flip rate  ${percent(flipped.length, cases.length)} (${flipped.length}/${cases.length} cases)`);
    for (const { testCase, runs } of flipped) {
      console.log(`    ${testCase.id}: escalated on ${runs.filter((run) => run.actualEscalate).length} of ${runs.length} runs`);
    }
    const unstable = cases.filter(({ runs }) => new Set(runs.map((run) => run.passed)).size > 1);
    console.log(`  cases that pass on some runs only  ${unstable.length}/${cases.length}`);
  }

  const reached = traces.filter((trace) => trace.modelCalls.length > 0);
  if (reached.length > 0) {
    const calls = reached.flatMap((trace) => trace.modelCalls);
    const router = calls.filter((call) => call.stage === "router");
    const others = calls.filter((call) => call.stage !== "router");
    console.log("\nModel input per message that reached a model:");
    if (router.length > 0) console.log(`  router     ${Math.round(inputOf(router) / reached.length)} tokens`);
    console.log(`  responder  ${Math.round(inputOf(others) / reached.length)} tokens (cached and uncached)`);
    console.log(`  repairs    ${traces.filter((trace) => trace.repairAttempts > 0).length} of ${traces.length} messages`);

    const cost = costsOf(calls);
    const each = (total: number) => `${(total / traces.length).toFixed(4)} per message`;
    const latencies = reached.map((trace) => trace.latencyMs).sort((a, b) => a - b);
    const seconds = (fraction: number) => `${(percentile(latencies, fraction) / 1000).toFixed(1)} s`;
    console.log("\nCost and speed:");
    console.log(`  cost       ${cost.asRun.toFixed(2)} for ${traces.length} messages, ${each(cost.asRun)}`);
    console.log(`  no cache   ${cost.uncached.toFixed(2)}, ${each(cost.uncached)}, if every input token were billed at the full rate`);
    if (cost.unpriced.length > 0) console.log(`  not priced ${cost.unpriced.join(", ")}: those calls are not in the cost`);
    console.log(`  latency    p50 ${seconds(0.5)}, p95 ${seconds(0.95)} for messages that reached a model`);
  }

  const passedCases = cases.filter(({ runs }) => runs.every((run) => run.passed)).length;
  console.log(`\n${passedCases}/${cases.length} cases passed${repeat > 1 ? " on every run" : ""}.`);
  return passedCases === cases.length;
}

/** Applies the --only, --tag and --split filters. */
export function selectCases(filters: { only?: string; tag?: string; split?: string }): LoadedCase[] {
  const only = filters.only ? new Set(filters.only.split(",")) : null;
  const cases = loadCases().filter(
    (testCase) =>
      (!only || only.has(testCase.id)) &&
      (!filters.tag || testCase.tags.includes(filters.tag)) &&
      (!filters.split || testCase.split === filters.split),
  );
  if (cases.length === 0) throw new Error("No eval case matches the filters.");
  return cases;
}

export function defaultRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`;
}
