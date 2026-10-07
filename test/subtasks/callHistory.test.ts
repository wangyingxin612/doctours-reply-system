import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../config/models";
import { buildPacketContext } from "../../src/context/fixture";
import { readCallHistory } from "../../src/subtasks/callHistory";
import { TurnLedger } from "../../src/tools/ledger";

const config: ModelConfig = {
  routerModel: "mock-router",
  responderModel: "mock-responder",
  responderEffort: "low",
  maxRetries: 0,
  responderFallbacks: false,
};

function modelReturning(findings: string[]) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify({ findings }) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

describe("call-history subtask", () => {
  const input = () => ({
    question: "What did we agree on the phone?",
    context: buildPacketContext(),
    ledger: new TurnLedger(),
    config,
  });

  it("passes short call records to the responder as they are, with no model call", async () => {
    const model = modelReturning([]);
    const request = input();
    const result = await readCallHistory(request, { model });

    expect(result.call).toBeNull();
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(result.fact.body).toContain("4C");
    expect(request.ledger.calls.map((call) => [call.name, call.source])).toEqual([["getFullCallsTool", "subtask"]]);
  });

  it("reduces long call records to the findings that bear on the message", async () => {
    const model = modelReturning(["On the Sep 18 call the patient said their hair is 4C."]);
    const result = await readCallHistory(input(), { model }, 10);

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.call?.stage).toBe("subtask");
    expect(result.fact.title).toContain("Findings from 1 call records");
    expect(result.fact.body).toBe("- On the Sep 18 call the patient said their hair is 4C.");
    // The raw transcript is not what the responder gets.
    expect(result.fact.body).not.toContain("Thanks for hopping on");
  });

  it("says so when nothing in the calls helps", async () => {
    const result = await readCallHistory(input(), { model: modelReturning([]) }, 10);
    expect(result.fact.body).toBe("Nothing in the call records bears on this message.");
  });
});
