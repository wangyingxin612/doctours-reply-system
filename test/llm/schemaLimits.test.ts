// The API limits the shape of a structured-output schema. These checks read the schemas exactly as
// the SDK sends them, so a field added later cannot push a stage over a limit without a test failing.

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { ModelConfig } from "../../config/models";
import { buildPacketContext } from "../../src/context/fixture";
import { callModel } from "../../src/llm/client";
import { createAnswerStage } from "../../src/pipeline/answer";
import { responderSchema } from "../../src/pipeline/responder";
import { runMessage } from "../../src/pipeline/run";
import { countSchema, MAX_OPTIONAL_FIELDS, MAX_UNION_FIELDS, type SchemaCounts } from "../helpers/schemaLimits";

const config: ModelConfig = {
  routerModel: "mock-router",
  responderModel: "mock-responder",
  responderEffort: "low",
  maxRetries: 0,
  responderFallbacks: false,
};

/** A model that records what it was sent and then fails, so only the request is under test. */
function recordingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("stop after recording the request");
    },
  });
}

function sentSchema(model: MockLanguageModelV4): SchemaCounts {
  const format = model.doGenerateCalls[0]?.responseFormat;
  if (format?.type !== "json") throw new Error("the request carried no output schema");
  return countSchema(format.schema);
}

function expectWithinLimits(counts: SchemaCounts): void {
  expect(counts.optional).toBeLessThanOrEqual(MAX_OPTIONAL_FIELDS);
  expect(counts.unions).toBeLessThanOrEqual(MAX_UNION_FIELDS);
  expect(counts.openObjects).toBe(0);
  expect(counts.unsupportedKeywords).toEqual([]);
}

describe("output schemas stay inside the API's limits", () => {
  it("router", async () => {
    const model = recordingModel();
    await runMessage({ id: "m", text: "Which clinic is closest to the airport?" }, 0, "run", {
      context: buildPacketContext(),
      config,
      policyVersion: "test-version",
      answer: createAnswerStage({ model }),
    });

    const counts = sentSchema(model);
    expectWithinLimits(counts);
    // The router's schema has nullable fields, so a count of zero would mean the walk found nothing.
    expect(counts.unions).toBeGreaterThan(0);
  });

  it("responder", async () => {
    const model = recordingModel();
    await callModel({ role: "responder", system: [], prompt: "x", schema: responderSchema }, { config, model }).catch(() => undefined);

    const counts = sentSchema(model);
    expectWithinLimits(counts);
    expect(counts.unions).toBeGreaterThan(0);
  });
});

describe("schema counting", () => {
  it("counts optional fields, nullable fields, open objects and unsupported keywords", () => {
    const counts = countSchema({
      type: "object",
      properties: {
        name: { type: "string", maxLength: 10 },
        nickname: { type: ["string", "null"] },
        tags: { type: "array", items: { anyOf: [{ type: "string" }, { type: "null" }] } },
        extra: { type: "object", properties: { note: { type: "string" } } },
      },
      required: ["name", "nickname"],
      additionalProperties: false,
    });

    expect(counts).toEqual({ optional: 3, unions: 2, openObjects: 1, unsupportedKeywords: ["maxLength"] });
  });
});
