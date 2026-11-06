import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import type { SessionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { permittedPaymentTargets } from "@/lib/orders/payment-status";
import type {
  AdminOrderQuery,
  OrderStatusTarget,
  PaymentStatusTarget,
} from "@/lib/validation/admin";

import {
  ORDER_ACTIONS,
  toAuditActor,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin order service.
 *
 * ── Separate from the customer order service, on purpose ───────────────
 *
 * `src/lib/orders/service.ts` is the customer-facing checkout. This module
 * is the staff-facing fulfilment desk. They are deliberately separate
 * files rather than one service with a flag:
 *
 *   • different authorisation (an admin may see any order; a customer
 *     may see only their own),
 *   • different obligations (every change here must be audited),
 *   • different invariants (an admin can move an order forward; a
 *     customer cannot move an order at all).
 *
 * Merging them would put an `isAdmin` branch in the middle of the
 * checkout path — the most safety-critical code in the shop.
 *
 * ── The transition tables ──────────────────────────────────────────────
 *
 * Fulfilment moves **forward only**:
 *
 *   PENDING    → PROCESSING, CANCELLED
 *   PROCESSING → SHIPPED, CANCELLED
 *   SHIPPED    → DELIVERED
 *   DELIVERED  → (terminal)
 *   CANCELLED  → (terminal)
 *
 * `SHIPPED → CANCELLED` is deliberately **absent**. The goods have left
 * the warehouse; a cancellation would be a lie, and the refund is a
 * separate operation with its own audit trail.
 *
 * Payment moves **independently**:
 *
 *   PENDING → PAID | FAILED | REFUNDED
 *   PAID    → REFUNDED
 *
 * A COD order can be `SHIPPED` while the payment is still `PENDING`,
 * because the cash is collected on delivery. The two axes have separate
 * audit actions for exactly this reason.
 */

/**
 * The permitted fulfilment transitions.
 *
 * A closed table, exported so the unit tests can assert on it directly.
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
};

/**
 * The permitted payment transitions.
 *
 * The table itself lives in `@/lib/orders/payment-status`, because the
 * payment **gateway** — a customer write path — has to read the same
 * rules, and it must not have to import the admin desk to do it. The
 * admin desk re-exports it here so its public names, and every
 * existing caller and test, keep working unchanged.
 */
export {
  PAYMENT_STATUS_TRANSITIONS,
  permittedPaymentTargets,
  canTransitionPayment,
} from "@/lib/orders/payment-status";

/**
 * The statuses an order may be cancelled from.
 *
 * Derived from the transition table rather than written out separately —
 * two lists that could drift apart would be a bug waiting to happen.
 */
export const CANCELLABLE_FROM: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PROCESSING,
];

/**
 * Returns the statuses an order may move to from its current status.
 */
export function permittedOrderTargets(
  current: OrderStatus,
): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[current];
}

/**
 * Returns true when the transition is permitted.
 */
export function canTransitionOrder(
  from: OrderStatus,
  to: OrderStatus,
): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The order shape returned by the admin list endpoint.
 */
export type AdminOrderSummary = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  subtotalPaisa: number;
  totalAmountPaisa: number;
  shippingAmountPaisa: number;
  discountAmountPaisa: number;
  /**
   * The coupon's discount alone, in poisha.
   *
   * Kept apart from `discountAmountPaisa` — which is the *total* — so
   * the admin panel can show which campaign an order came from.
   */
  couponDiscountPaisa: number;
  /**
   * The coupon code that was redeemed, or `null`.
   */
  couponCode: string | null;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
  customer: { id: string; name: string; email: string; phone: string | null };
};

/**
 * The Prisma select for an admin order summary.
 */
const ADMIN_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  subtotalPaisa: true,
  totalAmountPaisa: true,
  shippingAmountPaisa: true,
  discountAmountPaisa: true,
  couponDiscountPaisa: true,
  couponCode: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
  user: { select: { id: true, name: true, email: true, phone: true } },
} satisfies Prisma.OrderSelect;

/**
 * The order shape returned by the admin detail endpoint.
 */
export type AdminOrderDetail = AdminOrderSummary & {
  shippingAddress: unknown;
  /**
   * The transaction reference the customer quoted, for a mobile-banking
   * order. `null` for `COD` and `CARD`.
   */
  paymentTransactionId: string | null;
  /**
   * The number the transfer was sent from, in the local `01XXXXXXXXX`
   * form. `null` for `COD` and `CARD`.
   */
  paymentSenderNumber: string | null;
  items: {
    id: string;
    productId: string;
    productName: string;
    pricePaisa: number;
    quantity: number;
    estimatedEmptyAt: Date | null;
    reminderSentAt: Date | null;
  }[];
};

/**
 * The Prisma select for an admin order detail.
 */
const ADMIN_ORDER_DETAIL_SELECT = {
  ...ADMIN_ORDER_SELECT,
  shippingAddress: true,
  paymentTransactionId: true,
  paymentSenderNumber: true,
  items: {
    select: {
      id: true,
      productId: true,
      productName: true,
      pricePaisa: true,
      quantity: true,
      estimatedEmptyAt: true,
      reminderSentAt: true,
    },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.OrderSelect;

/**
 * Projects an order row onto the summary shape.
 *
 * The `itemCount` is the number of **lines**, not the number of units.
 * The full quantity total is available on the detail endpoint.
 */
function toOrderSummary(
  row: Prisma.OrderGetPayload<{ select: typeof ADMIN_ORDER_SELECT }>,
): AdminOrderSummary {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    subtotalPaisa: row.subtotalPaisa,
    totalAmountPaisa: row.totalAmountPaisa,
    shippingAmountPaisa: row.shippingAmountPaisa,
    discountAmountPaisa: row.discountAmountPaisa,
    couponDiscountPaisa: row.couponDiscountPaisa,
    couponCode: row.couponCode,
    itemCount: row._count.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    customer: row.user,
  };
}

/**
 * Builds the `where` clause for an admin order query.
 */
function buildOrderWhere(
  query: AdminOrderQuery,
): Prisma.OrderWhereInput {
  const conditions: Prisma.OrderWhereInput[] = [];

  if (query.status) {
    conditions.push({ status: query.status });
  }

  if (query.paymentStatus) {
    conditions.push({ paymentStatus: query.paymentStatus });
  }

  if (query.paymentMethod) {
    conditions.push({ paymentMethod: query.paymentMethod });
  }

  if (query.userId) {
    conditions.push({ userId: query.userId });
  }

  if (query.search) {
    // The search term is trimmed and bounded by the validation schema.
    // Prisma parameterises it, so there is no injection risk — but `%`
    // and `_` are SQL wildcards inside `contains`, so they are escaped to
    // match literally, the way a person typing them expects.
    const term = query.search.replace(/([%_\\])/g, "\\$1");

    conditions.push({
      OR: [
        { orderNumber: { contains: term, mode: "insensitive" } },
        { user: { name: { contains: term, mode: "insensitive" } } },
        { user: { email: { contains: term, mode: "insensitive" } } },
      ],
    });
  }

  return conditions.length > 0 ? { AND: conditions } : {};
}

/**
 * The sort orders the admin may ask for.
 *
 * ── Why this is a closed table, and not a free-text `sort` ──────────────
 *
 * A `sort` parameter that took an arbitrary column name would let a
 * client ask the database to order by a column the admin desk never
 * intended to expose — and it would turn a typo into a silent fallback
 * rather than an error, which is the same failure mode the filter rules
 * exist to prevent.
 *
 * So the sort is a **named order**, and each name maps to an explicit
 * Prisma `orderBy`. The mapping is total: every valid name has an
 * entry, and the fallback covers the case where the name is absent
 * (newest first) rather than the case where it is unrecognised — the
 * validation schema has already refused that.
 */
const ORDER_SORTS: Record<
  NonNullable<AdminOrderQuery["sort"]>,
  Prisma.OrderOrderByWithRelationInput[]
> = {
  newest: [{ createdAt: "desc" }],
  oldest: [{ createdAt: "asc" }],
  highest: [{ totalAmountPaisa: "desc" }, { createdAt: "desc" }],
  lowest: [{ totalAmountPaisa: "asc" }, { createdAt: "desc" }],
};

/**
 * Builds the `orderBy` clause for an admin order query.
 *
 * The tie-breaker on the amount sorts matters: two orders with the same
 * total would otherwise come back in an arbitrary order, and the page
 * boundary would shuffle them between requests — so the same order
 * could appear on two pages at once.
 */
function buildOrderBy(
  sort: AdminOrderQuery["sort"],
): Prisma.OrderOrderByWithRelationInput[] {
  return ORDER_SORTS[sort ?? "newest"];
}

/**
 * The result of an admin order list query.
 */
export type AdminOrderListResult = {
  orders: AdminOrderSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  /**
   * The order counts, by fulfilment status and by payment status.
   *
   * Computed over the **whole** order table, not the filtered page, so
   * an admin can see "14 pending" and navigate to them even while
   * looking at a filtered list.
   */
  counts: {
    byStatus: Record<OrderStatus, number>;
    byPaymentStatus: Record<PaymentStatus, number>;
    /**
     * The order counts, by payment method.
     *
     * Like the other two count maps, this is computed over the **whole**
     * order table rather than the filtered page — so the filter dropdown
     * can say "23 bKash orders" while the admin is looking at a list
     * filtered down to four of them.
     */
    byPaymentMethod: Record<PaymentMethod, number>;
    total: number;
  };
};

/**
 * Lists orders for the admin fulfilment desk.
 */
export async function listAdminOrders(
  query: AdminOrderQuery,
): Promise<AdminOrderListResult> {
  const where = buildOrderWhere(query);
  const skip = (query.page - 1) * query.limit;

  const [
    rows,
    total,
    statusCounts,
    paymentCounts,
    methodCounts,
    allTotal,
  ] = await Promise.all([
    db.order.findMany({
      where,
      select: ADMIN_ORDER_SELECT,
      orderBy: buildOrderBy(query.sort),
      skip,
      take: query.limit,
    }),
    db.order.count({ where }),
    db.order.groupBy({ by: ["status"], _count: { _all: true } }),
    db.order.groupBy({ by: ["paymentStatus"], _count: { _all: true } }),
    db.order.groupBy({ by: ["paymentMethod"], _count: { _all: true } }),
    db.order.count(),
  ]);

  const byStatus = Object.fromEntries(
    Object.values(OrderStatus).map((status) => [status, 0]),
  ) as Record<OrderStatus, number>;

  for (const entry of statusCounts) {
    byStatus[entry.status] = entry._count._all;
  }

  const byPaymentStatus = Object.fromEntries(
    Object.values(PaymentStatus).map((status) => [status, 0]),
  ) as Record<PaymentStatus, number>;

  for (const entry of paymentCounts) {
    byPaymentStatus[entry.paymentStatus] = entry._count._all;
  }

  const byPaymentMethod = Object.fromEntries(
    Object.values(PaymentMethod).map((method) => [method, 0]),
  ) as Record<PaymentMethod, number>;

  for (const entry of methodCounts) {
    byPaymentMethod[entry.paymentMethod] = entry._count._all;
  }

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    orders: rows.map(toOrderSummary),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    counts: { byStatus, byPaymentStatus, byPaymentMethod, total: allTotal },
  };
}

/**
 * Loads one order, in full, for the admin detail view.
 *
 * @throws ApiError 404 when the order does not exist.
 */
export async function getAdminOrder(
  orderId: string,
): Promise<AdminOrderDetail> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: ADMIN_ORDER_DETAIL_SELECT,
  });

  if (!order) {
    throw ApiError.notFound("That order does not exist.");
  }

  return {
    ...toOrderSummary(order),
    shippingAddress: order.shippingAddress,
    paymentTransactionId: order.paymentTransactionId,
    paymentSenderNumber: order.paymentSenderNumber,
    items: order.items,
  };
}

/**
 * Changes an order's fulfilment status.
 *
 * ── What happens here ──────────────────────────────────────────────────
 *
 *   1. The order is read, to learn its current status.
 *   2. The transition is checked against the closed table. An illegal
 *      transition is a 409 that names the current status and the
 *      permitted targets.
 *   3. The status is updated with a **conditional** `updateMany` on the
 *      current status. Two admins moving the same order race here, and
 *      exactly one wins — the loser gets a 409 rather than overwriting
 *      the winner.
 *   4. If the new status is `CANCELLED`, the reserved stock is
 *      restored.
 *   5. The audit entry is written.
 *
 * Steps 1–5 share **one transaction**. The stock restoration and the
 * status change are atomic: an order cannot be cancelled without the
 * stock coming back, and the stock cannot come back without the order
 * being cancelled.
 *
 * @param actor   - The admin doing the change.
 * @param orderId - The order to move.
 * @param target  - The status to move it to.
 * @param reason  - An optional note for the audit entry.
 *
 * @throws ApiError 404 when the order does not exist.
 * @throws ApiError 409 when the transition is illegal, or when another
 *         admin moved the order first.
 */
export async function changeOrderStatus(
  actor: AuditActor,
  orderId: string,
  target: OrderStatusTarget,
  reason?: string,
): Promise<AdminOrderDetail> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          items: {
            select: { productId: true, quantity: true },
          },
        },
      });

      if (!order) {
        throw ApiError.notFound("That order does not exist.");
      }

      const permitted = permittedOrderTargets(order.status);

      if (!permitted.includes(target as OrderStatus)) {
        throw ApiError.conflict(
          `An order that is ${order.status} cannot be moved to ${target}.`,
          {
            currentStatus: order.status,
            requestedStatus: target,
            permittedStatuses: permitted,
          },
        );
      }

      const updated = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: target as OrderStatus },
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "That order was changed by someone else. Reload and try again.",
        );
      }

      // ── Stock restoration ────────────────────────────────────────────
      //
      // Only a cancellation restores stock, and a cancellation is only
      // ever permitted from PENDING or PROCESSING — both of which are
      // before dispatch. The goods are still on the shelf, so putting
      // them back is correct.
      //
      // The quantity restored is the **snapshotted** quantity from the
      // order line, never a re-derived one. The arithmetic is exact:
      // stock_after_checkout + quantity = stock_before_checkout.
      //
      // Because the status update above was conditional on the current
      // status, two admins cancelling the same order cannot both restore
      // the stock: the loser's updateMany matches zero rows and the
      // transaction rolls back before any increment runs.
      if (target === OrderStatus.CANCELLED) {
        for (const item of order.items) {
          await tx.product.update({
            where: { id: item.productId },
            data: {
              stockQuantity: { increment: item.quantity },
              /**
               * The units-sold counter comes back down with the stock.
               *
               * The counter was incremented when the order was placed,
               * and a cancelled order was never sold — so leaving the
               * counter up would claim the shop sold goods it gave
               * back. It moves in the **same** statement as the stock,
               * so the two cannot disagree.
               *
               * A cancellation is only ever permitted from `PENDING` or
               * `PROCESSING`, so the counter was incremented exactly
               * once for this order and one decrement is exactly right.
               */
              soldCount: { decrement: item.quantity },
            },
          });
        }
      }

      await writeAuditEntry(tx, {
        actor,
        action:
          target === OrderStatus.CANCELLED
            ? ORDER_ACTIONS.cancelled
            : ORDER_ACTIONS.statusChanged,
        entityType: "order",
        entityId: orderId,
        before: { status: order.status },
        after: { status: target },
        reason: reason ?? null,
      });

      const detail = await tx.order.findUnique({
        where: { id: orderId },
        select: ADMIN_ORDER_DETAIL_SELECT,
      });

      if (!detail) {
        throw ApiError.notFound("That order does not exist.");
      }

      return {
        ...toOrderSummary(detail),
        shippingAddress: detail.shippingAddress,
        paymentTransactionId: detail.paymentTransactionId,
        paymentSenderNumber: detail.paymentSenderNumber,
        items: detail.items,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Changes an order's payment status.
 *
 * The payment axis is **independent** of the fulfilment axis. A COD
 * order can be `SHIPPED` while the payment is still `PENDING`, because
 * the cash is collected on delivery — and that is exactly why the two
 * have separate audit actions.
 *
 * @throws ApiError 404 when the order does not exist.
 * @throws ApiError 409 when the transition is illegal.
 */
export async function changePaymentStatus(
  actor: AuditActor,
  orderId: string,
  target: PaymentStatusTarget,
  reason?: string,
): Promise<AdminOrderDetail> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true, paymentStatus: true },
      });

      if (!order) {
        throw ApiError.notFound("That order does not exist.");
      }

      const permitted = permittedPaymentTargets(order.paymentStatus);

      if (!permitted.includes(target as PaymentStatus)) {
        throw ApiError.conflict(
          `A payment that is ${order.paymentStatus} cannot be moved to ${target}.`,
          {
            currentPaymentStatus: order.paymentStatus,
            requestedPaymentStatus: target,
            permittedPaymentStatuses: permitted,
          },
        );
      }

      const updated = await tx.order.updateMany({
        where: { id: orderId, paymentStatus: order.paymentStatus },
        data: { paymentStatus: target as PaymentStatus },
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "That order's payment was changed by someone else. Reload and try again.",
        );
      }

      await writeAuditEntry(tx, {
        actor,
        action: ORDER_ACTIONS.paymentStatusChanged,
        entityType: "order",
        entityId: orderId,
        before: { paymentStatus: order.paymentStatus },
        after: { paymentStatus: target },
        reason: reason ?? null,
      });

      const detail = await tx.order.findUnique({
        where: { id: orderId },
        select: ADMIN_ORDER_DETAIL_SELECT,
      });

      if (!detail) {
        throw ApiError.notFound("That order does not exist.");
      }

      return {
        ...toOrderSummary(detail),
        shippingAddress: detail.shippingAddress,
        paymentTransactionId: detail.paymentTransactionId,
        paymentSenderNumber: detail.paymentSenderNumber,
        items: detail.items,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Convenience wrapper that changes an order status on behalf of a session
 * user.
 */
export async function changeOrderStatusAsUser(
  user: SessionUser,
  orderId: string,
  target: OrderStatusTarget,
  reason?: string,
): Promise<AdminOrderDetail> {
  return changeOrderStatus(toAuditActor(user), orderId, target, reason);
}

/**
 * Convenience wrapper that changes a payment status on behalf of a session
 * user.
 */
export async function changePaymentStatusAsUser(
  user: SessionUser,
  orderId: string,
  target: PaymentStatusTarget,
  reason?: string,
): Promise<AdminOrderDetail> {
  return changePaymentStatus(toAuditActor(user), orderId, target, reason);
}
