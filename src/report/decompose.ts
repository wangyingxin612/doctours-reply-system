// Explains a change in the escalation rate between two runs. Both splits are exact:
// their parts add up to the change, with nothing left over.

import type { RunSummary } from "./aggregate";

export interface CodeContribution {
  code: string;
  baselineRate: number;
  currentRate: number;
  /** Percentage points of the total change that this reason code accounts for. */
  contribution: number;
}

/**
 * Each escalated message has one primary reason code, so the per-code rates add up to the total
 * rate, and the per-code changes add up to the total change.
 */
export function byReasonCode(baseline: RunSummary, current: RunSummary): CodeContribution[] {
  const codes = [...new Set([...Object.keys(baseline.byReasonCode), ...Object.keys(current.byReasonCode)])];
  return codes
    .map((code) => {
      const baselineRate = baseline.messages === 0 ? 0 : (baseline.byReasonCode[code] ?? 0) / baseline.messages;
      const currentRate = current.messages === 0 ? 0 : (current.byReasonCode[code] ?? 0) / current.messages;
      return { code, baselineRate, currentRate, contribution: currentRate - baselineRate };
    })
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

export interface IntentEffect {
  intent: string;
  shareBefore: number;
  shareAfter: number;
  /** Null when the run had no message with this intent. */
  rateBefore: number | null;
  rateAfter: number | null;
  /** Change that comes from more or fewer messages of this intent. */
  mixEffect: number;
  /** Change that comes from escalating this intent more or less often. */
  rateEffect: number;
}

/**
 * Mix versus rate, per intent, with midpoint weights:
 *   mix effect  = (share after - share before) x average of the two rates
 *   rate effect = (rate after - rate before)   x average of the two shares
 * Summed over intents, the two effects equal the change in the overall rate exactly.
 * An intent that appears in only one run has no rate in the other. It is given the same rate
 * there, so its whole effect counts as mix: the traffic changed, not how we treat it.
 */
export function byIntent(baseline: RunSummary, current: RunSummary): IntentEffect[] {
  const intents = [...new Set([...Object.keys(baseline.byIntent), ...Object.keys(current.byIntent)])];
  return intents
    .map((intent) => {
      const before = baseline.byIntent[intent];
      const after = current.byIntent[intent];
      const shareBefore = before && baseline.messages > 0 ? before.messages / baseline.messages : 0;
      const shareAfter = after && current.messages > 0 ? after.messages / current.messages : 0;
      const rateBefore = before && before.messages > 0 ? before.escalated / before.messages : null;
      const rateAfter = after && after.messages > 0 ? after.escalated / after.messages : null;
      const r0 = rateBefore ?? rateAfter ?? 0;
      const r1 = rateAfter ?? rateBefore ?? 0;
      return {
        intent,
        shareBefore,
        shareAfter,
        rateBefore,
        rateAfter,
        mixEffect: (shareAfter - shareBefore) * ((r0 + r1) / 2),
        rateEffect: (r1 - r0) * ((shareBefore + shareAfter) / 2),
      };
    })
    .sort((a, b) => Math.abs(b.mixEffect + b.rateEffect) - Math.abs(a.mixEffect + a.rateEffect));
}
