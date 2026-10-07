// npm run report -- <runDir> [<baselineRunDir>]
// Prints the Monday escalation report for a run. With a baseline, also explains the change.

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadRun, summarize } from "../report/aggregate";
import { renderReport } from "../report/render";

const USAGE = "Usage: npm run report -- <runDir> [<baselineRunDir>]\n\nA run directory is a folder of traces, for example traces/20261007-101500-ab12.";

function summaryOf(dir: string) {
  if (!existsSync(dir)) throw new Error(`No such run directory: ${dir}`);
  const traces = loadRun(dir);
  if (traces.length === 0) throw new Error(`No traces in ${dir}`);
  return summarize(traces);
}

try {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [runDir, baselineDir] = positionals;
  if (!runDir) throw new Error("Give the run directory to report on.");
  process.stdout.write(renderReport(summaryOf(runDir), baselineDir ? summaryOf(baselineDir) : undefined));
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  process.exit(2);
}
