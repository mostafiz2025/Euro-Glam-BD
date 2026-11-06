import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { settleGatewayPayment } from "@/lib/payments/gateway";
import { entityIdSchema } from "@/lib/validation/commerce";
import { gatewaySettleSchema } from "@/lib/validation/payments";

/**
 * Settle a gateway payment.
 *
 * `POST /api/orders/{orderId}/payment/settle`
 *
 * ── What this endpoint is ────────────────────────────────────────────────
 *
 * The customer-facing half of the sandbox payment gateway. The order has
 * already been placed and its stock reserved; this is the call that
 * settles the **money**.
 *
 * It is **not** under `/api/admin/*`, and that is deliberate. The admin
 * route settles a customer's payment on their behalf — a staff member
 * confirming a transfer against a merchant statement. This route settles
 * a customer's payment on **their own** behalf, through the gateway. Two
 * different actors, two different audit actions, two different paths.
 *
 * ── The authorisation ────────────────────────────────────────────────────
 *
 * Two things are required, and both are needed:
 *
 *   • The **session cookie**, and `requireCustomer()` — which admits any
 *     signed-in shopper, because the order is scoped to the caller's own
 *     id. An administrator settling a *customer's* payment is a
 *     different actor with a different audit action, and it lives on its
 *     own endpoint under `/api/admin`.
 *
 *   • The **session token** in the body — the one-shot capability that
 *     authorises this specific settle on this specific order.
 *
 * The token alone would be enough to authorise the write, but the pair
 * gives a precise error: a foreign order id is a 404, and a stale token
 * on a real order is a 409.
 *
 * ── A simulated failure returns 200, not 4xx ──────────────────────────────
 *
 * The request was well-formed and correctly authorised; the **payment**
 * failed. Returning a 4xx would make the client unable to tell "the
 * gateway declined" from "your session expired" — and the first is
 * retryable while the second is not.
 *
 * So the failure is a **successful API call reporting a failed payment**:
 *
 *   200 → the order and the attempt, with `attempt.outcome` saying
 *         `FAILED` and `order.paymentStatus` still `PENDING`.
 *   401 → not signed in.
 *   404 → the order does not exist, or is not yours.
 *   409 → the token is stale, consumed, or the payment is settled.
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

    const body = gatewaySettleSchema.parse(await request.json());

    /**
     * The transfer reference, when the customer quoted one.
     *
     * It is only meaningful for a mobile-banking order, and the service
     * decides that by reading the **order row** — not from this body.
     * A client-supplied method would be a second, editable copy of the
     * truth, so the method is deliberately absent from the request.
     */
    const transfer =
      body.paymentSenderNumber !== undefined &&
      body.paymentTransactionId !== undefined
        ? {
            paymentSenderNumber: body.paymentSenderNumber,
            paymentTransactionId: body.paymentTransactionId,
          }
        : undefined;

    const result = await settleGatewayPayment(
      user,
      orderId,
      body.sessionId,
      body.outcome,
      transfer,
    );

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
