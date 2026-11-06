import { connection } from "next/server";

import { markAllNotificationsRead } from "@/lib/admin/notifications";
import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";

/**
 * PATCH /api/admin/notifications/read-all
 *
 * Marks every unread notification as read.
 *
 * The "mark all read" action on the bell. It returns **how many** it
 * changed, so the client can zero the badge without a second request —
 * the badge is then exactly right rather than approximately right.
 *
 * There is no body and no body schema, because there is nothing to
 * validate: the request says only "all of them".
 *
 * This writes **no** audit entry, for the same reason marking one read
 * does not: dismissing the inbox is not a business decision.
 */
export async function PATCH(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    await requireAdmin();

    const markedCount = await markAllNotificationsRead();

    return ok({ markedCount });
  } catch (error) {
    return handleApiError(error);
  }
}
