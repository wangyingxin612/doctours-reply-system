import type { Validator } from "./types";

const NAME = "no_turnaround_window";

const ABOUT_ASSESSMENT = /\bassessment\b/i;
const ABOUT_READINESS = /\b(?:ready|done|finished|complete[d]?|sent|send|receive|get|have it|back|takes?|turnaround|arrive)\b/i;
const WINDOW =
  /\b(?:(?:a|an|one|two|three|four|five|several|a few|a couple(?: of)?|\d+(?:\s*(?:-|–|to)\s*\d+)?)\s+(?:business\s+)?(?:hours?|days?|weeks?)|later today|by tomorrow|tomorrow|tonight|within a day|end of (?:the )?(?:day|week)|by (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

/**
 * No time window for when an assessment will be ready. Real turnaround runs from hours to over a
 * week, so any window is a promise that breaks. Windows are fine elsewhere: the clinic confirming
 * a date within 24 hours is a real commitment.
 */
export const noTurnaroundWindow: Validator = (reply) => {
  const sentences = reply.response.split(/(?<=[.!?])\s+|\n+/);
  const offending = sentences.some(
    (sentence) => ABOUT_ASSESSMENT.test(sentence) && ABOUT_READINESS.test(sentence) && WINDOW.test(sentence),
  );
  return offending
    ? [
        {
          validator: NAME,
          severity: "block",
          message:
            "The reply gives a time window for when the assessment will be ready. Say the medical team is working on it and they will get it as soon as it is ready, with no window.",
        },
      ]
    : [];
};
