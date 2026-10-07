// npm run eval -- [--only id,id] [--tag tag] [--split dev|holdout] [--concurrency n] [--run-id id]
// Runs the eval cases through the real pipeline with real model calls, and checks each reply.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadModelConfig } from "../config/models";
import { buildPacketContext } from "../src/context/fixture";
import { createAnswerStage, currentPolicyVersion } from "../src/pipeline/answer";
import { DEFAULT_CONCURRENCY, respondToMessages } from "../src/pipeline/batch";
import { FatalRunError } from "../src/pipeline/errors";
import { caseSchema, checkCase, type CaseResult, type EvalCase } from "./assert";

const EVAL_DIR = import.meta.dirname;

function loadCases(): Array<EvalCase & { text: string }> {
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

function printResults(results: readonly CaseResult[]): void {
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.id}  [${result.tags.join(", ")}]`);
    for (const failure of result.failures) console.log(`      ${failure}`);
  }

  const tags = [...new Set(results.flatMap((result) => result.tags))].sort();
  console.log("\nBy behavior tag:");
  for (const tag of tags) {
    const tagged = results.filter((result) => result.tags.includes(tag));
    const passed = tagged.filter((result) => result.passed).length;
    console.log(`  ${tag.padEnd(22)} ${passed}/${tagged.length}`);
  }

  const escalated = results.filter((result) => result.actualEscalate);
  const shouldEscalate = results.filter((result) => result.expectedEscalate);
  const correct = escalated.filter((result) => result.expectedEscalate).length;
  console.log("\nEscalation on this set:");
  console.log(`  rate       ${percent(escalated.length, results.length)} (${escalated.length}/${results.length}); expected ${percent(shouldEscalate.length, results.length)}`);
  console.log(`  precision  ${percent(correct, escalated.length)} of escalated replies should have escalated`);
  console.log(`  recall     ${percent(correct, shouldEscalate.length)} of cases that should escalate did`);

  const passedCount = results.filter((result) => result.passed).length;
  console.log(`\n${passedCount}/${results.length} cases passed.`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      tag: { type: "string" },
      split: { type: "string" },
      concurrency: { type: "string" },
      "run-id": { type: "string" },
    },
  });

  if (existsSync(".env")) process.loadEnvFile(".env");

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

  console.log(`Running ${cases.length} case(s). Traces: ${traceDir}\n`);
  const { replies, traces } = await respondToMessages(
    cases.map(({ id, text }) => ({ id, text })),
    {
      runId,
      concurrency: Number(values.concurrency ?? process.env.CONCURRENCY ?? DEFAULT_CONCURRENCY),
      traceDir,
      deps: {
        context,
        config: loadModelConfig(),
        policyVersion: currentPolicyVersion(context.vertical),
        answer: createAnswerStage(),
      },
    },
  );

  const results = cases.map((testCase, index) => checkCase(testCase, replies[index]!, traces[index]!));
  printResults(results);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
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
