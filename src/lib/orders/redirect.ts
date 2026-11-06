/**
 * Where the checkout form sends the customer after an order is placed.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The checkout form used to read `order.id` from the API response, but
 * `placeOrder` returns **`orderId`**. There is no `id` on the response, so
 * the field was always `undefined`, the redirect fell through to
 * `/account`, and every customer who placed an order was sent to their
 * order *list* instead of their order *page*.
 *
 * The order was placed correctly — only the redirect was wrong — which is
 * why no test caught it. The API's tests assert the **database**, and the
 * redirect is a client concern.
 *
 * So the redirect is now **computed here**, from the same field names the
 * service returns, and it is unit-tested against those names. The two
 * sides cannot drift, because the form does not spell the field out at
 * all.
 *
 * This module is **client-safe**: it imports nothing.
 */

/**
 * The shape of the order the checkout endpoint returns.
 *
 * Deliberately narrow — only the two fields the redirect needs. The
 * endpoint returns more; this is the part the redirect depends on.
 */
export type CheckoutOrderResponse = {
  /** The order's id. `placeOrder` names it `orderId`, not `id`. */
  readonly orderId?: string;
  /** The order's human-readable number, e.g. `EGB-20261029-A1B2C3`. */
  readonly orderNumber?: string;
};

/**
 * The page the customer lands on after placing an order.
 *
 * The order page when the response carries an id, and the account page
 * otherwise. The fallback is deliberate: an order that *was* placed must
 * not be reported as a failure, so the customer lands somewhere that
 * shows their orders rather than back on an empty checkout.
 */
export function orderConfirmationPath(
  order: CheckoutOrderResponse | undefined,
): string {
  const orderId = order?.orderId;

  if (!orderId) {
    return "/account";
  }

  const reference = order?.orderNumber;

  return reference
    ? `/orders/${orderId}?ref=${encodeURIComponent(reference)}`
    : `/orders/${orderId}`;
}
