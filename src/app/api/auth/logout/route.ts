import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { clearSessionCookie } from "@/lib/auth/session";

/**
 * POST /api/auth/logout
 *
 * Clears the session cookie.
 *
 * The JWT itself cannot be revoked — it remains valid until its `exp`
 * passes, and a copy taken before logout would still work. That is the
 * standard trade-off of stateless tokens.
 *
 * If immediate revocation is required later, the token must be tracked
 * server-side (a session table, or a short TTL plus a refresh token). For
 * an MVP with a 7-day TTL this is an accepted trade-off; shortening
 * `AUTH_JWT_TTL_SECONDS` is the lever if the risk changes.
 */
export async function POST(): Promise<Response> {
  // Opt out of prerendering — this route writes a session cookie.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    await clearSessionCookie();
    return ok({ success: true });
  } catch (error) {
    return handleApiError(error);
  }
}
