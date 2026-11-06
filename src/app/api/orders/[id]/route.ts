import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { getOrderById } from "@/lib/orders/service";
import { entityIdSchema } from "@/lib/validation/commerce";

/**
 * GET /api/orders/[id]
 *
 * A single order belonging to the signed-in customer.
 *
 * The query is scoped by `userId`, so an order belonging to another
 * customer returns 404 — exactly the same response as an order that does
 * not exist. The endpoint cannot be used to discover or read other
 * customers' orders.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database.
  await connection();

  try {
    const user = await requireCustomer();

    const { id } = await context.params;

    const orderId = entityIdSchema.parse(id);

    const order = await getOrderById(user.id, orderId);

    if (!order) {
      throw ApiError.notFound("That order does not exist.");
    }

    return ok({ order });
  } catch (error) {
    return handleApiError(error);
  }
}
