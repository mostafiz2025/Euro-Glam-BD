/**
 * Human-readable labels for the payment methods.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The `PaymentMethod` enum holds `COD`, `BKASH`, `NAGAD` and `CARD` —
 * codes, not sentences. Those codes appear in the database, in the API
 * payloads, and in the admin console's filter dropdown, where a raw
 * enum is exactly right.
 *
 * But the **customer** must never see `BKASH`. A shopper who chose
 * bKash should read "bKash" — the name they tapped on — and an order
 * confirmation that says "Payment method: BKASH" reads like a database
 * leaked onto the page.
 *
 * So the labels live here, in one place, rather than being spelled out
 * at each call site. A fourth method added to the enum is one entry
 * away from being named properly.
 *
 * This module is **client-safe**: it imports nothing, and it holds no
 * server-only code, so a client component can use it without pulling
 * anything into the browser bundle.
 */

/**
 * The customer-facing label for a payment method.
 *
 * Unknown values fall back to the raw code rather than to an empty
 * string — a payment method this codebase does not recognise is still
 * worth showing, and an empty label would render a blank row.
 */
export function paymentMethodLabel(method: string): string {
  switch (method) {
    case "COD":
      return "Cash on Delivery";
    case "BKASH":
      return "bKash";
    case "NAGAD":
      return "Nagad";
    case "CARD":
      return "Card Payment";
    default:
      return method;
  }
}

/**
 * Whether a payment method is settled by a mobile-banking transfer.
 *
 * A duplicate of the helper in the validation module, kept here so the
 * *display* layer does not have to import the *validation* layer. The
 * validation module is the authority; this one exists so a presentational
 * component can ask the question without dragging Zod into its import
 * graph.
 */
export function isMobileBanking(method: string): boolean {
  return method === "BKASH" || method === "NAGAD";
}

/**
 * The badge that says **how** a settled payment was made.
 *
 * ── Why this is not just `paymentMethodLabel` ─────────────────────────────
 *
 * The order page has two jobs, and they want different words:
 *
 *   - The **payment summary** says *what the customer chose* — the method
 *     line in the totals block. That is `paymentMethodLabel`: "bKash",
 *     "Nagad", "Card Payment".
 *
 *   - The **paid badge** says *that it is done, and by what*. That is
 *     `paidByLabel`: "Paid by bKash", "Paid by Nagad", "Card Payment".
 *
 * A badge reading only "Paid" tells the customer the money is in but not
 * how they paid — and on an order where they might have paid twice, or
 * through the wrong rail, the *how* is the reassurance. So the badge
 * carries it.
 *
 * The distinction between `BKASH` and `NAGAD` matters here more than
 * anywhere else: these are different mobile financial services, and the
 * customer's own bank statement will name one of them. A badge that said
 * "Paid by mobile banking" would not match the statement.
 *
 * `COD` has no "paid by" form — the money is collected at the door, so
 * the badge says "Paid on delivery" only if the order was somehow
 * marked paid, which it never is. The label is still defined rather
 * than falling through to `undefined`, so the badge can never render
 * "Paid by undefined".
 */
export function paidByLabel(method: string): string {
  switch (method) {
    case "BKASH":
      return "Paid by bKash";
    case "NAGAD":
      return "Paid by Nagad";
    case "CARD":
      return "Card Payment";
    case "COD":
      return "Cash on Delivery";
    default:
      /**
       * An unrecognised method falls back to the raw code — but never to
       * a **blank**. An empty badge is worse than a wrong one: a wrong
       * one is at least something the customer can read and the shop can
       * correct, whereas an empty one just looks broken.
       */
      return method.trim() || "Payment received";
  }
}

/**
 * The **short** form of the paid badge — the word that goes in the
 * pill.
 *
 * The badge has room for "Paid by bKash" on the order page, but the
 * same fact is needed in tighter places — a notification, an admin list
 * row — where "Paid by bKash" does not fit next to the order number.
 *
 * For a card payment there is nothing to add: the customer did not
 * choose a *provider*, they chose a card, so the badge says what it
 * always said.
 */
export function paidByShortLabel(method: string): string {
  switch (method) {
    case "BKASH":
      return "bKash";
    case "NAGAD":
      return "Nagad";
    default:
      return paidByLabel(method);
  }
}

/**
 * A one-line explanation of how a payment method is settled.
 *
 * Used on the order confirmation, where the customer needs to know what
 * happens next — for COD, that the courier will call; for mobile
 * banking, that the shop will verify the transfer.
 *
 * @param method - The payment method.
 * @param settledThroughGateway - Whether the payment was settled by the
 *        gateway. A card order that went through the gateway is **not**
 *        waiting for a human to verify a transfer — the money moved, or
 *        it did not, and the order page says which.
 */
export function paymentMethodNote(
  method: string,
  settledThroughGateway = false,
): string {
  switch (method) {
    case "COD":
      return "Cash on delivery. The courier will call you before delivering.";
    case "BKASH":
      return settledThroughGateway
        ? "Paid by bKash through our secure payment window. Your order is confirmed."
        : "Paid by bKash. We will verify the transfer and confirm your order shortly.";
    case "NAGAD":
      return settledThroughGateway
        ? "Paid by Nagad through our secure payment window. Your order is confirmed."
        : "Paid by Nagad. We will verify the transfer and confirm your order shortly.";
    case "CARD":
      return settledThroughGateway
        ? "Paid by card through our secure payment window. Your order is confirmed."
        : "Paid by card. We will confirm your order shortly.";
    default:
      return "We will confirm your order shortly.";
  }
}
