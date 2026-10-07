import { createHash } from "node:crypto";
import { ACTION_CATALOG } from "./actions";
import { ESCALATION_TABLE, HANDOFF_SENTENCE, POLICY_VERSION } from "./escalation";

/**
 * A short hash of everything that shapes behavior: the policy tables, plus any skill and prompt
 * text the caller passes in. Two runs with the same hash ran the same rules.
 */
export function computePolicyVersion(texts: Readonly<Record<string, string>> = {}): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ POLICY_VERSION, HANDOFF_SENTENCE, ESCALATION_TABLE, ACTION_CATALOG }));
  for (const name of Object.keys(texts).sort()) {
    hash.update(`\n--- ${name} ---\n${texts[name]}`);
  }
  return `${POLICY_VERSION}+${hash.digest("hex").slice(0, 12)}`;
}
