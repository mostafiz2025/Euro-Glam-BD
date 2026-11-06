import type { PaymentStatus } from "@prisma/client";

/**
 * The order page's payment banner.
 *
 * ── Why this lives in its own module ─────────────────────────────────────
 *
 * Because it is **the** place where two sources of truth meet, and the
 * meeting has to be right.
 *
 * There are two ways this page can learn that a payment happened:
 *
 *   1. The **database row** — `order.paymentStatus`. This is the
 *      shop's record. It is written only after the gateway has been
 *      asked server-to-server and has said yes.
 *
 *   2. The **query string** — `?payment=unconfirmed`. This is the
 *      callback's way of leaving a note for the customer. It travels
 *      through the customer's browser and can be edited by hand.
 *
 * The bug this module exists to prevent: the query string won. A
 * customer who came back from the gateway, then refreshed, then came
 * back later with a stale `?payment=unconfirmed` in the URL, saw an
 * amber "we could not confirm the payment yet" banner on an order the
 * shop had **already been paid for**. That banner is not merely ugly —
 * it invites the customer to pay a second time.
 *
 * So the rule is simple and absolute: **the row decides**. The query
 * string may only *add* a banner for the one case the row cannot
 * express on its own — a payment the shop has not been able to confirm
 * with the gateway yet.
 *
 * The logic is extracted here, rather than living inline in the page
 * component, so it can be **tested**. The bug it fixes was a rendering
 * decision, and a rendering decision with no test is a rendering
 * decision that comes back.
 */

/**
 * The outcome a callback reported.
 */
export type PaymentOutcome =
  | "confirmed"
  | "unconfirmed"
  | "failed"
  | "cancelled";

/**
 * The banner to render.
 */
export type PaymentBannerState = {
  /** Which banner it is. */
  readonly outcome: PaymentOutcome;
  /** The callback's note, when it has one to add. */
  readonly note: string | null;
};

/**
 * Reads the outcome out of the query string.
 *
 * The value is **not** trusted — it selects which banner to render, and
 * nothing more. An unknown value renders no banner at all, which is the
 * safe default: a hand-typed query string cannot put a green "Payment
 * confirmed" banner on a page for an unpaid order.
 */
export function readPaymentOutcome(
  value: string | string[] | undefined,
): PaymentOutcome | null {
  if (typeof value !== "string") return null;

  switch (value) {
    case "confirmed":
      return "confirmed";
    case "unconfirmed":
      return "unconfirmed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Reads the note out of the query string.
 *
 * Bounded, because it came from a URL — and rendered as plain text, so
 * it is escaped by React and cannot inject markup.
 */
export function readPaymentNote(
  value: string | string[] | undefined,
): string | null {
  if (typeof value !== "string") return null;

  const note = value.trim();

  if (!note) return null;

  return note.slice(0, 300);
}

/**
 * Decides which banner the order page shows.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 *   • **Paid** → `confirmed`, always, with no note.
 *
 *     The row says the money is in. Nothing else gets a vote. A stale
 *     `unconfirmed` in the URL cannot put a warning on a settled order,
 *     and a hand-typed `confirmed` cannot put a green banner on an
 *     unpaid one — that is the other half of the same rule, enforced by
 *     the fact that an unpaid order with no callback outcome shows *no*
 *     banner rather than a default one.
 *
 *   • **Not paid, with a callback outcome** → that outcome, with its
 *     note.
 *
 *     This is the case the row cannot express on its own. `PENDING` does
 *     not distinguish "the customer abandoned the payment" from "we
 *     could not reach the gateway to ask", and the customer needs to
 *     know which one it is.
 *
 *   • **Not paid, with no callback outcome** → no banner.
 *
 *     The status pill carries the truth instead.
 *
 * @param paymentStatus - The order's payment status, from the database.
 * @param outcome      - The outcome the callback reported, if any.
 * @param note         - The callback's note, if any.
 */
export function resolvePaymentBanner({
  paymentStatus,
  outcome,
  note,
}: {
  readonly paymentStatus: PaymentStatus;
  readonly outcome: PaymentOutcome | null;
  readonly note: string | null;
}): PaymentBannerState | null {
  if (paymentStatus === "PAID") {
    return { outcome: "confirmed", note: null };
  }

  if (!outcome) {
    return null;
  }

  return { outcome, note };
}

/**
 * Whether the "Pay now" button should be offered.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 *
 * The button is a way back into the gateway for an order that has not
 * been paid. It is offered when **all** of these hold:
 *
 *   • The payment is still `PENDING`.
 *   • The order settles through the gateway — a cash-on-delivery order
 *     has nothing to pay for now.
 *
 * A **paid** order never gets the button, whatever the URL says.
 * Offering "Pay now" on an order the shop has already been paid for is
 * the one thing on this page that could cost a customer real money
 * twice.
 */
export function shouldOfferPayNow({
  paymentStatus,
  paymentMethod,
}: {
  readonly paymentStatus: PaymentStatus;
  readonly paymentMethod: string;
}): boolean {
  return paymentStatus === "PENDING" && paymentMethod !== "COD";
}
