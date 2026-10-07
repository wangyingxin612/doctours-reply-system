// The stages after the guard: classify, decide, plan, write.

import type { LlmDeps } from "../llm/client";
import { decideFromRouter } from "../policy/decide";
import { buildEscalationReply } from "../policy/escalation";
import { computePolicyVersion } from "../policy/version";
import { loadPrompt, PROMPT_NAMES } from "../prompts";
import { loadSkills } from "../skills/loader";
import { readCallHistory } from "../subtasks/callHistory";
import { buildPlan } from "./plan";
import { runResponder } from "./responder";
import { runRouter } from "./router";
import type { AnswerStage } from "./run";
import { recordAnchorAsked } from "./stage";

/** `deps.model` swaps in a mock model for tests. In production it is left empty. */
export function createAnswerStage(deps: LlmDeps = {}): AnswerStage {
  return async ({ message, guard, ledger, record, context, config }) => {
    const skills = loadSkills(context.vertical);

    const routed = await runRouter({ text: message.text, context, skills, config }, deps);
    record.router = routed.output;
    record.primaryIntent = routed.output.primaryIntent;
    record.modelCalls.push(routed.call);

    // The router only named what the patient asked for. The tables decide whether a person takes over.
    const decision = decideFromRouter({
      humanRequested: routed.output.humanRequested,
      actions: routed.output.requestedActions.map((action) => action.type),
    });
    if (decision.reasonCode !== null) {
      // The whole message gets the short reply: no prefetch, no side effects, no responder call.
      return { reply: buildEscalationReply(decision.reasonCode), decision };
    }

    const plan = buildPlan({ router: routed.output, text: message.text, context, skills, ledger });
    record.skillsLoaded = [plan.core, ...(plan.stage ? [plan.stage] : []), ...plan.selected].map((skill) => skill.name);
    record.directives = plan.directives;
    record.precedence = plan.precedence;
    record.events.push(...plan.events);

    if (routed.output.needsCallHistory) {
      const history = await readCallHistory({ question: message.text, context, ledger, config }, deps);
      plan.extraFacts.push(history.fact);
      if (history.call) record.modelCalls.push(history.call);
    }

    const reply = await runResponder(
      {
        message,
        context,
        plan,
        ledger,
        record,
        config,
        redactedTokens: guard.redactions.map((redaction) => redaction.token),
      },
      deps,
    );
    return { reply: recordAnchorAsked(reply, plan.directives.anchor, context), decision };
  };
}

/** Hash of the policy tables, every skill file and every prompt. Recorded in each trace. */
export function currentPolicyVersion(vertical: string): string {
  const texts: Record<string, string> = {};
  for (const skill of loadSkills(vertical).skills) texts[`skill:${skill.name}`] = skill.raw;
  for (const name of PROMPT_NAMES) texts[`prompt:${name}`] = loadPrompt(name);
  return computePolicyVersion(texts);
}
