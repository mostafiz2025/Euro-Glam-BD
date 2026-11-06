import { NextResponse } from "next/server";

import type { ApiResult } from "./types";

/**
 * Builds a successful JSON response carrying the standard envelope.
 */
export function ok<T>(data: T, status = 200): NextResponse {
  const body: ApiResult<T> = { ok: true, data };
  return NextResponse.json(body, { status });
}

/**
 * Builds a `201 Created` response.
 */
export function created<T>(data: T): NextResponse {
  return ok(data, 201);
}
