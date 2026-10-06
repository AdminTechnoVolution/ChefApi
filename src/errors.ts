export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "recipe_refused"
  | "recipe_constraint_violation"
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
  upstream_error: 502,
  upstream_timeout: 504,
  internal_error: 500,
};

/** An error that is safe to show to API clients: the code and message are chosen by us, never by upstream. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiError";
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

export function toEnvelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}
