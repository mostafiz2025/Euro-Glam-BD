import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import { requireAdmin } from "@/lib/auth/guards";
import { resendReminder } from "@/lib/sms/service";
import { resendSchema } from "@/lib/validation/admin";

/**
 * POST /api/admin/sms/resend
 *
 * Resends a depletion reminder for one order item, by hand.
 *
 * Body:
 *
 *   { orderItemId: string, reason?: string }
 *
 * A manual resend **bypasses the schedule** — the item may already have
 * been reminded, and the reminder may not be due yet. That is the point
 * of a manual resend.
 *
 * It does **not** bypass consent. Admin authority is for *deciding to
 * send*, not for *overriding the recipient's consent*. A customer who
 * has not opted in cannot be messaged, even by an admin; the request is
 * refused with a 409 saying so.
 *
 * A repeated manual resend of the same item is refused with a 409 rather
 * than being silently absorbed by the unique constraint on
 * `SmsLog.idempotencyKey`.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    const admin = await requireAdmin();

    const body = resendSchema.parse(await request.json());

    const result = await resendReminder(
      toAuditActor(admin),
      body.orderItemId,
      { reason: body.reason },
    );

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
