import { CouponDiscountType } from "@prisma/client";
import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import { getAdminCoupon, updateCoupon } from "@/lib/admin/coupons";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { couponUpdateSchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/coupons/[id]
 *
 * One coupon, in full.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    await requireAdmin();

    const { id } = await context.params;

    const couponId = entityIdSchema.parse(id);

    const coupon = await getAdminCoupon(couponId);

    if (!coupon) {
      throw ApiError.notFound("That coupon does not exist.");
    }

    return ok({ coupon });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/coupons/[id]
 *
 * A **partial** update: a field that is absent is left exactly as it
 * was.
 *
 * A change to the **discount terms** requires a reason. The terms are a
 * price reduction — "twenty percent off" is a change to what the
 * customer pays — and an audit entry that says "percentOff 10 → 20" with
 * no reason cannot answer "why". The same rule the product price change
 * follows.
 *
 * Switching a coupon on or off is *not* a change to what it is worth, so
 * it does not require one.
 *
 * Admin only.
 */
export async function PATCH(
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

    const input = couponUpdateSchema.parse(body);

    // An empty patch would change nothing and write nothing. Refusing it
    // is better than returning a 200 that appears to have done something.
    if (Object.keys(input).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const coupon = await updateCoupon(toAuditActor(admin), couponId, {
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.discountType !== undefined
        ? { discountType: input.discountType as CouponDiscountType }
        : {}),
      ...(input.percentOff !== undefined
        ? { percentOff: input.percentOff }
        : {}),
      ...(input.amountOffPaisa !== undefined
        ? { amountOffPaisa: input.amountOffPaisa }
        : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.usageLimit !== undefined
        ? { usageLimit: input.usageLimit }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    return ok({ coupon });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
