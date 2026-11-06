import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { getAdminOrder } from "@/lib/admin/orders";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";

/**
 * GET /api/admin/orders/[id]
 *
 * One order, in full — the items, the totals, the shipping address and
 * the customer's contact details.
 *
 * Unlike the customer-facing order endpoint, this one is **not** scoped
 * by `userId`. An admin needs to see any order; the guard is what
 * restricts it.
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

    const orderId = entityIdSchema.parse(id);

    const order = await getAdminOrder(orderId);

    return ok({ order });
  } catch (error) {
    return handleApiError(error);
  }
}
