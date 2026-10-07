// Live check of the model settings the pipeline depends on. Makes a handful of small real calls.
// Run with: npm run smoke

import { existsSync } from "node:fs";
import { z } from "zod";
import { loadModelConfig } from "../config/models";
import { callModel, LlmError, type LlmResult } from "../src/llm/client";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadModelConfig();

interface Check {
  name: string;
  run: () => Promise<string>;
}

function describeUsage(result: LlmResult<unknown>): string {
  const { usage } = result;
  return (
    `${result.model}, ${result.latencyMs} ms, input ${usage.inputTokens}, cache read ${usage.cacheReadTokens}, ` +
    `cache write ${usage.cacheWriteTokens}, output ${usage.outputTokens} (reasoning ${usage.reasoningTokens})`
  );
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// Long enough to clear the cache minimum on the responder model. Content is irrelevant.
const STABLE_PREFIX = Array.from(
  { length: 60 },
  (_, index) =>
    `Reference note ${index + 1}: a booking desk keeps a ledger of rooms, dates and guests, and every entry ` +
    `is checked twice before it is confirmed to the guest in writing.`,
).join("\n");

const checks: Check[] = [
  {
    name: "1. Router model returns schema-valid output at temperature 0",
    run: async () => {
      const result = await callModel({
        role: "router",
        system: [{ text: "Classify the message. Reply only with the JSON object." }],
        prompt: 'Message: "Which days is the front desk open?"',
        schema: z.object({
          kind: z.enum(["question", "action", "chit_chat"]),
          topics: z.array(z.enum(["hours", "pricing", "other"])),
        }),
      });
      expect(result.output.kind === "question", `expected kind "question", got "${result.output.kind}"`);
      return describeUsage(result);
    },
  },
  {
    name: `2. Responder model works with no temperature and effort "${config.responderEffort}"`,
    run: async () => {
      const result = await callModel({
        role: "responder",
        system: [{ text: "You draft one-line replies. Reply only with the JSON object." }],
        prompt: 'Draft a one-line reply to: "Thanks, got it."',
        schema: z.object({ response: z.string(), shouldFollowUp: z.boolean() }),
      });
      expect(result.output.response.length > 0, "empty response");
      expect(result.warnings.length === 0, `provider warnings: ${result.warnings.join("; ")}`);
      return describeUsage(result);
    },
  },
  {
    name: "3. Structured output and a tool call work in one request, within the step cap",
    run: async () => {
      const result = await callModel({
        role: "responder",
        system: [{ text: "Use the lookup tool for any fact about a desk. Reply only with the JSON object." }],
        prompt: 'Which days is the desk named "alpha" open? Look it up.',
        schema: z.object({ response: z.string(), days: z.array(z.string()) }),
        tools: {
          getDeskHoursTool: {
            description: "Returns the weekdays a desk is open. Input is the desk name.",
            inputSchema: z.object({ deskName: z.string() }),
            execute: () => ({ openWeekdays: ["MON", "TUE", "THU"] }),
          },
        },
        maxSteps: 3,
      });
      expect(result.toolCalls.length >= 1, "the model answered without calling the tool");
      expect(result.steps <= 3, `used ${result.steps} steps`);
      expect(
        ["MON", "TUE", "THU"].every((day) => JSON.stringify(result.output).toUpperCase().includes(day)),
        `reply does not carry the tool's data: ${JSON.stringify(result.output)}`,
      );
      return `${result.steps} steps, ${result.toolCalls.length} tool call(s); ${describeUsage(result)}`;
    },
  },
  {
    name: "4. Cache control on a system block is accepted and cache tokens are reported",
    run: async () => {
      const call = () =>
        callModel({
          role: "responder",
          system: [
            { text: STABLE_PREFIX, cache: true },
            { text: "Reply only with the JSON object." },
          ],
          prompt: "How many reference notes are there? Answer with the number.",
          schema: z.object({ count: z.number() }),
        });
      const first = await call();
      const second = await call();
      expect(
        first.usage.cacheWriteTokens > 0 || first.usage.cacheReadTokens > 0,
        "first call wrote and read no cache tokens",
      );
      expect(second.usage.cacheReadTokens > 0, "second call read no cache tokens");
      return `first: write ${first.usage.cacheWriteTokens}, read ${first.usage.cacheReadTokens}; second: read ${second.usage.cacheReadTokens}`;
    },
  },
];

async function main(): Promise<void> {
  console.log(`Router: ${config.routerModel}. Responder: ${config.responderModel}, effort ${config.responderEffort}.\n`);

  let failed = 0;
  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`PASS  ${check.name}\n      ${detail}`);
    } catch (error) {
      failed += 1;
      const cause = error instanceof LlmError ? `[${error.failureCause}] ` : "";
      console.log(`FAIL  ${check.name}\n      ${cause}${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof LlmError && error.failureCause === "auth") break;
    }
  }

  console.log(
    "\nNot checked live: a refusal. The SDK reports it as finish reason content-filter, " +
      "and test/llm/client.test.ts covers how the client maps it.",
  );
  if (failed > 0) {
    console.log(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll live checks passed.");
}

await main();
