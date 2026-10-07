// npm run baseline -- [--only id,id] [--tag tag] [--split dev|holdout] [--concurrency n] [--run-id id]
// Runs the eval cases through the original prompt, with real model calls, and checks each reply the
// way `npm run eval` does. Same model, same effort, same cases, so the two printouts compare.
// Reason codes are the one check left out: the original prompt has none.
// Records go to traces/<run-id>/baseline.jsonl. They are not pipeline traces, so `npm run report` does not read them.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadModelConfig } from "../../config/models";
import { DEFAULT_CONCURRENCY, mapWithConcurrency } from "../../src/pipeline/batch";
import { FatalRunError } from "../../src/pipeline/errors";
import { defaultRunId, report, selectCases, type LoadedCase } from "../lib";
import { originalSystemPrompt, runBaselineCase, type BaselineRecord } from "./original";

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

  const cases = selectCases(values);
  const runId = values["run-id"] ?? defaultRunId("baseline");
  const runDir = join("traces", runId);
  const file = join(runDir, "baseline.jsonl");
  const config = loadModelConfig();
  const system = originalSystemPrompt();
  mkdirSync(runDir, { recursive: true });
  writeFileSync(file, "");

  // One line per case, written as each case finishes, so a run that stops early keeps what it has.
  const run = async (testCase: LoadedCase, index: number): Promise<BaselineRecord> => {
    const record = await runBaselineCase(testCase, system, { config });
    appendFileSync(file, `${JSON.stringify({ runId, index, ...record })}\n`);
    return record;
  };

  console.log(`Running ${cases.length} case(s) through the original prompt: ${system.length.toLocaleString("en-US")} characters on every model call. Records: ${file}\n`);

  // The first case runs alone, so its call writes the prompt to the cache and the others read it.
  const [first, ...others] = cases;
  const concurrency = Number(values.concurrency ?? process.env.CONCURRENCY ?? DEFAULT_CONCURRENCY);
  const records = [
    await run(first!, 0),
    ...(await mapWithConcurrency(others, concurrency, (testCase, index) => run(testCase, index + 1))),
  ];

  report(
    cases.map((testCase, index) => ({ testCase, runs: [records[index]!.result] })),
    records,
    1,
  );
  console.log("\nReason codes were not checked: the original prompt has none.");
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
