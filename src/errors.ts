export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "recipe_refused"
  | "recipe_constraint_violation"
  | "plan_required"
  | "ai_quota_exceeded"
  | "conflict"
  | "upstream_error"
  | "upstream_timeout"
  | "internal_error";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  not_found: 404,
  payload_too_large: 413,
  rate_limited: 429,
  // 422: the request was fine but no acceptable recipe could be produced. The app shows "try again".
  recipe_refused: 422,
  recipe_constraint_violation: 422,
  // 403: the caller is known but their plan does not include this, or they have used up their month. The app shows the plans.
  plan_required: 403,
  ai_quota_exceeded: 403,
  conflict: 409,
  upstream_error: 502,
  upstream_timeout: 504,
  internal_error: 500,
};

/** Extra, machine-readable facts an error can carry (which feature, which plan, how much of the month is used). */
export type ErrorDetails = Record<string, string | number | boolean | null>;

/** An error that is safe to show to API clients: the code and message are chosen by us, never by upstream. */
export class ApiError extends Error {
  readonly details?: ErrorDetails;

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown; details?: ErrorDetails },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ApiError";
    this.details = options?.details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: ErrorDetails };
}

export function toEnvelope(code: ErrorCode, message: string, details?: ErrorDetails): ErrorEnvelope {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
