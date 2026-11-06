import { connection } from "next/server";

import {
  getGrowthMetrics,
  getSalesSeries,
  getTrafficBreakdown,
  type SalesRange,
} from "@/lib/admin/analytics";
import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";

/**
 * GET /api/admin/analytics
 *
 * The dashboard's charts: the sales series, the growth metrics and the
 * traffic breakdown.
 *
 * ── Why the range is validated rather than defaulted ─────────────────────
 *
 * The `range` parameter picks between three fixed SQL formulations — the
 * bucket unit and the interval step are **literals** in the query, so
 * they cannot be bind parameters. That makes the range a closed set of
 * three values, and an unrecognised value is an error rather than a
 * silent fallback to "DAILY".
 *
 * A silent fallback would be wrong here: an admin who asks for MONTHLY
 * and receives DAILY would be reading a chart that answers a different
 * question, with no indication that anything went wrong.
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
    await requireAdmin();

    const url = new URL(request.url);

    const requestedRange = url.searchParams.get("range") ?? "DAILY";

    if (!isSalesRange(requestedRange)) {
      return ok({
        error:
          `Unknown range "${requestedRange}". Use DAILY, WEEKLY or MONTHLY.`,
      });
    }

    const trafficDays = url.searchParams.get("trafficDays") ?? "30";

    const parsedDays = Number.parseInt(trafficDays, 10);

    // The window is clamped to a year. An unbounded window would let a
    // caller ask for every row ever recorded.
    const days =
      Number.isFinite(parsedDays) && parsedDays > 0
        ? Math.min(parsedDays, 365)
        : 30;

    const [series, growth, traffic] = await Promise.all([
      getSalesSeries(requestedRange),
      getGrowthMetrics(),
      getTrafficBreakdown(days),
    ]);

    return ok({ range: requestedRange, series, growth, traffic });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * The range type guard.
 */
function isSalesRange(value: string): value is SalesRange {
  return value === "DAILY" || value === "WEEKLY" || value === "MONTHLY";
}
