export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ModelConfig {
  routerModel: string;
  responderModel: string;
  /** The responder model rejects temperature, so effort is its only depth and cost control. */
  responderEffort: Effort;
  /** Retries for transient API errors (429, 5xx, overloaded, network), with exponential backoff. */
  maxRetries: number;
}

export const DEFAULT_ROUTER_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_RESPONDER_MODEL = "claude-sonnet-5-5";

function effortFromEnv(value: string | undefined): Effort {
  const effort = value?.trim().toLowerCase();
  if (!effort) return "low";
  if ((EFFORTS as readonly string[]).includes(effort)) return effort as Effort;
  throw new Error(`RESPONDER_EFFORT must be one of ${EFFORTS.join(", ")}. Got "${value}".`);
}

function countFromEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  throw new Error(`${name} must be a whole number of 0 or more. Got "${value}".`);
}

export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    routerModel: env.ROUTER_MODEL?.trim() || DEFAULT_ROUTER_MODEL,
    responderModel: env.RESPONDER_MODEL?.trim() || DEFAULT_RESPONDER_MODEL,
    responderEffort: effortFromEnv(env.RESPONDER_EFFORT),
    maxRetries: countFromEnv("LLM_MAX_RETRIES", env.LLM_MAX_RETRIES, 5),
  };
}
