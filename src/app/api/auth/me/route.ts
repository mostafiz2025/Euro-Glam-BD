import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireUser } from "@/lib/auth/guards";

/**
 * GET /api/auth/me
 *
 * Returns the currently signed-in user. Used by client components to
 * determine whether to render the signed-in or signed-out view.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering. This route reads the session cookie, and
  // `cookies()` rejects when evaluated outside a request scope.
  //
  // `connection()` MUST be called outside the try block. Its rejection is
  // the signal that aborts prerendering — catching it here would convert
  // the abort into a 500 response and the build would still attempt to
  // render the route at build time.
  await connection();

  try {
    const user = await requireUser();
    return ok({ user });
  } catch (error) {
    return handleApiError(error);
  }
}
