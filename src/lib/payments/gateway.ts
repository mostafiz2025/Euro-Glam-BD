import {
  AdminNotificationKind,
  PaymentAttemptOutcome,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { ORDER_ACTIONS, writeAuditEntry } from "@/lib/admin/audit";
import { createNotification } from "@/lib/admin/notifications";
import type { SessionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { permittedPaymentTargets } from "@/lib/orders/payment-status";

import {
  GATEWAY_MERCHANT_NAME,
  gatewayTransactionId,
  generateGatewaySessionId,
  type GatewaySessionPayload,
} from "./session";

/**
 * The payment gateway.
 *
 * ── Why this is a third module, and not one of the two that exist ────────
 *
 * There are already two order services, and they are separate on purpose:
 *
 *   • `src/lib/orders/service.ts` is the **checkout** — the most careful
 *     file in the codebase, one transaction, one shape.
 *
 *   • `src/lib/admin/orders.ts` is the **staff desk** — every change
 *     audited, transitions enforced, and an `AuditActor` on every write.
 *
 * The gateway is a **customer** write path, and it fits neither:
 *
 *   • It is not the checkout. The checkout places an order; the gateway
 *     settles a payment on an order that already exists. Putting the
 *     settle transaction inside the checkout service would muddy the
 *     most safety-critical file in the shop with a second, differently
 *     shaped transaction.
 *
 *   • It is not the staff desk. `changePaymentStatus` takes an
 *     `AuditActor` (the *staff member's* identity), has **no ownership
 *     check** — it looks the order up by id alone — and includes
 *     `REFUNDED` in its permitted targets. A customer must never be
 *     able to say "refund me", and a customer must never be able to
 *     settle somebody else's order.
 *
 * So this is the third thing: **the gateway**. It is a new domain — the
 * checkout service has no gateway, the staff desk has no customer.
 *
 * ── What the gateway may and may not do ────────────────────────────────────
 *
 * The gateway is a **customer** path, and it is deliberately narrow:
 *
 *   • It may move a payment `PENDING → PAID`, and nothing else.
 *
 *   • It **uses** the shared transition table rather than restating it.
 *     It never writes to the table, so `FAILED` stays terminal and
 *     `tests/admin/order-transitions.test.ts` keeps passing unchanged.
 *
 *   • It never touches the stock. A failed attempt leaves the
 *     reservation intact, because the order is still live — restoring
 *     the stock on a failure and then retrying the same order would
 *     oversell. The reservation is released when the **order** ends.
 */

/**
 * The failure message the simulated gateway returns when a payment is
 * declined.
 *
 * The customer reads this inside the payment window, so it says what
 * happened and what to do next.
 */
export const GATEWAY_DECLINE_MESSAGE =
  "The payment was declined by the gateway. Please try again.";

/**
 * The customer's transfer reference, for a mobile-banking order.
 *
 * ── Why it arrives at the settle and not at the checkout ───────────────────
 *
 * The checkout page holds **only** the payment selection. The customer
 * picks bKash, presses "Place order", and the gateway window opens —
 * and it is in the gateway window, looking at the exact amount they are
 * about to send, that they quote the TrxID from their confirmation
 * screen.
 *
 * So the order is created first — its `paymentMethod` fixed, its stock
 * reserved — and the transfer reference is recorded on it as the payment
 * settles.
 *
 * The order row still ends up carrying a **complete, reconcilable**
 * reference: the shop matches the transfer against the operator's
 * statement by the sender number and the TrxID, exactly as before. Only
 * the *moment* at which the customer is asked for it has moved.
 */
export type GatewayTransferDetails = {
  /** The mobile number the transfer was sent from. */
  readonly paymentSenderNumber: string;
  /** The TrxID from the customer's confirmation screen. */
  readonly paymentTransactionId: string;
};

/**
 * The result of settling a gateway payment.
 */
export type GatewaySettlementResult = {
  /** The order after the attempt. */
  readonly order: {
    readonly orderId: string;
    readonly orderNumber: string;
    /** `PAID` after a successful settle; `PENDING` after a failed one. */
    readonly paymentStatus: PaymentStatus;
    readonly status: string;
    readonly paymentMethod: string;
    readonly totalAmountPaisa: number;
    /** The gateway's reference, once the payment succeeds. */
    readonly transactionId: string | null;
    /** When the payment settled, once it has. */
    readonly paidAt: Date | null;
  };
  /** The attempt that was recorded. */
  readonly attempt: {
    readonly id: string;
    readonly outcome: PaymentAttemptOutcome;
    readonly failureMessage: string | null;
    readonly createdAt: Date;
  };
};

/**
 * Builds the payload the gateway window renders for an order.
 */
function toGatewaySessionPayload(order: {
  id: string;
  orderNumber: string;
  paymentMethod: string;
  totalAmountPaisa: number;
}): GatewaySessionPayload {
  return {
    sessionId: "",
    orderId: order.id,
    orderNumber: order.orderNumber,
    merchantName: GATEWAY_MERCHANT_NAME,
    amountPaisa: order.totalAmountPaisa,
    paymentMethod: order.paymentMethod as GatewaySessionPayload["paymentMethod"],
    transactionId: gatewayTransactionId(order.orderNumber),
  };
}

/**
 * Settles a gateway payment on behalf of the customer who owns the order.
 *
 * ── The three guards ──────────────────────────────────────────────────────
 *
 * All three live in the `where` clause of one conditional `updateMany`,
 * so a losing request matches **zero rows** and is refused without
 * having written anything:
 *
 *   • `userId` — the order must belong to the caller.
 *
 *   • `paymentStatus: PENDING` — only an unresolved payment can be
 *     settled. This is what makes a double-click harmless: the second
 *     request matches zero rows and the customer sees "this session is
 *     no longer valid" rather than a double charge.
 *
 *   • `paymentGatewaySessionId: sessionId` — the one-shot token must
 *     match, and the row must still carry it. A successful settle
 *     nulls the column, so a replayed request matches zero rows too.
 *
 * ── A failed attempt changes nothing ──────────────────────────────────────
 *
 * On `FAILED` the service records the attempt and the audit entry, and
 * **changes nothing else**. The payment stays `PENDING`, the token
 * stays live, and the stock stays reserved — so the customer can retry
 * the same order with one click, and the goods cannot be sold twice.
 *
 * @param user      - The customer. The order MUST belong to them.
 * @param orderId   - The order to settle.
 * @param sessionId - The one-time gateway session token the browser holds.
 * @param outcome   - Whether the (simulated) gateway accepted the payment.
 * @param transfer  - The customer's transfer reference, for a
 *        mobile-banking order. Collected in the gateway window, because
 *        that is where the customer is looking at the amount they are
 *        about to send.
 *
 * @throws ApiError 404 when the order does not exist, or does not belong
 *         to the customer. Both are 404 — the endpoint must not be usable
 *         to discover another customer's orders.
 * @throws ApiError 409 when the session token does not match, or the
 *         payment is no longer PENDING.
 * @throws ApiError 422 when a mobile-banking order settles without a
 *         transfer reference, or a non-mobile-banking order settles with
 *         one.
 */
export async function settleGatewayPayment(
  user: SessionUser,
  orderId: string,
  sessionId: string,
  outcome: PaymentAttemptOutcome,
  transfer?: GatewayTransferDetails,
): Promise<GatewaySettlementResult> {
  const userId = user.id;

  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, userId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          totalAmountPaisa: true,
          paymentGatewaySessionId: true,
        },
      });

      // Scoped by `userId`, so a foreign order is simply not found.
      if (!order) {
        throw ApiError.notFound("That order does not exist.");
      }

      // The token must match, and the payment must still be unresolved.
      //
      // These two checks give the customer a **precise** error instead of
      // a generic refusal: "your session expired, reload your order" is
      // something they can act on.
      if (
        !order.paymentGatewaySessionId ||
        order.paymentGatewaySessionId !== sessionId
      ) {
        throw ApiError.conflict(
          "This payment session is no longer valid. Reload your order and try again.",
        );
      }

      if (order.paymentStatus !== PaymentStatus.PENDING) {
        throw ApiError.conflict(
          "This order's payment has already been settled.",
          {
            currentPaymentStatus: order.paymentStatus,
            permittedPaymentStatuses: permittedPaymentTargets(
              order.paymentStatus,
            ),
          },
        );
      }

      /**
       * The conditional rule, enforced against the **order row**.
       *
       * The method is read from the order, never from the request — the
       * order row is the record (DECISIONS.md #147). That is why this
       * check lives here and not in the schema: the schema has no method
       * to check against, and a client-supplied method would be a
       * second, editable copy of the truth.
       *
       * So:
       *
       *   • A mobile-banking order **must** settle with both a sender
       *     number and a TrxID. An order that settles with neither is
       *     an order the shop cannot reconcile against a merchant
       *     statement.
       *
       *   • A card or cash order **must not** settle with either. A
       *     recorded transfer that does not exist is worse than a missing
       *     one — the admin would look for a payment that was never
       *     made.
       */
      const isMobileBanking =
        order.paymentMethod === PaymentMethod.BKASH ||
        order.paymentMethod === PaymentMethod.NAGAD;

      if (isMobileBanking) {
        if (!transfer?.paymentSenderNumber) {
          throw ApiError.validation(
            "Enter the mobile number you sent the payment from.",
          );
        }

        if (!transfer?.paymentTransactionId) {
          throw ApiError.validation(
            "Enter the transaction ID (TrxID) from your confirmation screen.",
          );
        }
      } else if (transfer?.paymentSenderNumber || transfer?.paymentTransactionId) {
        throw ApiError.validation(
          "A transfer reference only applies to mobile banking payments.",
        );
      }

      // The settlement's outcome. A failure writes no payment status and
      // touches no stock — see the module doc.
      const settled = outcome === PaymentAttemptOutcome.SUCCESS;

      const transactionReference = gatewayTransactionId(order.orderNumber);

      if (settled) {
        const updated = await tx.order.updateMany({
          where: {
            id: orderId,
            userId,
            paymentStatus: PaymentStatus.PENDING,
            paymentGatewaySessionId: sessionId,
          },
          data: {
            paymentStatus: PaymentStatus.PAID,
            // The token is **consumed**. This is what makes it one-shot in
            // the database, not merely in the application logic: a second
            // settle with the same token finds a NULL here and matches
            // zero rows.
            paymentGatewaySessionId: null,
            paymentGatewayTransactionId: transactionReference,
            /**
             * The customer's transfer reference.
             *
             * Recorded **only** for a mobile-banking order, and only
             * when the settle succeeds — the same shape the checkout
             * writes it in. The two columns mean "the TrxID the customer
             * sent the payment from" and are distinct from
             * `paymentGatewayTransactionId`, which is the gateway's own
             * reference. Neither is ever confused for the other.
             *
             * The values are written **only** on a successful settle, so
             * a declined attempt leaves the row exactly as the checkout
             * wrote it.
             */
            ...(isMobileBanking && transfer
              ? {
                  paymentSenderNumber: transfer.paymentSenderNumber,
                  paymentTransactionId: transfer.paymentTransactionId,
                }
              : {}),
          },
        });

        if (updated.count === 0) {
          throw ApiError.conflict(
            "This payment session is no longer valid. Reload your order and try again.",
          );
        }
      }

      const attempt = await tx.paymentAttempt.create({
        data: {
          orderId,
          outcome,
          sessionId,
          failureMessage: settled ? null : GATEWAY_DECLINE_MESSAGE,
        },
        select: {
          id: true,
          outcome: true,
          failureMessage: true,
          createdAt: true,
        },
      });

      /**
       * The audit entry.
       *
       * The actor is the **customer** — `AdminAuditLog.actorId` is a
       * plain foreign key to `User` with no role constraint, so a
       * customer can be an audit actor. The trail therefore reads: the
       * customer settled their own payment through the gateway, which is
       * exactly what happened and is distinct from a staff member
       * confirming a transfer by hand.
       *
       * `writeAuditEntry` takes a transaction client, so the entry
       * commits or rolls back together with the payment change.
       */
      await writeAuditEntry(tx, {
        actor: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
        action: ORDER_ACTIONS.gatewaySettled,
        entityType: "order",
        entityId: orderId,
        before: { paymentStatus: order.paymentStatus },
        after: settled
          ? { paymentStatus: PaymentStatus.PAID }
          : { paymentStatus: PaymentStatus.PENDING, outcome },
        reason: settled
          ? "Settled through the sandbox payment gateway."
          : GATEWAY_DECLINE_MESSAGE,
      });

      /**
       * The notification.
       *
       * Written in the same transaction as the settlement, for the same
       * reason the checkout writes one for the order: the admin desk
       * learns about the money moving at the moment it moves.
       *
       * A **failure** is announced as well as a success. A declined
       * payment is exactly the thing the admin must act on fastest — it
       * is the difference between an order that needs a retry and an
       * order that looks settled when it is not.
       *
       * The customer's name comes from the session, because the gateway
       * settles on behalf of the order's own customer and the session
       * is the authenticated identity of that customer.
       */
      await createNotification(tx, {
        kind: settled
          ? AdminNotificationKind.PAYMENT_SETTLED
          : AdminNotificationKind.PAYMENT_FAILED,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: user.name,
        totalAmountPaisa: order.totalAmountPaisa,
        paymentMethod: order.paymentMethod,
      });

      const after = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          totalAmountPaisa: true,
          paymentGatewayTransactionId: true,
          updatedAt: true,
        },
      });

      if (!after) {
        throw ApiError.notFound("That order does not exist.");
      }

      return {
        order: {
          orderId: after.id,
          orderNumber: after.orderNumber,
          paymentStatus: after.paymentStatus,
          status: after.status,
          paymentMethod: after.paymentMethod,
          totalAmountPaisa: after.totalAmountPaisa,
          transactionId: after.paymentGatewayTransactionId,
          paidAt: settled ? after.updatedAt : null,
        },
        attempt: {
          id: attempt.id,
          outcome: attempt.outcome,
          failureMessage: attempt.failureMessage,
          createdAt: attempt.createdAt,
        },
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Opens (or re-arms) a gateway session for an order whose payment is
 * still unresolved.
 *
 * This is the "customer closed the tab mid-payment" path. It rotates the
 * token to a fresh one and returns the payload the window renders.
 *
 * It is refused unless the payment is `PENDING` — a settled order has no
 * gateway window to open, and a `FAILED` one is terminal.
 *
 * @throws ApiError 404 when the order does not exist, or does not belong
 *         to the customer.
 * @throws ApiError 409 when the payment is no longer PENDING.
 */
export async function openGatewaySession(
  user: SessionUser,
  orderId: string,
): Promise<GatewaySessionPayload> {
  const userId = user.id;

  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, userId },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          totalAmountPaisa: true,
        },
      });

      if (!order) {
        throw ApiError.notFound("That order does not exist.");
      }

      if (order.paymentStatus !== PaymentStatus.PENDING) {
        throw ApiError.conflict(
          "This order's payment has already been settled.",
          {
            currentPaymentStatus: order.paymentStatus,
            permittedPaymentStatuses: permittedPaymentTargets(
              order.paymentStatus,
            ),
          },
        );
      }

      const sessionId = generateGatewaySessionId();

      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          userId,
          paymentStatus: PaymentStatus.PENDING,
        },
        data: { paymentGatewaySessionId: sessionId },
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "That order was changed by someone else. Reload and try again.",
        );
      }

      return {
        ...toGatewaySessionPayload(order),
        sessionId,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * The session payload for an order that has just been placed.
 *
 * Used by the checkout path, where the session was created **inside**
 * the order transaction — the session is part of the order's creation,
 * and a session created outside the transaction could exist for an order
 * that rolled back.
 */
export function gatewaySessionForNewOrder(order: {
  id: string;
  orderNumber: string;
  paymentMethod: string;
  totalAmountPaisa: number;
  sessionId: string;
}): GatewaySessionPayload {
  return {
    ...toGatewaySessionPayload(order),
    sessionId: order.sessionId,
  };
}
