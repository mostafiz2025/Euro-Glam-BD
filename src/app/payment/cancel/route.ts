import { connection } from "next/server";

import { handleSslCommerzCancelRoute } from "@/lib/payments/sslcommerz-callback-route";

/**
 * GET /payment/cancel
 *
 * The customer abandoned the payment at the SSLCOMMERZ gateway.
 *
 * ── Why cancel behaves exactly like fail ──────────────────────────────────
 *
 * A cancellation and a decline are the same fact from the shop's point
 * of view: **the money did not move**. There is no payment to reconcile
 * and no order to settle.
 *
 * And the outcome is the same: the order's payment status stays
 * `PENDING`, the stock reservation stays intact, a `PaymentAttempt` row
 * records that the customer reached the gateway and did not pay, and the
 * admin desk is told — because an order sitting at `PENDING` with a
 * declined attempt is something the admin may want to follow up on.
 *
 * The customer is redirected back to the order, where they can open a
 * new gateway session and try again.
 *
 * ── Both `GET` and `POST` ─────────────────────────────────────────────────
 *
 * The browser redirect is normally a `GET`, but the gateway may also
 * `POST` the callback. Both are accepted, and the parameters are read
 * from wherever the gateway put them.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  return handleSslCommerzCancelRoute(request);
}

/**
 * The gateway **posting** the cancellation callback.
 *
 * The handling is identical to the `GET`: an abandoned payment is an
 * abandoned payment whichever way it arrives.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  return handleSslCommerzCancelRoute(request);
}
