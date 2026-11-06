import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { adjustProductStockAsUser } from "@/lib/admin/products";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { stockAdjustmentSchema } from "@/lib/validation/admin";

/**
 * PATCH /api/admin/products/[id]/stock
 *
 * Adjusts a product's stock quantity.
 *
 * Body:
 *
 *   { delta: number, reason?: string }
 *
 * The adjustment is a **signed delta**, not an absolute quantity. "Add
 * 10" and "remove 3" are adjustments; "set to 42" is not, because it
 * would silently clobber a concurrent checkout's reservation.
 *
 * The write and its audit entry are written in **one** transaction. An
 * adjustment that would leave the stock negative is refused with a 409
 * and writes nothing at all — the shelf does not hold that many units,
 * and quietly setting it to zero would hide the mistake.
 *
 * Admin only.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const { id } = await context.params;

    const productId = entityIdSchema.parse(id);

    const body = stockAdjustmentSchema.parse(await request.json());

    const result = await adjustProductStockAsUser(
      admin,
      productId,
      body.delta,
      body.reason,
    );

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
