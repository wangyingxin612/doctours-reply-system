import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../../config/models";
import { buildPacketContext } from "../../src/context/fixture";
import { LlmError } from "../../src/llm/client";
import { FatalRunError, ReplyRejectedError } from "../../src/pipeline/errors";
import { runMessage, type AnswerStage, type PipelineDeps } from "../../src/pipeline/run";
import { HANDOFF_SENTENCE } from "../../src/policy/escalation";
import { replySchema, type Reply } from "../../src/schema/reply";

const config: ModelConfig = {
  routerModel: "mock-router",
  responderModel: "mock-responder",
  responderEffort: "low",
  maxRetries: 0,
};

function deps(answer?: AnswerStage): PipelineDeps {
  return { context: buildPacketContext(), config, policyVersion: "test-version", answer };
}

function answered(response: string): Reply {
  return {
    response,
    escalate: false,
    escalationReason: null,
    templateId: null,
    intent: "answer a question",
    shouldFollowUp: false,
    followUpTiming: null,
    attachmentUrls: null,
    highEngagement: false,
    workingMemoryUpdates: null,
  };
}

const noEscalation = {
  escalate: false,
  reasonCode: null,
  secondaryReasonCodes: [],
  decidedBy: "none" as const,
  category: null,
};

describe("runMessage", () => {
  it("escalates a guard-decided message without calling any later stage", async () => {
    const answer = vi.fn<AnswerStage>();
    const { reply, trace } = await runMessage({ id: "m1", text: "I want to talk to a human" }, 0, "run-1", deps(answer));

    expect(answer).not.toHaveBeenCalled();
    expect(replySchema.safeParse(reply).success).toBe(true);
    expect(reply).toMatchObject({
      response: HANDOFF_SENTENCE,
      escalate: true,
      escalationReason: "Patient asked for a person",
      workingMemoryUpdates: { escalationFlags: "HUMAN_REQUESTED" },
    });
    expect(trace.decision).toMatchObject({ decidedBy: "guard", reasonCode: "HUMAN_REQUESTED", category: "policy_required" });
    expect(trace.modelCalls).toEqual([]);
    expect(trace.failure).toBeNull();
  });

  it("keeps removed card data out of the reply and out of the trace", async () => {
    const text = "Run my card 4111 1111 1111 1111 ending in 1111 for the deposit, cvv 123";
    const { reply, trace } = await runMessage({ id: "m2", text }, 1, "run-1", deps());
    const written = JSON.stringify({ reply, trace });

    expect(reply.escalate).toBe(true);
    expect(trace.decision.reasonCode).toBe("PAYMENT_ACTION_NO_TOOL");
    expect(written).not.toMatch(/4111|1111|123/);
    expect(trace.message.redactions).toEqual(
      expect.arrayContaining([
        { type: "card_number", count: 1 },
        { type: "cvv", count: 1 },
      ]),
    );
  });

  it("writes the escalation flag to working memory and records the call", async () => {
    const { trace } = await runMessage({ id: "m3", text: "agent please" }, 0, "run-1", deps());
    expect(trace.toolCalls).toEqual([
      {
        name: "updateWorkingMemoryTool",
        kind: "write",
        source: "memory",
        input: { memory: { escalationFlags: "HUMAN_REQUESTED" } },
        result: "{ success: true }",
      },
    ]);
  });

  it("hands the redacted text, not the original, to the answer stage", async () => {
    const answer = vi.fn<AnswerStage>(async () => ({ reply: answered("You can use another card at checkout."), decision: noEscalation }));
    await runMessage({ id: "m4", text: "My card ending in 1881 was declined. What now?" }, 0, "run-1", deps(answer));

    expect(answer.mock.calls[0]?.[0].message.text).toBe("My card ending in [digits removed] was declined. What now?");
  });

  it("returns the answer stage's reply when it passes the final checks", async () => {
    const answer: AnswerStage = async () => ({ reply: answered("Yes."), decision: noEscalation });
    const { reply, trace } = await runMessage({ id: "m5", text: "Is the hotel included?" }, 0, "run-1", deps(answer));

    expect(reply.response).toBe("Yes.");
    expect(trace.decision.decidedBy).toBe("none");
    expect(trace.toolCalls).toEqual([]);
  });

  it("fails over to a person when the answer stage is missing", async () => {
    const { reply, trace } = await runMessage({ id: "m6", text: "Is the hotel included?" }, 0, "run-1", deps());

    expect(reply).toMatchObject({ escalate: true, response: HANDOFF_SENTENCE });
    expect(trace.decision).toMatchObject({ reasonCode: "SYSTEM_FAILURE", decidedBy: "validator_fallback", category: "avoidable" });
    expect(trace.failure?.cause).toBe("internal_error");
  });

  it("labels each kind of failure, so the report does not blame policy", async () => {
    const failures: Array<[unknown, string]> = [
      [new LlmError("transient_api", "HTTP 529"), "transient_api"],
      [new LlmError("refusal", "declined"), "refusal"],
      [new LlmError("invalid_output", "bad json"), "invalid_output"],
      [new LlmError("model_error", "HTTP 400"), "model_error"],
      [new ReplyRejectedError([{ validator: "no_markdown", severity: "block", message: "bold" }]), "validator"],
      [new TypeError("undefined is not a function"), "internal_error"],
    ];
    for (const [thrown, cause] of failures) {
      const answer: AnswerStage = async () => {
        throw thrown;
      };
      const { reply, trace } = await runMessage({ id: "m7", text: "Is the hotel included?" }, 0, "run-1", deps(answer));
      expect(reply.escalate).toBe(true);
      expect(trace.failure?.cause).toBe(cause);
      expect(trace.decision.reasonCode).toBe("SYSTEM_FAILURE");
    }
  });

  it("stops the run when the API key is missing or rejected", async () => {
    const answer: AnswerStage = async () => {
      throw new LlmError("auth", "ANTHROPIC_API_KEY is not set.");
    };
    await expect(runMessage({ id: "m8", text: "Is the hotel included?" }, 0, "run-1", deps(answer))).rejects.toBeInstanceOf(
      FatalRunError,
    );
  });

  it("replaces a reply that repeats card digits", async () => {
    const answer: AnswerStage = async () => ({ reply: answered("The card ending in 1881 was declined."), decision: noEscalation });
    const { reply, trace } = await runMessage(
      { id: "m9", text: "My card ending in 1881 was declined. What now?" },
      0,
      "run-1",
      deps(answer),
    );

    expect(reply.response).toBe(HANDOFF_SENTENCE);
    expect(trace.failure?.cause).toBe("validator");
    expect(JSON.stringify(trace)).not.toContain("1881");
  });
});
