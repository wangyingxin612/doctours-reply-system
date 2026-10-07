export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ModelConfig {
  routerModel: string;
  responderModel: string;
  /** The responder model rejects temperature, so effort is its only depth and cost control. */
  responderEffort: Effort;
  /** Retries for transient API errors (429, 5xx, overloaded, network), with exponential backoff. */
  maxRetries: number;
  /**
   * How long one HTTP attempt of a router call may wait for a response, in milliseconds. After that
   * the attempt is dropped and retried. 0 turns the limit off.
   *
   * The default leaves room for a slow start. A healthy router call answers in about 4 seconds.
   * The first calls after the router's output schema changes took 7, while the API prepared the
   * schema, and anyone who runs this with their own key starts there. Requests that hang have
   * taken 27 and 55 seconds, and those are what the limit is for.
   */
  routerAttemptTimeoutMs: number;
  /**
   * Server-side refusal fallback, a beta feature. When on, some refused requests are retried on an
   * earlier model by the API. Off unless RESPONDER_FALLBACKS=default.
   */
  responderFallbacks: boolean;
}

export const DEFAULT_ROUTER_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_RESPONDER_MODEL = "claude-sonnet-5-5";
export const DEFAULT_ROUTER_ATTEMPT_TIMEOUT_MS = 20_000;

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

function fallbacksFromEnv(value: string | undefined): boolean {
  const setting = value?.trim().toLowerCase();
  if (!setting || setting === "off") return false;
  if (setting === "default") return true;
  throw new Error(`RESPONDER_FALLBACKS must be "default" or "off". Got "${value}".`);
}

export function loadModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    routerModel: env.ROUTER_MODEL?.trim() || DEFAULT_ROUTER_MODEL,
    responderModel: env.RESPONDER_MODEL?.trim() || DEFAULT_RESPONDER_MODEL,
    responderEffort: effortFromEnv(env.RESPONDER_EFFORT),
    maxRetries: countFromEnv("LLM_MAX_RETRIES", env.LLM_MAX_RETRIES, 5),
    routerAttemptTimeoutMs: countFromEnv("ROUTER_ATTEMPT_TIMEOUT_MS", env.ROUTER_ATTEMPT_TIMEOUT_MS, DEFAULT_ROUTER_ATTEMPT_TIMEOUT_MS),
    responderFallbacks: fallbacksFromEnv(env.RESPONDER_FALLBACKS),
  };
}
