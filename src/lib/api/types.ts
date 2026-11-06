/**
 * API response envelope and error codes.
 *
 * Every route handler returns one of these two shapes. The discriminant
 * `ok` lets a client branch without inspecting HTTP status codes, while the
 * HTTP status still carries the correct semantics for proxies, monitoring,
 * and browser tooling.
 */

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "AI_PROVIDER_ERROR"
  | "BAD_GATEWAY"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type ApiSuccess<T> = {
  ok: true;
  data: T;
};

export type ApiFailure = {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/**
 * Default HTTP status for each error code. Centralised so a route cannot
 * return a mismatched pair (e.g. a 200 carrying a FORBIDDEN body).
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  AI_PROVIDER_ERROR: 502,
  BAD_GATEWAY: 502,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};
