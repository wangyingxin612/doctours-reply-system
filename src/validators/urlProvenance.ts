import { MAX_ATTACHMENTS } from "../schema/reply";
import { extractUrls } from "./text";
import type { Validator, Violation } from "./types";

const NAME = "url_provenance";

/**
 * A reply may only contain URLs a tool returned this turn or a loaded skill lists as a static link.
 * Attachments may only be the patient's own photos, at most three.
 */
export const urlProvenance: Validator = (reply, context) => {
  const violations: Violation[] = [];
  const add = (message: string) => violations.push({ validator: NAME, severity: "block", message });

  const inResponse = extractUrls(reply.response);
  for (const url of inResponse) {
    if (!context.allowedUrls.has(url)) {
      add(`The URL ${url} did not come from a tool this turn and is not an allowed link. Remove it.`);
    }
  }

  const payLinks = new Set(inResponse.filter((url) => /\/payment\/|\/checkout(?:[/?#]|$)/.test(url)));
  if (payLinks.size > 1) {
    add("The reply carries more than one payment or checkout link. Send exactly one.");
  }

  const present = new Set(inResponse);
  for (const url of context.requiredUrls) {
    if (!present.has(url)) add(`The reply must end with this link, alone on the last line: ${url}`);
  }

  const attachments = reply.attachmentUrls ?? [];
  if (attachments.length > MAX_ATTACHMENTS) {
    add(`attachmentUrls holds ${attachments.length} URLs. The limit is ${MAX_ATTACHMENTS}.`);
  }
  for (const url of attachments) {
    if (!context.imageUrls.has(url)) {
      add(`The attachment ${url} is not one of the patient's photo URLs returned this turn. Remove it.`);
    }
  }

  return violations;
};
