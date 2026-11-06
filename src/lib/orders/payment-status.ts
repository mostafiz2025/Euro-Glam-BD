import { PaymentStatus } from "@prisma/client";

/**
 * The permitted payment transitions.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The table used to live in `src/lib/admin/orders.ts`, which is the
 * staff-facing fulfilment desk. That was fine when the admin desk was
 * the only thing that moved a payment — but the payment gateway is a
 * **customer** write path, and it needs to know the same rules.
 *
 * The two obvious ways to share the table are both wrong:
 *
 *   • The gateway imports from `src/lib/admin/orders.ts`. That makes
 *     the customer payment path depend on the admin desk — the mirror
 *     image of the mistake the admin module's own doc warns about,
 *     where merging the two "would put an `isAdmin` branch in the
 *     middle of the checkout path".
 *
 *   • The table is copied into a second module. Two definitions of the
 *     same closed set is exactly how a state machine drifts: one copy
 *     gains a transition the other does not, and the two disagree
 *     about what is legal.
 *
 * So the table moves here, into a module that belongs to neither side.
 * The admin desk re-exports it, so its public names — and every
 * existing caller and test — keep working unchanged.
 *
 * This module is **client-safe**: it imports only `@prisma/client`'s
 * enum values, which are plain strings.
 */

/**
 * The permitted payment transitions.
 *
 * Payment moves **independently** of fulfilment:
 *
 *   PENDING → PAID | FAILED | REFUNDED
 *   PAID    → REFUNDED
 *
 * `FAILED` and `REFUNDED` are **terminal**. There is no path out of
 * them, and that is deliberate: a failed payment is a final answer
 * about the money, and a refunded payment is a final answer too. A
 * customer who wants to try again has not failed — they have not
 * finished.
 *
 * The gateway therefore never writes `FAILED`. A *failed attempt* is
 * not a failed *payment*: it leaves the payment at `PENDING` and is
 * recorded as a `PaymentAttempt` row. The only way to reach `FAILED`
 * is the admin's `changePaymentStatus`, which is right — an admin can
 * mark a gateway order's payment failed by hand if the customer gives
 * up, and then cancel the order to release the stock.
 */
export const PAYMENT_STATUS_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  [PaymentStatus.PENDING]: [
    PaymentStatus.PAID,
    PaymentStatus.FAILED,
    PaymentStatus.REFUNDED,
  ],
  [PaymentStatus.PAID]: [PaymentStatus.REFUNDED],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.REFUNDED]: [],
};

/**
 * Returns the payment statuses an order may move to.
 */
export function permittedPaymentTargets(
  current: PaymentStatus,
): readonly PaymentStatus[] {
  return PAYMENT_STATUS_TRANSITIONS[current];
}

/**
 * Returns true when the payment transition is permitted.
 */
export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return PAYMENT_STATUS_TRANSITIONS[from].includes(to);
}
