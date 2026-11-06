import { connection } from "next/server";

import {
  countUnreadNotifications,
  listNotifications,
} from "@/lib/admin/notifications";
import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { adminNotificationQuerySchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/notifications
 *
 * The admin notification inbox.
 *
 * Query parameters (all optional):
 *
 *   limit  how many of the most recent notifications to return (max 50)
 *
 * The response carries **both** the recent notifications and the unread
 * count, because the bell needs the two together: the badge shows the
 * count, and the dropdown shows the list. Fetching them separately would
 * mean two round trips and — worse — two reads that could disagree, so
 * the badge could say "3" while the list showed four unread rows.
 *
 * The count is taken from the same service that marks notifications
 * read, so the badge and the "mark all read" button cannot drift apart.
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminNotificationQuerySchema.parse(rawQuery);

    const [notifications, unreadCount] = await Promise.all([
      listNotifications(query.limit),
      countUnreadNotifications(),
    ]);

    return ok({ notifications, unreadCount });
  } catch (error) {
    return handleApiError(error);
  }
}
