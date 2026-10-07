import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../config/models";
import { buildPacketContext } from "../../src/context/fixture";
import { mapWithConcurrency, respondToMessages } from "../../src/pipeline/batch";
import { FatalRunError } from "../../src/pipeline/errors";
import type { AnswerStage, PipelineDeps } from "../../src/pipeline/run";
import { replySchema, type Reply } from "../../src/schema/reply";
import { traceFileName } from "../../src/trace/write";

const config: ModelConfig = {
  routerModel: "mock-router",
  responderModel: "mock-responder",
  responderEffort: "low",
  maxRetries: 0,
};

function deps(answer?: AnswerStage): PipelineDeps {
  return { context: buildPacketContext(), config, policyVersion: "test-version", answer };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("keeps input order and never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 5, 20, 1, 10, 15], 2, async (delay, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(delay);
      inFlight -= 1;
      return `${index}:${delay}`;
    });

    expect(results).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10", "5:15"]);
    expect(peak).toBe(2);
  });

  it("handles an empty list and a limit above the list size", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });

  it("stops handing out work after a fatal error", async () => {
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 1, async (item) => {
      started.push(item);
      if (item === 1) throw new FatalRunError("no key");
      return item;
    });

    await expect(run).rejects.toBeInstanceOf(FatalRunError);
    expect(started).toEqual([0, 1]);
  });
});

describe("respondToMessages", () => {
  const echo: AnswerStage = async ({ message }) => ({
    reply: {
      response: `Answer for ${message.id}.`,
      escalate: false,
      escalationReason: null,
      templateId: null,
      intent: "answer a question",
      shouldFollowUp: false,
      followUpTiming: null,
      attachmentUrls: null,
      highEngagement: false,
      workingMemoryUpdates: null,
    },
    decision: { escalate: false, reasonCode: null, secondaryReasonCodes: [], decidedBy: "none", category: null },
  });

  it("returns one valid reply per input, in input order, with mixed outcomes", async () => {
    const items = [
      { id: "a", text: "Is the hotel included?" },
      { id: "b", text: "I want to talk to a human" },
      { id: "c" },
      "not an object",
      { id: "e", text: "Please charge my Visa for the deposit." },
      { id: "f", text: "How many nights is it?" },
    ];
    const { replies, traces } = await respondToMessages(items, { runId: "r", concurrency: 3, traceDir: null, deps: deps(echo) });

    expect(replies).toHaveLength(items.length);
    for (const reply of replies) expect(replySchema.safeParse(reply).success).toBe(true);
    expect(replies.map((reply) => reply.escalate)).toEqual([false, true, true, true, true, false]);
    expect(replies[0]?.response).toBe("Answer for a.");
    expect(replies[5]?.response).toBe("Answer for f.");
    expect(traces.map((trace) => trace.messageId)).toEqual(["a", "b", "c", "item-3", "e", "f"]);
    expect(traces.map((trace) => trace.decision.reasonCode)).toEqual([
      null,
      "HUMAN_REQUESTED",
      "SYSTEM_FAILURE",
      "SYSTEM_FAILURE",
      "PAYMENT_ACTION_NO_TOOL",
      null,
    ]);
    expect(traces[2]?.failure?.cause).toBe("internal_error");
  });

  it("writes one trace file per message, named by position and id", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "traces-"));
    const items = [
      { id: "first", text: "agent please" },
      { id: "second/with odd:chars", text: "Is the hotel included?" },
    ];
    await respondToMessages(items, { runId: "r", concurrency: 2, traceDir, deps: deps(echo) });

    expect(readdirSync(traceDir).sort()).toEqual(["0000-first.json", "0001-second_with_odd_chars.json"]);
    const trace = JSON.parse(readFileSync(join(traceDir, "0000-first.json"), "utf8"));
    expect(trace).toMatchObject({ runId: "r", index: 0, messageId: "first", policyVersion: "test-version" });
    expect(traceFileName(12, "")).toBe("0012-message.json");
  });
});

describe("respond CLI", () => {
  const cli = (input: string, args: string[] = []) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli/respond.ts", "--no-trace", ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
    });

  it("reads stdin and writes only the JSON array of replies to stdout", () => {
    const input = JSON.stringify([
      { id: "x", text: "Can I speak with a real person please?" },
      { id: "y", text: "Go ahead and put the deposit on my card." },
    ]);
    const result = cli(input);

    expect(result.status).toBe(0);
    const replies = JSON.parse(result.stdout) as Reply[];
    expect(replies.map((reply) => reply.escalate)).toEqual([true, true]);
    expect(Object.keys(replies[0] ?? {})).toEqual([
      "response",
      "escalate",
      "escalationReason",
      "templateId",
      "intent",
      "shouldFollowUp",
      "followUpTiming",
      "attachmentUrls",
      "highEngagement",
      "workingMemoryUpdates",
    ]);
    expect(result.stderr).toContain("2 message(s)");
  });

  it("exits with a clear error when the input is not a JSON array", () => {
    expect(cli("not json").status).toBe(2);
    expect(cli('{"id":"x","text":"hi"}').status).toBe(2);
    expect(cli("[]", ["--concurrency", "0"]).status).toBe(2);
  });
});
