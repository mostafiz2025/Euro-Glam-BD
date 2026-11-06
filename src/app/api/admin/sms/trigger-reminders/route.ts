import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import { requireAdmin } from "@/lib/auth/guards";
import { triggerDepletionReminders } from "@/lib/sms/service";
import { triggerRemindersSchema } from "@/lib/validation/admin";

/**
 * POST /api/admin/sms/trigger-reminders
 *
 * Runs the depletion-reminder sweep.
 *
 * Body:
 *
 *   { dryRun?: boolean }   (default false)
 *
 * A dry run reports what the sweep *would* do without sending anything
 * and without changing a single row.
 *
 * The result reports `examined`, `sent`, `skipped` and `failed` as
 * **separate numbers**, so a run that examined 40 items and sent 0 is
 * visibly different from a run that examined 0. Without that
 * distinction, "nothing was sent" is indistinguishable from "nothing
 * needed sending" — which is the bug class this whole step is built to
 * avoid.
 *
 * A message only reaches a customer who explicitly opted in. The
 * consent check lives in the claim query's `WHERE` clause, so a customer
 * who opts out mid-sweep is still protected.
 *
 * Admin only.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    const admin = await requireAdmin();

    // The body is optional: a bare POST with no body is a valid
    // request to run the sweep for real.
    const rawBody = await request.json().catch(() => ({}));

    const body = triggerRemindersSchema.parse(rawBody);

    const result = await triggerDepletionReminders(toAuditActor(admin), {
      dryRun: body.dryRun,
    });

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
