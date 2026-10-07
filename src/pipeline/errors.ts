import { LlmError } from "../llm/client";
import type { FailureCause } from "../trace/types";
import type { Violation } from "../validators/types";

/** The run cannot continue, for example because the API key is missing or rejected. */
export class FatalRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FatalRunError";
  }
}

/** The reply still broke a blocking rule after its one repair attempt. */
export class ReplyRejectedError extends Error {
  readonly violations: Violation[];

  constructor(violations: Violation[]) {
    super(`Reply rejected by validators: ${violations.map((violation) => violation.validator).join(", ")}`);
    this.name = "ReplyRejectedError";
    this.violations = violations;
  }
}

export function isFatal(error: unknown): boolean {
  return error instanceof FatalRunError || (error instanceof LlmError && error.failureCause === "auth");
}

export function toFatal(error: unknown): FatalRunError {
  if (error instanceof FatalRunError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FatalRunError(message, { cause: error });
}

/** Why a message fell back to a person. Kept apart from policy so the report does not blame policy. */
export function toFailure(error: unknown): { cause: FailureCause; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof ReplyRejectedError) return { cause: "validator", detail };
  if (error instanceof LlmError && error.failureCause !== "auth") return { cause: error.failureCause, detail };
  return { cause: "internal_error", detail };
}
