import { connection } from "next/server";

import { handleSslCommerzFailureRoute } from "@/lib/payments/sslcommerz-callback-route";

/**
 * GET /payment/fail
 *
 * The customer returns here after the SSLCOMMERZ gateway declined the
 * payment.
 *
 * ── What happens to the order ─────────────────────────────────────────────
 *
 * The order's `paymentStatus` is **not** moved to `FAILED`.
 *
 * `FAILED` is terminal in the shop's transition table, and a declined
 * attempt is not a failed *payment* — it is a failed *attempt*. The
 * customer may try again with a different card or a different bank, and
 * the order and its stock reservation stay live so that they can.
 *
 * What *is* written is a `PaymentAttempt` row, so the order's history
 * shows that a payment was attempted and declined, and the admin desk
 * is notified — a declined payment is exactly the thing the admin needs
 * to act on fastest.
 *
 * The customer is redirected back to the order with a note explaining
 * what happened and that they can try again.
 *
 * ── Both `GET` and `POST` ─────────────────────────────────────────────────
 *
 * The browser redirect is normally a `GET`, but the gateway may also
 * `POST` the callback. Both are accepted, and the parameters are read
 * from wherever the gateway put them.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  return handleSslCommerzFailureRoute(request);
}

/**
 * The gateway **posting** the failure callback.
 *
 * The handling is identical to the `GET`: a decline is a decline
 * whichever way it arrives.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  return handleSslCommerzFailureRoute(request);
}
