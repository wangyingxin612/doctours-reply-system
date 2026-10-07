// Stage and collection logic. Code decides whether a collection question may ride on the reply,
// and which one. The responder gets one directive, for example anchor: "none".

import type { PatientContext } from "../context/types";
import type { Reply } from "../schema/reply";

export type Anchor = "none" | "area" | "name" | "photos";

export interface AnchorDecision {
  anchor: Anchor;
  reason: string;
}

/** Each item may be asked once in live replies. The scheduled follow-up workflow owns every re-ask. */
const ASK_BUDGET = 1;

/** The proactive photo ask belongs to these stages only. Later stages already have the photos. */
const PHOTO_ASK_STATUSES = new Set(["LEAD", "MEETING_BOOKED"]);

/** Beard and eyebrow transplants do not use the standard photo upload. */
const NO_PHOTO_AREAS = /beard|eyebrow/i;

export function computeAnchor(context: PatientContext, options: { pausing: boolean }): AnchorDecision {
  if (options.pausing) {
    return { anchor: "none", reason: "The patient is pausing. A pause skips the collection anchor." };
  }

  const memory = context.workingMemory;
  const asks = memory.collectionState ?? {};
  const area = context.procedure.area ?? memory.procedureArea ?? null;
  const name = context.patient.name ?? memory.patientName ?? null;

  // Priority order from the original prompt: procedure area, then name, then photos.
  const items: Array<{ item: Exclude<Anchor, "none">; known: boolean; asked: boolean; allowed: boolean }> = [
    { item: "area", known: Boolean(area), asked: (asks.areaAskCount ?? 0) >= ASK_BUDGET, allowed: true },
    { item: "name", known: Boolean(name), asked: (asks.nameAskCount ?? 0) >= ASK_BUDGET, allowed: true },
    {
      item: "photos",
      known: context.images.hasImages,
      asked: (asks.photoAskCount ?? 0) >= ASK_BUDGET,
      allowed: PHOTO_ASK_STATUSES.has(context.pipelineStatus) && !(area !== null && NO_PHOTO_AREAS.test(area)),
    },
  ];

  const next = items.find((entry) => !entry.known && !entry.asked && entry.allowed);
  if (next) return { anchor: next.item, reason: `The ${next.item} is unknown and has not been asked yet.` };
  return { anchor: "none", reason: "Every collection item is known, already asked, or not asked at this stage." };
}

/**
 * Counts the ask. Code owns the collection counters, because code decided the anchor:
 * the model is never asked to count what it has asked.
 */
export function recordAnchorAsked(reply: Reply, anchor: Anchor, context: PatientContext): Reply {
  if (anchor === "none") return reply;
  const asks = context.workingMemory.collectionState ?? {};
  const counter = { area: "areaAskCount", name: "nameAskCount", photos: "photoAskCount" } as const;
  return {
    ...reply,
    workingMemoryUpdates: {
      ...reply.workingMemoryUpdates,
      collectionState: { ...asks, lastAskedItem: anchor, [counter[anchor]]: (asks[counter[anchor]] ?? 0) + 1 },
    },
  };
}
