import { connection } from "next/server";

import { markNotificationRead } from "@/lib/admin/notifications";
import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";

/**
 * PATCH /api/admin/notifications/[id]/read
 *
 * Marks one notification as read.
 *
 * There is no body — the only thing the request says is *which*
 * notification, and that is in the path.
 *
 * A notification that no longer exists is **not** an error. The admin may
 * have dismissed a toast whose row was cleaned up, and refusing the
 * request would make the bell's optimistic update fail for no reason. So
 * the response is `{ notification: null }` — the client treats "null" as
 * "already gone, carry on".
 *
 * This writes **no** audit entry. Reading a notification changes nothing
 * about the order, the customer or the money — the audit trail is for
 * decisions that change the business, and "the admin glanced at a toast"
 * is not one of them.
 */
export async function PATCH(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    await requireAdmin();

    const { id } = await context.params;

    const notificationId = entityIdSchema.parse(id);

    const notification = await markNotificationRead(notificationId);

    return ok({ notification });
  } catch (error) {
    return handleApiError(error);
  }
}
