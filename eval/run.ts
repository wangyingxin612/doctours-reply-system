// npm run eval -- [--only id,id] [--tag tag] [--split dev|holdout] [--repeat n] [--concurrency n] [--run-id id]
// Runs the eval cases through the real pipeline with real model calls, and checks each reply.
// With --repeat, each case runs n times, and the report shows how often `escalate` flips between runs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadModelConfig } from "../config/models";
import { buildPacketContext } from "../src/context/fixture";
import { createAnswerStage, currentPolicyVersion } from "../src/pipeline/answer";
import { DEFAULT_CONCURRENCY, respondToMessages } from "../src/pipeline/batch";
import { FatalRunError } from "../src/pipeline/errors";
import type { Trace } from "../src/trace/types";
import { caseSchema, checkCase, type CaseResult, type EvalCase } from "./assert";

const EVAL_DIR = import.meta.dirname;

type LoadedCase = EvalCase & { text: string };

function loadCases(): LoadedCase[] {
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

interface CaseRuns {
  testCase: LoadedCase;
  runs: CaseResult[];
}

function report(cases: readonly CaseRuns[], traces: readonly Trace[], repeat: number): boolean {
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

  const answered = traces.filter((trace) => trace.modelCalls.length > 0);
  const tokens = (stage: string) =>
    answered.reduce(
      (sum, trace) =>
        sum +
        trace.modelCalls
          .filter((call) => (stage === "router" ? call.stage === "router" : call.stage !== "router"))
          .reduce((inner, call) => inner + call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens, 0),
      0,
    );
  if (answered.length > 0) {
    console.log("\nModel input per message that reached a model:");
    console.log(`  router     ${Math.round(tokens("router") / answered.length)} tokens`);
    console.log(`  responder  ${Math.round(tokens("responder") / answered.length)} tokens (cached and uncached)`);
    console.log(`  repairs    ${traces.filter((trace) => trace.repairAttempts > 0).length} of ${traces.length} messages`);
  }

  const passedCases = cases.filter(({ runs }) => runs.every((run) => run.passed)).length;
  console.log(`\n${passedCases}/${cases.length} cases passed${repeat > 1 ? " on every run" : ""}.`);
  return passedCases === cases.length;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      tag: { type: "string" },
      split: { type: "string" },
      repeat: { type: "string" },
      concurrency: { type: "string" },
      "run-id": { type: "string" },
    },
  });

  if (existsSync(".env")) process.loadEnvFile(".env");

  const repeat = Math.max(1, Number(values.repeat ?? 1));
  const only = values.only ? new Set(values.only.split(",")) : null;
  const cases = loadCases().filter(
    (testCase) =>
      (!only || only.has(testCase.id)) &&
      (!values.tag || testCase.tags.includes(values.tag)) &&
      (!values.split || testCase.split === values.split),
  );
  if (cases.length === 0) throw new Error("No eval case matches the filters.");

  const runId = values["run-id"] ?? `eval-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`;
  const traceDir = join("traces", runId);
  const context = buildPacketContext();

  // Run 1 of every case, then run 2 of every case, and so on: repeats of one case are spread out in time.
  const items = Array.from({ length: repeat }, (_, round) =>
    cases.map(({ id, text }) => ({ id: repeat > 1 ? `${id}#${round + 1}` : id, text })),
  ).flat();

  console.log(`Running ${cases.length} case(s)${repeat > 1 ? `, ${repeat} times each` : ""}. Traces: ${traceDir}\n`);
  const { replies, traces } = await respondToMessages(items, {
    runId,
    concurrency: Number(values.concurrency ?? process.env.CONCURRENCY ?? DEFAULT_CONCURRENCY),
    traceDir,
    deps: {
      context,
      config: loadModelConfig(),
      policyVersion: currentPolicyVersion(context.vertical),
      answer: createAnswerStage(),
    },
  });

  const grouped: CaseRuns[] = cases.map((testCase, index) => ({
    testCase,
    runs: Array.from({ length: repeat }, (_, round) => {
      const position = round * cases.length + index;
      return checkCase(testCase, replies[position]!, traces[position]!);
    }),
  }));

  if (!report(grouped, traces, repeat)) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  if (error instanceof FatalRunError) {
    console.error(`Error: ${error.message}`);
    process.exit(2);
  }
  throw error;
}
