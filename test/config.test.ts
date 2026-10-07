import { describe, expect, it } from "vitest";
import { loadModelConfig } from "../config/models";

describe("model config", () => {
  it("has defaults for everything but the key", () => {
    expect(loadModelConfig({})).toEqual({
      routerModel: "claude-haiku-4-5-20251001",
      responderModel: "claude-sonnet-5-5",
      responderEffort: "low",
      maxRetries: 5,
      routerAttemptTimeoutMs: 8000,
      responderFallbacks: false,
    });
  });

  it("reads each setting from the environment", () => {
    const config = loadModelConfig({
      ROUTER_MODEL: "small-model",
      RESPONDER_MODEL: "main-model",
      RESPONDER_EFFORT: "Medium",
      LLM_MAX_RETRIES: "2",
      ROUTER_ATTEMPT_TIMEOUT_MS: "0",
      RESPONDER_FALLBACKS: "default",
    });
    expect(config).toEqual({
      routerModel: "small-model",
      responderModel: "main-model",
      responderEffort: "medium",
      maxRetries: 2,
      routerAttemptTimeoutMs: 0,
      responderFallbacks: true,
    });
  });

  it.each([
    [{ RESPONDER_EFFORT: "extreme" }, /RESPONDER_EFFORT/],
    [{ LLM_MAX_RETRIES: "-1" }, /LLM_MAX_RETRIES/],
    [{ ROUTER_ATTEMPT_TIMEOUT_MS: "8s" }, /ROUTER_ATTEMPT_TIMEOUT_MS/],
    [{ RESPONDER_FALLBACKS: "yes" }, /RESPONDER_FALLBACKS/],
  ])("rejects a setting it cannot read: %o", (env, message) => {
    expect(() => loadModelConfig(env)).toThrow(message);
  });
});
