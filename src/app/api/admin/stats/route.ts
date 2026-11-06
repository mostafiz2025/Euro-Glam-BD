import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { getDashboardStats } from "@/lib/admin/stats";
import { requireAdmin } from "@/lib/auth/guards";

/**
 * GET /api/admin/stats
 *
 * The dashboard's overview figures.
 *
 * Returns the counts for orders, products, reviews and users in one
 * response, so the dashboard renders from a single request rather than
 * six. The counts are computed server-side from the same `where` shapes
 * the lists use, so the number on a tile and the number in the list
 * beneath it can never disagree.
 *
 * Admin only.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    await requireAdmin();

    const stats = await getDashboardStats();

    return ok({ stats });
  } catch (error) {
    return handleApiError(error);
  }
}
