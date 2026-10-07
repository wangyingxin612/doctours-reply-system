// npm run size -- <runDir>
// A static size comparison of the original prompt against the prompts this system assembles.
// It makes no model call. It rebuilds, from the router output stored in each trace of a past run,
// exactly what the responder would be shown, and counts characters. The run's own token counts
// give the characters-per-token rate, which then estimates the original prompt's size in tokens.

import { buildPacketContext } from "../../src/context/fixture";
import { routerSnapshot } from "../../src/context/snapshot";
import { buildPlan } from "../../src/pipeline/plan";
import { renderResponderPrompt } from "../../src/pipeline/responder";
import { routerSystemPrompt, type RouterOutput } from "../../src/pipeline/router";
import { loadRun } from "../../src/report/aggregate";
import { loadSkills } from "../../src/skills/loader";
import { TurnLedger } from "../../src/tools/ledger";
import { originalSystemPrompt, originalUserMessage } from "./original";

const context = buildPacketContext();
const skills = loadSkills(context.vertical);

const runDir = process.argv[2];
if (!runDir) {
  console.error("Usage: npm run size -- <runDir>   (a folder of traces from a past run)");
  process.exit(2);
}

// A patient message of typical length stands in for the real one.
const originalChars = originalSystemPrompt().length + originalUserMessage("x".repeat(60)).length;
const routerChars = (text: string) => routerSystemPrompt(skills).length + routerSnapshot(context).length + text.length + 24;

interface Row {
  id: string;
  skills: string;
  responderChars: number;
  routerChars: number;
  responderTokens: number;
  routerTokens: number;
}

const rows: Row[] = [];
for (const trace of loadRun(runDir)) {
  const responder = trace.modelCalls.find((call) => call.stage === "responder");
  const router = trace.modelCalls.find((call) => call.stage === "router");
  if (!trace.router || !responder || !router) continue;

  const message = { id: trace.messageId, text: trace.message.redactedText };
  const ledger = new TurnLedger();
  const plan = buildPlan({ router: trace.router as RouterOutput, text: message.text, context, skills, ledger });
  const prompt = renderResponderPrompt({ message, context, plan, ledger });

  rows.push({
    id: trace.messageId,
    skills: plan.selected.map((skill) => skill.name).join(", ") || "(none)",
    responderChars: prompt.system.reduce((sum, block) => sum + block.text.length, 0) + prompt.prompt.length,
    routerChars: routerChars(message.text),
    responderTokens: responder.inputTokens + responder.cacheReadTokens + responder.cacheWriteTokens,
    routerTokens: router.inputTokens + router.cacheReadTokens + router.cacheWriteTokens,
  });
}
if (rows.length === 0) {
  console.error(`No answered messages with a router output in ${runDir}.`);
  process.exit(2);
}

const sum = (pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0);
const charsPerToken = sum((row) => row.responderChars) / sum((row) => row.responderTokens);
const originalTokens = originalChars / charsPerToken;
const average = (pick: (row: Row) => number) => Math.round(sum(pick) / rows.length);
const thousands = (value: number) => Math.round(value).toLocaleString("en-US");

console.log(`# Prompt size: original prompt against this system\n`);
console.log(`Measured on ${rows.length} answered messages from ${runDir}. No model call was made for this comparison.\n`);
console.log(`| | Characters | Tokens |`);
console.log(`| --- | --- | --- |`);
console.log(`| Original prompt, sent whole on every request | ${thousands(originalChars)} | about ${thousands(originalTokens)} (estimated) |`);
console.log(`| This system, responder, average per answered message | ${thousands(average((row) => row.responderChars))} | ${thousands(average((row) => row.responderTokens))} (measured) |`);
console.log(`| This system, router, average per answered message | ${thousands(average((row) => row.routerChars))} | ${thousands(average((row) => row.routerTokens))} (measured) |`);
console.log(`| This system, a message the guard escalates | 0 | 0 |`);
console.log(`\nThe token estimate for the original prompt uses ${charsPerToken.toFixed(2)} characters per token, the rate measured on this system's own responder calls, which are made of the same text. Measured responder tokens include tool definitions and the output schema, which the character count leaves out, so the rate is too low and the estimate runs high. \`npm run baseline\` measures the real figure: 60,310 tokens with the 14 tool definitions, on 2026-10-07.`);
console.log(`\nThe original flow also re-sends its whole prompt on every tool round trip within one reply. This system fetches facts in code, so an answered message is one responder call unless a repair is needed.\n`);

const packetIds = new Set(["heva-packages", "hakan-price", "consultation"]);
console.log(`| Message | Skills loaded | Responder characters | Responder tokens (measured) | Share of the original prompt |`);
console.log(`| --- | --- | --- | --- | --- |`);
for (const row of rows.filter((candidate) => packetIds.has(candidate.id))) {
  console.log(`| ${row.id} | ${row.skills} | ${thousands(row.responderChars)} | ${thousands(row.responderTokens)} | ${((100 * row.responderChars) / originalChars).toFixed(0)}% |`);
}
const smallest = rows.reduce((a, b) => (a.responderChars < b.responderChars ? a : b));
const largest = rows.reduce((a, b) => (a.responderChars > b.responderChars ? a : b));
console.log(`\nAcross the run the responder prompt ranged from ${thousands(smallest.responderChars)} characters (${smallest.id}) to ${thousands(largest.responderChars)} (${largest.id}).`);
