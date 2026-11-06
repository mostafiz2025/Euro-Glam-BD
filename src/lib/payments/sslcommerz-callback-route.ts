import {
  handleSslCommerzFailure,
  handleSslCommerzSuccess,
  type SslCommerzCallbackParams,
  type SslCommerzCallbackResult,
} from "@/lib/payments/sslcommerz-callback";
import { readSslCommerzParams } from "@/lib/payments/sslcommerz-params";

/**
 * The SSLCOMMERZ browser-callback routes.
 *
 * ── What this module is ───────────────────────────────────────────────────
 *
 * The success, failure and cancellation routes are the **same route**
 * with three different outcomes. Each one:
 *
 *   1. Reads the gateway's parameters from wherever the gateway put them
 *      — the query string for a browser navigation, a form body for a
 *      server-to-server `POST`.
 *
 *   2. Hands them to the callback handler, which asks SSLCOMMERZ
 *      server-to-server whether the transaction is real. Nothing in the
 *      request is believed on its own.
 *
 *   3. Redirects the customer to their own order page, which shows the
 *      order's **real** payment status, read from the database.
 *
 * The three routes differ in exactly two things: which handler they
 * call, and which word they put in the `payment` query parameter of the
 * redirect. So the shape of the route — the reading, the handling, the
 * redirect — lives here, and each route file is the two differences and
 * nothing else.
 *
 * ── Why the redirect, and not a rendered page ──────────────────────────────
 *
 * The callback is a **browser navigation**. The customer wants to land on
 * their order. The order page is the one place that shows the order's
 * real payment status, read from the database — so the redirect goes
 * there, and the outcome is passed along as a *message* in the query
 * string. The message is for the page to render; it is never a record.
 * The order row is the record.
 *
 * ── Why both `GET` and `POST` ─────────────────────────────────────────────
 *
 * The gateway's browser redirect is normally a `GET`. But a merchant
 * configuration can have the gateway **POST** the redirect instead of
 * navigating to it, and the IPN has been shipped as both over the
 * gateway's lifetime. Rather than guess which shape is coming, every
 * route accepts both and reads the parameters from wherever they are.
 *
 * The handling is **identical** either way, and that is the point: the
 * method of the request has no bearing on whether the transaction is
 * real. That question is answered by the gateway, server-to-server.
 */

/**
 * The outcome a route reports to the order page.
 */
export type SslCommerzCallbackOutcome =
  /** The payment was confirmed by the gateway. */
  | "confirmed"
  /** The gateway could not confirm the payment — yet. */
  | "unconfirmed"
  /** The payment was declined. */
  | "failed"
  /** The customer abandoned the payment. */
  | "cancelled";

/**
 * Handles a callback and redirects the customer to their order.
 *
 * @param request  - The incoming request.
 * @param outcome  - How the outcome word is derived from the handler's
 *                   result. A success callback can come back
 *                   **unverified** — the gateway could not be asked, or
 *                   said no — and the customer must be told *that*, not
 *                   that the payment was confirmed.
 *
 *                   Returning `null` means **say nothing**: the redirect
 *                   carries no outcome word at all, and the order page
 *                   renders from the database alone.
 * @param handle   - The handler that settles (or does not settle) the
 *                   payment.
 */
export async function handleSslCommerzCallbackRoute(
  request: Request,
  outcome: (
    result: SslCommerzCallbackResult,
  ) => SslCommerzCallbackOutcome | null,
  handle: (
    params: SslCommerzCallbackParams,
  ) => Promise<SslCommerzCallbackResult>,
): Promise<Response> {
  const url = new URL(request.url);

  const params = await readSslCommerzParams(request);

  const result = await handle(params);

  /**
   * The page the customer is shown.
   *
   * The customer's own **order page** — the one place that shows the
   * order's real payment status, read from the database. If the order
   * could not be identified at all, the customer is sent to their
   * account page, where their order list is — because there is no
   * order page to send them to.
   */
  const destination = result.orderId
    ? new URL(`/orders/${result.orderId}`, url.origin)
    : new URL("/account", url.origin);

  const word = outcome(result);

  /**
   * The outcome word is **optional**.
   *
   * It is only added when there is something to say that the order page
   * cannot read from the database itself. A settled payment adds
   * nothing: the row says `PAID`, the page renders a green "Payment
   * confirmed" badge from that row, and a query string saying the same
   * thing would be a second source of truth that can disagree with the
   * first.
   *
   * So a clean success redirects to a **clean URL** — `/orders/<id>` with
   * no query string at all. And an unconfirmed payment adds the word
   * because the database says `PENDING`, which on its own would read as
   * "nothing happened yet" rather than "we have not been able to ask
   * the gateway yet".
   */
  if (word) {
    destination.searchParams.set("payment", word);
  }

  if (result.message) {
    destination.searchParams.set("note", result.message.slice(0, 300));
  }

  /**
   * `303 See Other`.
   *
   * The callback is a **write** — it settles a payment — so the
   * redirect must not be re-issued by a `GET` on the redirected URL. A
   * `303` says "go and `GET` that address", which is exactly right, and
   * it means a refresh of the order page cannot replay the callback.
   *
   * The callback handler is idempotent anyway — a replayed callback
   * matches zero rows and changes nothing — but the redirect should not
   * depend on that.
   */
  return Response.redirect(destination, 303);
}

/**
 * Handles a **success** callback.
 *
 * The outcome word follows the handler's **settlement**, not its
 * verification. A payment that settled redirects to a **clean** URL — no
 * `payment` parameter at all — because the order row now says `PAID` and
 * the page renders from that row.
 *
 * The two are not the same thing, and the difference matters in exactly
 * one case: the sandbox fallback, where the shop settles a test order
 * the gateway could not vouch for. That order *is* paid, so it must not
 * come back with a warning banner — but it was never verified, and the
 * audit trail says so. Keying the redirect on settlement keeps the
 * customer looking at the truth (the row), and keying the audit on
 * verification keeps the record honest.
 *
 * A payment that did **not** settle — because the gateway said no, or
 * because it could not be reached — is `unconfirmed`. That distinction
 * is the whole point of the route. Telling a customer their payment is
 * confirmed when it is not would be a lie the customer acts on; telling
 * them it is unconfirmed when it is not would send them to their order
 * page to pay a second time for an order already settled. The **order
 * row** is the record of what happened, and this word is a message that
 * points at it.
 */
export async function handleSslCommerzSuccessRoute(
  request: Request,
): Promise<Response> {
  return handleSslCommerzCallbackRoute(
    request,
    (result) => (result.settled ? null : "unconfirmed"),
    handleSslCommerzSuccess,
  );
}

/**
 * Handles a **failure** callback.
 */
export async function handleSslCommerzFailureRoute(
  request: Request,
): Promise<Response> {
  return handleSslCommerzCallbackRoute(
    request,
    () => "failed",
    handleSslCommerzFailure,
  );
}

/**
 * Handles a **cancellation** callback.
 *
 * A cancellation and a decline are the same fact from the shop's point
 * of view: **the money did not move**. So the handling is identical; only
 * the word on the order page differs.
 */
export async function handleSslCommerzCancelRoute(
  request: Request): Promise<Response> {
  return handleSslCommerzCallbackRoute(
    request,
    () => "cancelled",
    handleSslCommerzFailure,
  );
}
