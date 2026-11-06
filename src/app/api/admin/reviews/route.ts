import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { listAdminReviews } from "@/lib/admin/reviews";
import { requireAdmin } from "@/lib/auth/guards";
import { adminReviewQuerySchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/reviews
 *
 * The review moderation queue.
 *
 * Query parameters (all optional):
 *
 *   status      PENDING | APPROVED | HIDDEN | ALL   (default PENDING)
 *   productId   filter to one product
 *   userId      filter to one customer
 *   page        1-based page number
 *   limit       rows per page (max 100)
 *
 * The `counts` block reports how many reviews sit in each moderation
 * state. It is computed from the **same** `where` shapes as the list, so
 * a filter that matches nothing shows `0` in both places rather than
 * looking like an empty queue.
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminReviewQuerySchema.parse(rawQuery);

    const result = await listAdminReviews(query);

    return ok({ ...result, requestedBy: admin.id });
  } catch (error) {
    return handleApiError(error);
  }
}
