// npm run respond -- --in messages.json --out replies.json
// Reads a JSON array of { id, text }. Writes a JSON array of Reply, one per message, in the same order.
// With no --in it reads stdin. With no --out it writes stdout. Logs go to stderr.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadModelConfig } from "../../config/models";
import { buildPacketContext } from "../context/fixture";
import { DEFAULT_CONCURRENCY, respondToMessages } from "../pipeline/batch";
import { FatalRunError } from "../pipeline/errors";
import { computePolicyVersion } from "../policy/version";

const USAGE = `Usage: npm run respond -- [--in <file>] [--out <file>] [options]

  --in <file>          JSON array of { "id": string, "text": string }. Default: stdin.
  --out <file>         Where to write the JSON array of replies. Default: stdout.
  --concurrency <n>    Messages processed at once. Default: ${DEFAULT_CONCURRENCY} (or CONCURRENCY).
  --trace-dir <dir>    Parent directory for traces. Default: traces.
  --run-id <id>        Name of this run's trace folder. Default: a timestamp.
  --no-trace           Do not write traces.
  --help               Show this text.`;

class UsageError extends Error {}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  throw new UsageError(`${name} must be a whole number of 1 or more. Got "${value}".`);
}

function defaultRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function readInput(path: string | undefined): unknown[] {
  const raw = readFileSync(path ?? 0, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError(`${path ?? "stdin"} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new UsageError("The input must be a JSON array of { id, text } objects.");
  return parsed;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      in: { type: "string" },
      out: { type: "string" },
      concurrency: { type: "string" },
      "trace-dir": { type: "string" },
      "run-id": { type: "string" },
      "no-trace": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (existsSync(".env")) process.loadEnvFile(".env");

  const concurrency = positiveInteger(
    "concurrency",
    values.concurrency ?? process.env.CONCURRENCY ?? String(DEFAULT_CONCURRENCY),
  );
  const runId = values["run-id"] ?? defaultRunId();
  const traceDir = values["no-trace"] ? null : join(values["trace-dir"] ?? "traces", runId);
  const items = readInput(values.in);

  const { replies, traces } = await respondToMessages(items, {
    runId,
    concurrency,
    traceDir,
    deps: {
      context: buildPacketContext(),
      config: loadModelConfig(),
      policyVersion: computePolicyVersion(),
    },
  });

  const output = `${JSON.stringify(replies, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);

  const escalated = traces.filter((trace) => trace.decision.escalate).length;
  const failed = traces.filter((trace) => trace.failure !== null).length;
  console.error(
    `${replies.length} message(s): ${replies.length - escalated} answered, ${escalated} escalated` +
      (failed > 0 ? ` (${failed} of them after a failure)` : "") +
      (traceDir ? `. Traces: ${traceDir}` : "."),
  );
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError || error instanceof FatalRunError) {
    console.error(`Error: ${error.message}`);
    if (error instanceof UsageError) console.error(`\n${USAGE}`);
    process.exit(2);
  }
  throw error;
}
