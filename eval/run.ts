// npm run eval -- [--only id,id] [--tag tag] [--split dev|holdout] [--repeat n] [--concurrency n] [--run-id id]
// Runs the eval cases through the real pipeline with real model calls, and checks each reply.
// With --repeat, each case runs n times, and the report shows how often `escalate` flips between runs.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadModelConfig } from "../config/models";
import { buildPacketContext } from "../src/context/fixture";
import { createAnswerStage, currentPolicyVersion } from "../src/pipeline/answer";
import { DEFAULT_CONCURRENCY, respondToMessages } from "../src/pipeline/batch";
import { FatalRunError } from "../src/pipeline/errors";
import { checkCase } from "./assert";
import { defaultRunId, report, selectCases, type CaseRuns } from "./lib";

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
  const cases = selectCases(values);
  const runId = values["run-id"] ?? defaultRunId("eval");
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
