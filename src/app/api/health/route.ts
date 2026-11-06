import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { db } from "@/lib/db";
import { isEmailConfigured } from "@/lib/email";

/**
 * GET /api/health
 *
 * Liveness + database connectivity check. Public — it must stay reachable
 * without a session so monitoring can use it.
 *
 * The email configuration is reported here as well, because a deployment
 * that cannot send email is one where the sign-in-by-code flow is broken
 * — and a customer discovering that at the sign-in screen is much worse
 * than an operator discovering it on a dashboard.
 *
 * The report is a **boolean**: it says whether the credentials are
 * present, never what they are.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering. The build machine may not have database
  // credentials, and a health check that passes at build time tells you
  // nothing about runtime health.
  //
  // `connection()` MUST be called outside the try block — its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    await db.$queryRaw`SELECT 1`;

    return ok({
      status: "ok",
      database: "connected",
      email: isEmailConfigured() ? "configured" : "not-configured",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
