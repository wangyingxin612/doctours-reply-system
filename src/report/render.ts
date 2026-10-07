// The Monday report as markdown: what the escalation rate is, what it is made of, what it cost,
// and, against a baseline, where a change came from.

import { ESCALATION_TABLE, REASON_CODES, type ReasonCode } from "../policy/escalation";
import type { RunSummary, StageTokens } from "./aggregate";
import { byIntent, byReasonCode } from "./decompose";

const percent = (value: number) => `${(100 * value).toFixed(1)}%`;
const points = (value: number) => `${value >= 0 ? "+" : ""}${(100 * value).toFixed(1)}`;
const dollars = (value: number) => `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
const rateOrDash = (value: number | null) => (value === null ? "-" : percent(value));

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function categoryOf(code: string): string {
  return (REASON_CODES as readonly string[]).includes(code) ? ESCALATION_TABLE[code as ReasonCode].category : "unknown";
}

function rateSection(run: RunSummary): string[] {
  const share = (messages: number) => (run.messages === 0 ? 0 : messages / run.messages);
  const lines = [
    "## Escalation rate",
    "",
    `${percent(run.rate)} of messages were handed to a person (${run.escalated} of ${run.messages}). At this volume the true rate is probably between ${percent(run.interval[0])} and ${percent(run.interval[1])}.`,
    "",
    table(
      ["Category", "Messages", "Rate", "What it means"],
      [
        ["Policy required", String(run.byCategory.policy_required ?? 0), percent(share(run.byCategory.policy_required ?? 0)), "The patient asked for a person, or for an action no tool can do. Moves with what patients ask."],
        ["Avoidable", String(run.byCategory.avoidable ?? 0), percent(share(run.byCategory.avoidable ?? 0)), "The system failed, or could not map a request. This is the number to push down."],
      ],
    ),
  ];

  const codes = Object.entries(run.byReasonCode).sort((a, b) => b[1] - a[1]);
  if (codes.length > 0) {
    lines.push("", "By reason code. One code per message, so the rates add up to the total.", "");
    lines.push(table(["Reason code", "Category", "Messages", "Rate"], codes.map(([code, messages]) => [code, categoryOf(code), String(messages), percent(share(messages))])));
  }

  const deciders = Object.entries(run.byDecidedBy).sort((a, b) => b[1] - a[1]);
  if (deciders.length > 0) {
    lines.push("", "By who decided. guard: patterns in code, no model call. router_policy: the router classified and the policy tables decided. validator_fallback: the system could not produce a reply that passed its checks.", "");
    lines.push(table(["Decided by", "Messages", "Rate"], deciders.map(([decider, messages]) => [decider, String(messages), percent(share(messages))])));
  }

  const causes = Object.entries(run.byFailureCause).sort((a, b) => b[1] - a[1]);
  if (causes.length > 0) {
    lines.push("", "Failures behind the fallbacks. transient_api is API trouble that outlasted its retries. It is not a policy problem and should not be argued as one.", "");
    lines.push(table(["Failure cause", "Messages", "Rate"], causes.map(([cause, messages]) => [cause, String(messages), percent(share(messages))])));
  }
  return lines;
}

function answeredSection(run: RunSummary): string[] {
  const answered = run.answered;
  const share = (key: string) => (answered === 0 ? 0 : (run.coverage[key] ?? 0) / answered);
  return [
    "## Answered messages",
    "",
    `${answered} of ${run.messages} messages were answered without a person.`,
    "",
    "Coverage is what the model said about its own reply. It is a proxy, not a measurement. Watch it next to the escalation rate: if escalations fall while \"none\" rises, the system is saying \"I don't have that\" instead of handing off.",
    "",
    table(
      ["Answered", "Messages", "Share of answered"],
      ["all", "part", "none", "unknown"]
        .filter((key) => (run.coverage[key] ?? 0) > 0)
        .map((key) => [key === "all" ? "everything asked" : key === "part" ? "part of it" : key === "none" ? "none of it" : "not reported", String(run.coverage[key] ?? 0), percent(share(key))]),
    ),
    "",
    `${run.repairs} message(s) needed a repair attempt. ${run.warnings} validator warning(s) were logged.`,
  ];
}

function costSection(run: RunSummary): string[] {
  const row = (stage: string, tokens: StageTokens) => [stage, String(tokens.calls), String(tokens.input), String(tokens.cacheRead), String(tokens.cacheWrite), String(tokens.output)];
  const lines = [
    "## Cost and latency",
    "",
    `The run cost ${dollars(run.cost.total)}, or ${dollars(run.cost.perMessage)} per message. A message the guard escalates costs nothing.`,
  ];
  if (run.cost.unpricedModels.length > 0) {
    lines.push("", `No price is configured for: ${run.cost.unpricedModels.join(", ")}. Those calls are not in the cost.`);
  }
  const stages = Object.entries(run.tokens);
  if (stages.length > 0) {
    lines.push("", table(["Stage", "Calls", "Uncached input", "Cache read", "Cache write", "Output"], stages.map(([stage, tokens]) => row(stage, tokens))));
  }
  lines.push(
    "",
    `Latency: p50 ${run.latencyMs.p50} ms and p95 ${run.latencyMs.p95} ms over all messages. For answered messages, p50 ${run.latencyMs.answeredP50} ms and p95 ${run.latencyMs.answeredP95} ms.`,
  );
  if (run.retries.ofCalls > 0) {
    const causes = Object.entries(run.retries.byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, attempts]) => `${status}: ${attempts}`)
      .join(", ");
    lines.push(
      "",
      run.retries.calls === 0
        ? `None of the ${run.retries.ofCalls} model calls needed a retry.`
        : `${run.retries.calls} of ${run.retries.ofCalls} model calls got through only after a retry (failed attempts: ${causes}). A retry waits before it tries again, so API trouble that retries absorb shows up here and in the latency, not in the escalation rate.`,
    );
  }
  return lines;
}

function changeSection(current: RunSummary, baseline: RunSummary): string[] {
  const change = current.rate - baseline.rate;
  const overlap = current.interval[0] <= baseline.interval[1] && baseline.interval[0] <= current.interval[1];
  const samePolicy = JSON.stringify(current.policyVersions) === JSON.stringify(baseline.policyVersions);

  const codes = byReasonCode(baseline, current);
  const intents = byIntent(baseline, current);
  const mix = intents.reduce((sum, effect) => sum + effect.mixEffect, 0);
  const rate = intents.reduce((sum, effect) => sum + effect.rateEffect, 0);

  return [
    `## Change against ${baseline.runId}`,
    "",
    `The escalation rate went from ${percent(baseline.rate)} (${baseline.escalated} of ${baseline.messages}) to ${percent(current.rate)} (${current.escalated} of ${current.messages}): ${points(change)} points.`,
    "",
    overlap
      ? "The two runs' intervals overlap. At this volume a change of this size can be noise."
      : "The two runs' intervals do not overlap. The change is larger than noise at this volume.",
    "",
    samePolicy
      ? `Both runs used policy version ${current.policyVersions.join(", ")}. The rules did not change, so the change comes from the messages, from failures, or from model variation.`
      : `The rules changed between the runs: ${baseline.policyVersions.join(", ")} before, ${current.policyVersions.join(", ")} now.`,
    "",
    "By reason code. The contributions add up to the change exactly.",
    "",
    table(
      ["Reason code", "Before", "After", "Contribution (points)"],
      [
        ...codes.map((entry) => [entry.code, percent(entry.baselineRate), percent(entry.currentRate), points(entry.contribution)]),
        ["Total", percent(baseline.rate), percent(current.rate), points(change)],
      ],
    ),
    "",
    "By intent, mix versus rate. Mix effect: the part of the change that comes from more or fewer messages of an intent. Rate effect: the part that comes from escalating that intent more or less often. Together they add up to the change exactly.",
    "",
    table(
      ["Intent", "Share before", "Share after", "Rate before", "Rate after", "Mix effect", "Rate effect"],
      [
        ...intents.map((effect) => [effect.intent, percent(effect.shareBefore), percent(effect.shareAfter), rateOrDash(effect.rateBefore), rateOrDash(effect.rateAfter), points(effect.mixEffect), points(effect.rateEffect)]),
        ["Total", "", "", "", "", points(mix), points(rate)],
      ],
    ),
    "",
    `Of the ${points(change)} points, ${points(mix)} come from a different mix of messages and ${points(rate)} from escalating the same kinds of message at a different rate.`,
    ...(intents.some((effect) => effect.intent === "unclassified")
      ? ["", "\"unclassified\" means the router failed before it could label the message. Read those rows together with the failure causes above, not as a change in what patients asked."]
      : []),
  ];
}

export function renderReport(current: RunSummary, baseline?: RunSummary): string {
  const lines = [
    `# Escalation report: ${current.runId}`,
    "",
    `${current.messages} messages. Policy version ${current.policyVersions.join(", ")}. Models: ${current.models.join(", ")}.`,
    "",
    ...rateSection(current),
    "",
    ...answeredSection(current),
    "",
    ...costSection(current),
  ];
  if (baseline) lines.push("", ...changeSection(current, baseline));
  return `${lines.join("\n")}\n`;
}
