import { CouponDiscountType } from "@prisma/client";
import { connection } from "next/server";

import { createCoupon, listAdminCoupons } from "@/lib/admin/coupons";
import { toAuditActor } from "@/lib/admin/audit";
import { handleApiError, ApiError } from "@/lib/api/errors";
import { created, ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { adminCouponQuerySchema, couponCreateSchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/coupons
 *
 * The coupon list for the Promos panel.
 *
 * Query parameters (all optional):
 *
 *   search   filter to a code
 *   page     1-based page number
 *   limit    rows per page (max 100)
 *
 * The `counts` block reports how many coupons are active, expired and
 * exhausted. It is computed over the **whole** table, so an admin can
 * see "3 expired" even while looking at an unrelated filtered list.
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

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminCouponQuerySchema.parse(rawQuery);

    const result = await listAdminCoupons(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/admin/coupons
 *
 * Creates a coupon, atomically with its audit entry.
 *
 * The coupon's **terms** are validated by the service, which is the only
 * place that knows which discount column belongs to which type — the
 * "one of `percentOff` / `amountOffPaisa`, never both" rule cannot be
 * expressed in a Zod schema.
 *
 * The code is normalised to uppercase by the service, so "eid2026" and
 * "EID2026" are the same coupon rather than two.
 *
 * Admin only.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  try {
    const admin = await requireAdmin();

    const body: unknown = await request.json();

    const input = couponCreateSchema.parse(body);

    const coupon = await createCoupon(toAuditActor(admin), {
      code: input.code,
      description: input.description ?? null,
      discountType: input.discountType as CouponDiscountType,
      percentOff: input.percentOff ?? null,
      amountOffPaisa: input.amountOffPaisa ?? null,
      expiresAt: input.expiresAt,
      usageLimit: input.usageLimit ?? null,
      isActive: input.isActive,
      reason: input.reason,
    });

    return created({ coupon });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
