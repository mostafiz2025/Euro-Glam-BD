import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { openGatewaySession } from "@/lib/payments/gateway";
import { entityIdSchema } from "@/lib/validation/commerce";
import { gatewaySessionSchema } from "@/lib/validation/payments";

/**
 * Open (or re-arm) a gateway session on an order.
 *
 * `POST /api/orders/{orderId}/payment/session`
 *
 * ── Why this endpoint exists ──────────────────────────────────────────────
 *
 * The checkout opens the gateway window with the session that was minted
 * **inside the order transaction**. That covers the normal path.
 *
 * It does not cover the customer who closed the tab mid-payment. They
 * have an order, the stock is reserved, the payment is `PENDING`, and
 * the token they were holding is still on the order — but they have no
 * way back to the window.
 *
 * This endpoint is that way back. It rotates the token to a fresh one
 * and returns the payload the window renders.
 *
 * It is refused unless the payment is `PENDING`: a settled order has no
 * window to open, and a `FAILED` one is terminal.
 *
 * ── The body is empty on purpose ─────────────────────────────────────────
 *
 * The order id is in the path, and the server reads everything else from
 * the order. A body that could carry an amount would be a body that
 * could be edited — and the amount the customer pays is the server's
 * number, always.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();

    const { id } = await context.params;

    const orderId = entityIdSchema.parse(id);

    // Parsed for the discipline, not for the content: an unexpected key
    // is a 400 rather than something quietly dropped.
    gatewaySessionSchema.parse(await request.json().catch(() => ({})));

    const session = await openGatewaySession(user, orderId);

    return ok({ session });
  } catch (error) {
    return handleApiError(error);
  }
}
