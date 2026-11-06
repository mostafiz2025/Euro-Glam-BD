import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import { deactivateCoupon } from "@/lib/admin/coupons";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { couponDeactivateSchema } from "@/lib/validation/admin";

/**
 * POST /api/admin/coupons/[id]/deactivate
 *
 * Deactivates a coupon, atomically with its audit entry.
 *
 * ── Why deactivate rather than delete ────────────────────────────────────
 *
 * A coupon that has been redeemed has **history**. Deleting the row
 * would erase the record of the campaign — how many times it ran, when
 * it ran, what it was worth — and the orders that used it would point at
 * a code that no longer exists.
 *
 * So the ordinary path is "switch it off". The row stays, the audit
 * entry says it was deactivated, and the redemption count is preserved.
 *
 * The **reason is mandatory**: deactivating a coupon stops an advertised
 * discount working, and a customer holding that code is entitled to an
 * explanation.
 *
 * Admin only.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const { id } = await context.params;

    const couponId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const input = couponDeactivateSchema.parse(body);

    const coupon = await deactivateCoupon(
      toAuditActor(admin),
      couponId,
      input.reason,
    );

    return ok({ coupon });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
