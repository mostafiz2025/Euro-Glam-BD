import { connection } from "next/server";
import { z } from "zod";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { openSslCommerzSession } from "@/lib/payments/sslcommerz";
import { entityIdSchema } from "@/lib/validation/commerce";

/**
 * The body for opening a gateway session.
 *
 * One field. The id rules are the shared ones — the same `entityIdSchema`
 * every other route uses for a cuid-style id.
 */
const paymentInitSchema = z.object({
  orderId: entityIdSchema,
});

/**
 * POST /api/payment/init
 *
 * Opens an SSLCOMMERZ session for an order and returns the URL the
 * customer is redirected to.
 *
 * Body:
 * ```json
 * {
 *   "orderId": "clx0000000000000000000000"
 * }
 * ```
 *
 * ── What this endpoint is ────────────────────────────────────────────────
 *
 * The order is already placed and its stock reserved; this is the call
 * that puts the customer in front of the gateway's payment page. The
 * gateway is a third-party site, so the customer leaves the shop and
 * comes back — which is why the flow has a *callback* half (see
 * `/payment/success`, `/payment/fail`, `/payment/cancel` and
 * `/payment/ipn`).
 *
 * ── The body carries no amount ────────────────────────────────────────────
 *
 * The body names an **order id** and nothing else. The amount the
 * gateway is asked to charge is read from the order row on the server.
 * A client-supplied amount would be a vulnerability, not a convenience:
 * it would be a number the customer could edit to pay a different
 * total than the one their order is worth.
 *
 * ── The order must belong to the caller ───────────────────────────────────
 *
 * The order is looked up by id **and** by owner, so an order id that
 * belongs to somebody else is simply not found. The customer cannot
 * open a gateway session on somebody else's order, and the endpoint
 * cannot be used to discover whether an order exists.
 *
 * ── The response ──────────────────────────────────────────────────────────
 *
 * ```json
 * {
 *   "ok": true,
 *   "data": {
 *     "orderId": "clx0000000000000000000000",
 *     "orderNumber": "EGB-20261030-A1B2C3",
 *     "gatewayPageUrl": "https://sandbox.sslcommerz.com/EasyCheckOut/testcde...",
 *     "sessionKey": "...",
 *     "tranId": "EGB-20261030-A1B2C3",
 *     "amountTaka": 2400
 *   }
 * }
 * ```
 *
 * The client redirects to `gatewayPageUrl`. It is a **server-supplied
 * URL** — the client never composes it — so a tampered client cannot
 * point the customer at somebody else's checkout page.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie, reads
  // the database, and calls the gateway.
  await connection();

  try {
    const user = await requireCustomer();

    const body = paymentInitSchema.parse(await request.json());

    const session = await openSslCommerzSession(user.id, body.orderId);

    return ok(session);
  } catch (error) {
    return handleApiError(error);
  }
}
