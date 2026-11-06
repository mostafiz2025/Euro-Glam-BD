import { connection } from "next/server";

import { handleSslCommerzSuccessRoute } from "@/lib/payments/sslcommerz-callback-route";

/**
 * GET /payment/success
 *
 * The customer returns here after paying at the SSLCOMMERZ gateway.
 *
 * ── What this route does, and what it refuses to do ──────────────────────
 *
 * The gateway redirects the customer's browser here with a query string.
 * That browser is under the customer's control, so **nothing in the
 * query string is believed on its own**.
 *
 * This route:
 *
 *   1. Uses the request only to *find* the order — via the `value_a`
 *      round-trip, the `tran_id` reference, or the recorded session key.
 *
 *   2. Asks SSLCOMMERZ, server-to-server, whether the transaction is
 *      really valid.
 *
 *   3. Checks the amount the gateway recorded against the order's own
 *      total.
 *
 *   4. Only then moves the payment to `PAID`.
 *
 * A customer who edits the URL to `?status=PAID` gets a page that says
 * the payment could not be confirmed — because the gateway was asked,
 * and the gateway said no.
 *
 * ── Why it redirects ──────────────────────────────────────────────────────
 *
 * The customer is looking for their order, so the route sends them to
 * their own order page — the one place that shows the order's **real**
 * payment status, read from the database. The outcome travels along as a
 * message in the query string; the message is for the page to render, and
 * it is never a record. The order row is the record.
 *
 * ── Why it answers 303 ────────────────────────────────────────────────────
 *
 * The callback is a **write** — it settles a payment. A `303 See Other`
 * says "go and `GET` that address", so the redirect cannot be replayed
 * by re-visiting the callback URL.
 *
 * ── The IPN ───────────────────────────────────────────────────────────────
 *
 * The IPN — the gateway's own server-to-server notification — is the
 * path that carries the *authoritative* answer, and it lives at
 * `/payment/ipn`.
 */

/**
 * The browser redirect back from the gateway.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  return handleSslCommerzSuccessRoute(request);
}

/**
 * The gateway **posting** the redirect.
 *
 * Some merchant configurations have SSLCOMMERZ `POST` the success
 * callback instead of navigating the customer's browser to it. The
 * parameters arrive in the body — form-encoded, multipart or JSON — and
 * are read from there.
 *
 * The handling is **identical** to the `GET`, and that is the point: the
 * HTTP method has no bearing on whether the transaction is real. That
 * question is answered by the gateway, server-to-server, and by nothing
 * the customer can type.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  return handleSslCommerzSuccessRoute(request);
}
