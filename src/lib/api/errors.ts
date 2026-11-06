import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AiProviderError } from "@/lib/ai/provider";

import { ERROR_STATUS, type ApiFailure, type ErrorCode } from "./types";

/**
 * A typed error carrying an HTTP status and a machine-readable error code.
 *
 * Route handlers throw these; `handleApiError` converts them into the
 * standard envelope. Using a class (rather than returning error responses
 * inline) means a guard can abort a handler from any depth without every
 * call site needing to check a return value.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }

  /** 401 — no valid session was presented. */
  static unauthenticated(message = "Authentication required."): ApiError {
    return new ApiError("UNAUTHENTICATED", message);
  }

  /** 403 — authenticated, but the role does not permit this action. */
  static forbidden(message = "You do not have permission to do that."): ApiError {
    return new ApiError("FORBIDDEN", message);
  }

  /** 404 — the resource does not exist, or is not owned by the caller. */
  static notFound(message = "Not found."): ApiError {
    return new ApiError("NOT_FOUND", message);
  }

  /** 400 — the request body failed validation. */
  static validation(
    message: string,
    details?: Record<string, unknown>,
  ): ApiError {
    return new ApiError("VALIDATION_ERROR", message, details);
  }

  /**
   * 409 — the request conflicts with existing state (e.g. duplicate email).
   *
   * `details` carries the machine-readable context — the current status
   * and the permitted targets, for example. A 409 that says only
   * "conflict" is a support ticket; a 409 that says what the state
   * actually is, and what would have been allowed, is a fix.
   */
  static conflict(
    message: string,
    details?: Record<string, unknown>,
  ): ApiError {
    return new ApiError("CONFLICT", message, details);
  }
}

/**
 * Builds the failure envelope for a given code.
 */
export function failure(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiFailure {
  return {
    ok: false,
    error: details ? { code, message, details } : { code, message },
  };
}

/**
 * Converts a ZodError into the flat, field-keyed shape the envelope expects.
 *
 * `fieldErrors` maps a field path to its messages. A path like
 * `profile.skinType` becomes the key "profile.skinType".
 */
function zodDetails(error: ZodError): Record<string, unknown> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_root";
    (fieldErrors[path] ??= []).push(issue.message);
  }

  return { fieldErrors };
}

/**
 * The single error path for every route handler.
 *
 * Known error types map to their code. Anything unrecognised becomes a
 * generic INTERNAL_ERROR — the underlying message is logged server-side but
 * never returned to the client, so stack traces and database errors cannot
 * leak to callers.
 */
export function handleApiError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      failure(error.code, error.message, error.details),
      { status: error.status },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      failure(
        "VALIDATION_ERROR",
        "The request failed validation.",
        zodDetails(error),
      ),
      { status: ERROR_STATUS.VALIDATION_ERROR },
    );
  }

  // Prisma unique-constraint violation → a conflict, not a crash.
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  ) {
    return NextResponse.json(
      failure("CONFLICT", "That record already exists."),
      { status: ERROR_STATUS.CONFLICT },
    );
  }

  /**
   * Prisma foreign-key violation → 409, not a crash.
   *
   * P2003 is raised when a write would leave a dangling reference — the
   * classic case being a hard delete of a product that gained an order
   * item between the service's check and the delete.
   *
   * It is a **conflict**, not a crash: the request was reasonable, the
   * world simply moved underneath it. Without this branch it falls
   * through to the generic 500 "Something went wrong", which tells the
   * admin nothing and makes a routine race look like an outage.
   *
   * The message names the remedy — archive instead of delete — because
   * that is what the admin should actually do.
   */
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2003"
  ) {
    console.error("[api] Foreign-key violation (P2003):", error);

    return NextResponse.json(
      failure(
        "CONFLICT",
        "That record is now part of an order and cannot be deleted. Archive it instead.",
      ),
      { status: ERROR_STATUS.CONFLICT },
    );
  }

  // Prisma "record not found" → 404.
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2025"
  ) {
    return NextResponse.json(
      failure("NOT_FOUND", "Not found."),
      { status: ERROR_STATUS.NOT_FOUND },
    );
  }

  /**
   * Prisma transaction conflict → 409, and the caller may retry.
   *
   * P2034 is raised when an interactive transaction deadlocks or fails to
   * serialise. It is transient by definition — the same transaction
   * submitted again will usually succeed. Two concurrent checkouts that
   * contend for the last unit of stock are the realistic cause.
   */
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034"
  ) {
    console.error("[api] Transaction conflict (P2034):", error);

    return NextResponse.json(
      failure(
        "CONFLICT",
        "Another order was being placed at the same time. Please try again.",
      ),
      { status: ERROR_STATUS.CONFLICT },
    );
  }

  /**
   * The AI provider failed → 502, not 500.
   *
   * The request was well-formed and correctly authorised; the thing that
   * broke was **upstream of us**. A 500 says "this application is
   * broken", and that is the wrong story to tell a customer whose
   * question was perfectly reasonable — and the wrong signal to send a
   * dashboard, where a 502 means "retry later" and a 500 means "page
   * someone".
   *
   * The `AI_PROVIDER_ERROR` code already existed in the error-code union
   * and was already mapped to 502, but nothing ever threw it: the service
   * rethrew the provider's error unchanged and the error handler had no
   * branch for it, so every provider failure fell through to the generic
   * 500 at the bottom of this function.
   *
   * The provider's own message is deliberately **not** returned. It can
   * carry upstream detail — a model name, a quota, a raw API error —
   * and none of that belongs in a customer's response. The log keeps it.
   */
  if (error instanceof AiProviderError) {
    console.error(
      `[api] The AI provider "${error.providerName}" failed:`,
      error,
    );

    return NextResponse.json(
      failure(
        "AI_PROVIDER_ERROR",
        "The advisor is having trouble answering right now. Please try again in a moment.",
      ),
      { status: ERROR_STATUS.AI_PROVIDER_ERROR },
    );
  }

  console.error("[api] Unhandled error:", error);

  return NextResponse.json(
    failure("INTERNAL_ERROR", "Something went wrong. Please try again."),
    { status: ERROR_STATUS.INTERNAL_ERROR },
  );
}
