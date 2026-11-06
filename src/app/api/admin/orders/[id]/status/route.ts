import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { changeOrderStatusAsUser } from "@/lib/admin/orders";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { orderStatusUpdateSchema } from "@/lib/validation/admin";

/**
 * PATCH /api/admin/orders/[id]/status
 *
 * Moves an order along the fulfilment pipeline.
 *
 * Body:
 *
 *   { status: "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED", reason?: string }
 *
 * The permitted transitions are a closed, forward-only table:
 *
 *   PENDING    → PROCESSING, CANCELLED
 *   PROCESSING → SHIPPED, CANCELLED
 *   SHIPPED    → DELIVERED
 *   DELIVERED  → (terminal)
 *   CANCELLED  → (terminal)
 *
 * `SHIPPED → CANCELLED` is not permitted: the goods have left the
 * warehouse, and the refund is a separate operation.
 *
 * Cancelling restores the reserved stock, exactly once. The status
 * change, the stock restoration and the audit entry share one
 * transaction, so an order cannot be cancelled without the stock coming
 * back.
 *
 * An illegal transition is a 409 that names the current status and the
 * permitted targets. Nothing is written and no audit entry is created.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    const admin = await requireAdmin();

    const { id } = await context.params;

    const orderId = entityIdSchema.parse(id);

    const body = orderStatusUpdateSchema.parse(await request.json());

    const order = await changeOrderStatusAsUser(
      admin,
      orderId,
      body.status,
      body.reason,
    );

    return ok({ order });
  } catch (error) {
    return handleApiError(error);
  }
}
