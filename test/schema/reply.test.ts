import { describe, expect, it } from "vitest";
import { buildPacketContext, PACKET_NOW } from "../../src/context/fixture";
import { incomingMessagesSchema, replySchema, type Reply } from "../../src/schema/reply";

const valid: Reply = {
  response: "Yes.",
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

describe("reply schema", () => {
  it("accepts a reply with exactly the packet's ten keys", () => {
    expect(replySchema.parse(valid)).toEqual(valid);
    expect(Object.keys(replySchema.shape)).toEqual([
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
  });

  it("rejects extra keys, including an id", () => {
    expect(replySchema.safeParse({ ...valid, id: "abc" }).success).toBe(false);
    expect(replySchema.safeParse({ ...valid, workingMemoryUpdates: { mood: "good" } }).success).toBe(false);
  });

  it("rejects a template id, a fourth attachment, and an unknown enum value", () => {
    expect(replySchema.safeParse({ ...valid, templateId: "t-1" }).success).toBe(false);
    expect(replySchema.safeParse({ ...valid, attachmentUrls: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(
      replySchema.safeParse({ ...valid, workingMemoryUpdates: { communicationStyle: "chatty" } }).success,
    ).toBe(false);
  });

  it("accepts partial working-memory updates", () => {
    const updates = { escalationFlags: "HUMAN_REQUESTED", collectionState: { lastAskedItem: "photos" as const } };
    expect(replySchema.parse({ ...valid, workingMemoryUpdates: updates }).workingMemoryUpdates).toEqual(updates);
  });
});

describe("incoming messages", () => {
  it("accepts the packet's input shape and rejects anything else", () => {
    expect(incomingMessagesSchema.safeParse([{ id: "a", text: "hello" }]).success).toBe(true);
    expect(incomingMessagesSchema.safeParse([{ id: "a" }]).success).toBe(false);
    expect(incomingMessagesSchema.safeParse({ id: "a", text: "hello" }).success).toBe(false);
  });
});

describe("packet context", () => {
  it("builds a typed context from the packet constants", () => {
    const context = buildPacketContext();

    expect(context.now).toBe(PACKET_NOW);
    expect(context.vertical).toBe("hair");
    expect(context.pipelineStatus).toBe("PRE_CLINICAL_SENT");
    expect(context.patient.financingEligible).toBe("yes");
    expect(context.consultation.time).toBeNull();
    expect(context.booking.hasActive).toBe(false);
    expect(context.images).toEqual({ hasImages: true, count: 5 });
    expect(context.procedure.graftRange).toEqual({ min: 2500, max: 3200 });
  });

  it("parses the working memory the workflow supplies", () => {
    const { workingMemory } = buildPacketContext();
    expect(workingMemory.collectionState).toEqual({
      areaAskCount: 1,
      lastAskedItem: "photos",
      nameAskCount: 1,
      photoAskCount: 1,
    });
    expect(workingMemory.targetProcedureWindow).toBe("within_6_months");
  });
});
