import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { changePaymentStatusAsUser } from "@/lib/admin/orders";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { paymentStatusUpdateSchema } from "@/lib/validation/admin";

/**
 * PATCH /api/admin/orders/[id]/payment
 *
 * Moves an order's payment status.
 *
 * Body:
 *
 *   { paymentStatus: "PAID" | "FAILED" | "REFUNDED", reason?: string }
 *
 * The payment axis is **independent** of the fulfilment axis. A COD
 * order can be `SHIPPED` while the payment is still `PENDING`, because
 * the cash is collected on delivery — and it is exactly for this reason
 * that the two axes have separate audit actions.
 *
 * The permitted transitions are:
 *
 *   PENDING → PAID | FAILED | REFUNDED
 *   PAID    → REFUNDED
 *   FAILED  → (terminal)
 *   REFUNDED → (terminal)
 *
 * `PENDING` is not a target: an admin marking an order `PAID` before the
 * courier collects the cash would be recording something untrue.
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

    const body = paymentStatusUpdateSchema.parse(await request.json());

    const order = await changePaymentStatusAsUser(
      admin,
      orderId,
      body.paymentStatus,
      body.reason,
    );

    return ok({ order });
  } catch (error) {
    return handleApiError(error);
  }
}
