/**
 * The order-status vocabulary, for the customer.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The `OrderStatus` enum holds `PENDING`, `PROCESSING`, `SHIPPED`,
 * `DELIVERED` and `CANCELLED` — codes, not sentences.
 *
 * The codes are right in the admin console, where a status is one cell in
 * a table and the operator knows what they mean. They are **wrong** on
 * the storefront. A customer who reads "PROCESSING" learns nothing: they
 * do not know whether their parcel is being packed, has been packed, or
 * is waiting for a courier. They read "PENDING" and cannot tell it apart
 * from "unpaid".
 *
 * So the labels live here, in one place, exactly as the payment-method
 * labels live in `src/lib/format/payment.ts`.
 *
 * ── Why the map is exported, not just the functions ───────────────────────
 *
 * The storefront had **three copies** of the same colour map — one in the
 * order detail page, one in the account page, and a third in the admin
 * order table — and they had already begun to drift. Three copies of a
 * map is three places for a colour to be wrong, and a status that is
 * amber on one page and blue on another is a bug the customer reports as
 * "your site says two different things".
 *
 * So the map is exported, and the pages read it. The functions below are
 * the safe way to read it: an unknown status falls back to a neutral
 * tone rather than rendering an unstyled chip.
 *
 * ── Client-safe ───────────────────────────────────────────────────────────
 *
 * This module imports nothing, so a `"use client"` component can use it
 * without pulling the server's validation layer into the browser bundle.
 */

/**
 * The customer-facing label for an order status.
 *
 * The labels are chosen to say **what is happening**, not to name an
 * internal state:
 *
 *   • `PENDING` is "Order placed" — the shop has it, and nothing is
 *     wrong. "Pending" would have implied a queue or a delay.
 *   • `PROCESSING` is "Preparing" — the work is under way.
 *   • `SHIPPED` is "On the way" — the parcel has left the warehouse.
 *   • `DELIVERED` is "Delivered" — the end of the line.
 *   • `CANCELLED` is "Cancelled" — the same word in both directions,
 *     because there is nothing kinder to say.
 */
export const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: "Order placed",
  PROCESSING: "Preparing",
  SHIPPED: "On the way",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

/**
 * A sentence explaining the status to the customer.
 *
 * This is the line that turns a status into an answer. "Preparing" alone
 * is a word; "We are picking and packing your items." is a reassurance.
 */
export const ORDER_STATUS_NOTES: Readonly<Record<string, string>> = {
  PENDING: "We have your order and it is in the queue to be prepared.",
  PROCESSING: "We are picking and packing your items now.",
  SHIPPED: "Your parcel has left us and is on its way to you.",
  DELIVERED: "Your parcel has been delivered.",
  CANCELLED:
    "This order was cancelled. If you were charged, the amount will be returned to you.",
};

/**
 * The pill classes for each status.
 *
 * The colours follow the **fulfilment** axis rather than the payment
 * axis, and they are the same colours the admin console uses for the
 * same states — a shop's operator and its customer should be looking at
 * the same picture of an order.
 */
export const ORDER_STATUS_TONES: Readonly<Record<string, string>> = {
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  PROCESSING: "bg-blue-50 text-blue-700 border-blue-200",
  SHIPPED: "bg-violet-50 text-violet-700 border-violet-200",
  DELIVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  CANCELLED: "bg-surface-muted text-foreground-muted border-border",
};

/**
 * The payment-status pill classes.
 *
 * They live beside the fulfilment tones rather than inside them because
 * they answer a different question: the fulfilment map says what is
 * happening to the **parcel**, and this one says what is happening to the
 * **money**.
 */
export const PAYMENT_STATUS_TONES: Readonly<Record<string, string>> = {
  PENDING: "bg-amber-50 text-amber-700 border-amber-200",
  PAID: "bg-emerald-50 text-emerald-700 border-emerald-200",
  FAILED: "bg-red-50 text-red-700 border-red-200",
  REFUNDED: "bg-surface-muted text-foreground-muted border-border",
};

/**
 * The customer-facing label for a payment status.
 */
export const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: "Awaiting payment",
  PAID: "Paid",
  FAILED: "Payment failed",
  REFUNDED: "Refunded",
};

/**
 * The label for an order status.
 *
 * An unrecognised status falls back to the raw code rather than to an
 * empty string. A status this codebase does not know about is still
 * worth showing, and an empty label would render a blank chip.
 */
export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}

/**
 * The sentence that explains an order status.
 *
 * The fallback is a sentence about the order rather than about the code,
 * so an unknown status still reads as something.
 */
export function orderStatusNote(status: string): string {
  return (
    ORDER_STATUS_NOTES[status] ??
    "We are looking up this order for you."
  );
}

/**
 * The pill classes for an order status.
 *
 * An unknown status gets the **neutral** tone — the cancelled one — so
 * the chip is never unstyled. A chip with no classes at all is a chip
 * with no border and no background, which reads as a rendering fault
 * rather than as a status.
 */
export function orderStatusTone(status: string): string {
  return (
    ORDER_STATUS_TONES[status] ??
    "bg-surface-muted text-foreground-muted border-border"
  );
}

/**
 * The label for a payment status.
 */
export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status;
}

/**
 * The pill classes for a payment status.
 */
export function paymentStatusTone(status: string): string {
  return (
    PAYMENT_STATUS_TONES[status] ??
    "bg-surface-muted text-foreground-muted border-border"
  );
}

/**
 * The steps of the fulfilment journey, in order.
 *
 * A closed list, because the journey is the same for every order: the
 * shop takes it, packs it, sends it, and it arrives. There is no
 * customer-facing step for "awaiting payment" — that is the payment
 * axis, and it is shown separately.
 */
export const ORDER_TIMELINE_STEPS = [
  {
    key: "PENDING",
    label: "Order placed",
    description: "We have your order.",
  },
  {
    key: "PROCESSING",
    label: "Preparing",
    description: "We are picking and packing your items.",
  },
  {
    key: "SHIPPED",
    label: "On the way",
    description: "Your parcel has left our warehouse.",
  },
  {
    key: "DELIVERED",
    label: "Delivered",
    description: "Your parcel has arrived.",
  },
] as const;

/**
 * The index of a status on the timeline.
 *
 * Returns `-1` for a status that is not on the journey — which is
 * `CANCELLED`, and any status this codebase does not know.
 *
 * The caller is expected to check for `-1` rather than to index the array
 * with it. A cancelled order has no place on the journey, and rendering
 * the timeline as if it did would tell the customer their parcel is
 * "on the way" when it was cancelled.
 */
export function orderTimelineIndex(status: string): number {
  return ORDER_TIMELINE_STEPS.findIndex((step) => step.key === status);
}

/**
 * Whether an order was cancelled.
 */
export function isOrderCancelled(status: string): boolean {
  return status === "CANCELLED";
}
