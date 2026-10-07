import { replySchema } from "../schema/reply";
import type { Validator, Violation } from "./types";

const NAME = "shape";

/** The packet's output contract, including the rules that tie two fields together. */
export const shape: Validator = (reply) => {
  const violations: Violation[] = [];
  const add = (message: string) => violations.push({ validator: NAME, severity: "block", message });

  const parsed = replySchema.safeParse(reply);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(`${issue.path.join(".") || "reply"}: ${issue.message}`);
    return violations;
  }

  if (reply.response.trim() === "") add("response is empty.");
  if (reply.escalate && !reply.escalationReason?.trim()) add("escalationReason must be set when escalate is true.");
  if (!reply.escalate && reply.escalationReason !== null) add("escalationReason must be null when escalate is false.");
  if (reply.shouldFollowUp && !reply.followUpTiming?.trim()) add("followUpTiming must be set when shouldFollowUp is true.");
  if (!reply.shouldFollowUp && reply.followUpTiming !== null) add("followUpTiming must be null when shouldFollowUp is false.");
  if (reply.attachmentUrls !== null && reply.attachmentUrls.length === 0) add("attachmentUrls must be null when there is nothing to attach.");

  return violations;
};
