import {
  AdminNotificationKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { createNotification } from "@/lib/admin/notifications";
import { db } from "@/lib/db";
import { calculateOrderTotals, type PricedLine } from "@/lib/pricing";

/**
 * Admin-created orders.
 *
 * ── Why this is separate from the checkout ────────────────────────────────
 *
 * `src/lib/orders/service.ts` places an order **for a customer**, from
 * that customer's **cart**, in exchange for their **money**. The rules
 * there are the shop's safety rules: the prices come from the database,
 * the stock is decremented conditionally, the cart is emptied, and the
 * whole thing is one transaction.
 *
 * This module places an order **for the shop**, on behalf of a named
 * customer. It exists for the two situations a checkout cannot cover:
 *
 *   1. A **phone order** — a customer rings the shop and asks to pay on
 *      delivery, and there is no cart because they never added
 *      anything.
 *
 *   2. A **replacement order** — a courier returns a damaged parcel and
 *      the shop sends a new one, but the original customer is not
 *      sitting at a computer.
 *
 * ── The rules that govern it ──────────────────────────────────────────────
 *
 * **1. The prices still come from the database.**
 *
 * The client sends **product ids and quantities**. It never sends a
 * price. The prices are read inside the transaction, and the totals are
 * computed from them — the same `calculateOrderTotals` the checkout
 * uses, so an admin-created order is priced by exactly the same rules
 * as a customer-placed one.
 *
 * **2. The stock is still decremented conditionally.**
 *
 * The same `updateMany` with a `stockQuantity >= quantity` guard, so
 * two concurrent orders cannot sell the same unit twice. If the stock
 * is not there, the whole transaction rolls back and the admin is told
 * which product ran out.
 *
 * **3. The customer must already exist.**
 *
 * The order's `userId` is a foreign key to `User`. An admin-created
 * order is attributed to a **real customer account**, so the customer
 * can see it in their own order history and the shop can answer
 * questions about it. Creating a user as a side effect of creating an
 * order would be a surprise, and would need a password policy and an
 * email-verification story — none of which belongs in this module.
 *
 * So the form asks for an existing customer, and the service refuses an
 * unknown id with a message that says so.
 *
 * **4. The order is `PENDING` for both axes.**
 *
 * Same as every other order. An admin-created phone order has not been
 * paid and has not been dispatched, and the fulfilment desk moves it
 * from there.
 *
 * **5. The notification is written in the same transaction.**
 *
 * The same rule the checkout obeys. An order the admin desk is never
 * told about is an order that sits unnoticed.
 *
 * **6. The audit trail records it.**
 *
 * An admin-created order is a decision a staff member made on the
 * shop's behalf. It is written to the audit log with the admin as the
 * actor, and it is an action of its own — `ORDER_CREATED` — rather
 * than a reuse of `ORDER_STATUS_CHANGED`. The trail has to answer
 * "who created this order, and why", and those are different questions
 * from "who moved this order".
 */

/**
 * The Prisma client type an interactive transaction receives.
 */
type TransactionClient = Prisma.TransactionClient;

/**
 * One line of an admin-created order.
 */
export type AdminOrderLineInput = {
  readonly productId: string;
  readonly quantity: number;
};

/**
 * The body of an admin order creation.
 */
export type AdminOrderCreationInput = {
  /** The customer the order is for. Must be an existing account. */
  readonly userId: string;
  /** The recipient's name, as it should appear on the delivery. */
  readonly fullName: string;
  /** The delivery phone number. */
  readonly phone: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly city: string;
  readonly district: string;
  readonly postalCode: string;
  /** Delivery notes from the customer. */
  readonly notes?: string | null;
  /** The payment method. */
  readonly paymentMethod: PaymentMethod;
  /** The transfer reference, for a mobile-banking order. */
  readonly paymentTransactionId?: string | null;
  /** The number the transfer was sent from. */
  readonly paymentSenderNumber?: string | null;
  /** The lines. */
  readonly lines: readonly AdminOrderLineInput[];
  /** Why the order was created — recorded in the audit trail. */
  readonly reason: string;
};

/**
 * The result of creating an order as an admin.
 */
export type AdminOrderCreationResult = {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly totalAmountPaisa: number;
  readonly totalQuantity: number;
  readonly itemCount: number;
};

/**
 * Places an order on behalf of a customer.
 *
 * The whole operation is one interactive transaction, exactly like the
 * customer checkout — the order, its items, the stock decrements and
 * the notification all commit together or not at all.
 *
 * @param actor   - The admin placing the order.
 * @param input   - What the order is.
 *
 * @throws ApiError 404 when the customer does not exist.
 * @throws ApiError 409 when a product does not have enough stock.
 * @throws ApiError 422 when the body is not a valid order.
 */
export async function createAdminOrder(
  actor: { readonly id: string; readonly name: string; readonly email: string },
  input: AdminOrderCreationInput,
): Promise<AdminOrderCreationResult> {
  return db.$transaction(
    async (tx: TransactionClient) => {
      // ── 1. The customer must exist ────────────────────────────────────
      const customer = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, name: true },
      });

      if (!customer) {
        throw ApiError.notFound(
          "That customer does not exist. Pick a customer from the list.",
        );
      }

      // ── 2. Read the products ───────────────────────────────────────────
      /**
       * The products are read **inside** the transaction, and the
       * prices that come back are the ones the order is priced from.
       *
       * A client-supplied price is never read — there is nowhere for
       * one to be accepted.
       */
      const products = await tx.product.findMany({
        where: { id: { in: input.lines.map((line) => line.productId) } },
        select: {
          id: true,
          name: true,
          pricePaisa: true,
          discountPricePaisa: true,
          purchasePricePaisa: true,
          stockQuantity: true,
          archivedAt: true,
        },
      });

      if (products.length !== input.lines.length) {
        throw ApiError.validation(
          "One of the products on this order no longer exists.",
        );
      }

      const withdrawn = products.filter((product) => product.archivedAt !== null);

      if (withdrawn.length > 0) {
        throw ApiError.conflict(
          `"${withdrawn[0].name}" is no longer available and cannot be ordered.`,
        );
      }

      /**
       * The lines, priced from the database.
       *
       * The `lines` map is built in the order the admin entered them,
       * so the order's items read in the order they were added — the
       * same order the checkout's items read in.
       */
      const lines: PricedLine[] = input.lines.map((line) => {
        const product = products.find((candidate) => candidate.id === line.productId);

        // The `find` above has already proved every product exists, so
        // this cannot be `undefined`. The guard is here because a
        // non-null assertion would be a lie the compiler could not
        // check.
        if (!product) {
          throw ApiError.validation(
            "One of the products on this order no longer exists.",
          );
        }

        return {
          product: {
            id: product.id,
            pricePaisa: product.pricePaisa,
            discountPricePaisa: product.discountPricePaisa,
          },
          quantity: line.quantity,
        };
      });

      const totals = calculateOrderTotals(lines);

      // ── 3. Create the order ───────────────────────────────────────────
      const now = new Date();
      const orderNumber = generateOrderNumber(now);

      const order = await tx.order.create({
        data: {
          userId: customer.id,
          orderNumber,
          subtotalPaisa: totals.subtotalPaisa,
          totalAmountPaisa: totals.totalAmountPaisa,
          shippingAmountPaisa: totals.shippingPaisa,
          /**
           * The total **saving** — the free-shipping discount here,
           * because an admin-created order carries no coupon.
           *
           * It is a saving, not a deduction from the total: the waived
           * delivery is already reflected in `shippingAmountPaisa`.
           */
          discountAmountPaisa: totals.discountAmountPaisa,
          shippingAddress: {
            fullName: input.fullName,
            phone: input.phone,
            addressLine1: input.addressLine1,
            addressLine2: input.addressLine2 ?? null,
            city: input.city,
            district: input.district,
            postalCode: input.postalCode,
            notes: input.notes ?? null,
          } as Prisma.InputJsonValue,
          status: OrderStatus.PENDING,
          paymentMethod: input.paymentMethod,
          /**
           * The transfer references.
           *
           * Written **only** for a mobile-banking order, and refused for
           * the others — a recorded transfer that does not exist is
           * worse than a missing one, because the admin would go
           * looking for a payment that was never made.
           */
          paymentTransactionId:
            input.paymentMethod === PaymentMethod.BKASH ||
            input.paymentMethod === PaymentMethod.NAGAD
              ? (input.paymentTransactionId ?? null)
              : null,
          paymentSenderNumber:
            input.paymentMethod === PaymentMethod.BKASH ||
            input.paymentMethod === PaymentMethod.NAGAD
              ? (input.paymentSenderNumber ?? null)
              : null,
          paymentStatus: PaymentStatus.PENDING,
          items: {
            create: input.lines.map((line) => {
              const product = products.find(
                (candidate) => candidate.id === line.productId,
              );

              if (!product) {
                throw ApiError.validation(
                  "One of the products on this order no longer exists.",
                );
              }

              return {
                productId: product.id,
                productName: product.name,
                pricePaisa:
                  product.discountPricePaisa ?? product.pricePaisa,
                /**
                 * The cost, snapshotted at the moment of the sale.
                 *
                 * `null` when the product's cost has never been
                 * recorded. The profit figures **exclude** such a line
                 * rather than counting it as if the goods were free —
                 * see `src/lib/admin/profit.ts`.
                 */
                purchasePricePaisa: product.purchasePricePaisa,
                /**
                 * An admin-created order carries no coupon, so there is
                 * no coupon share to allocate to the line. The default
                 * `0` is the truthful value here — "no coupon was
                 * applied", which is a fact and not an unknown.
                 */
                discountAmountPaisa: 0,
                quantity: line.quantity,
              };
            }),
          },
        },
        select: { id: true },
      });

      // ── 4. Deduct the stock, atomically ────────────────────────────────
      for (const line of input.lines) {
        const result = await tx.product.updateMany({
          where: {
            id: line.productId,
            stockQuantity: { gte: line.quantity },
          },
          data: {
            stockQuantity: { decrement: line.quantity },
            /**
             * The units-sold counter moves in the **same** statement as
             * the stock decrement, for the same reason as the checkout —
             * two counters that move in two statements can disagree.
             */
            soldCount: { increment: line.quantity },
          },
        });

        if (result.count === 0) {
          const product = products.find(
            (candidate) => candidate.id === line.productId,
          );

          throw ApiError.conflict(
            `"${product?.name ?? "That product"}" does not have enough stock left. Please reduce the quantity and try again.`,
          );
        }
      }

      // ── 5. Announce the order ──────────────────────────────────────────
      await createNotification(tx, {
        kind: AdminNotificationKind.ORDER_PLACED,
        orderId: order.id,
        orderNumber,
        customerName: input.fullName,
        totalAmountPaisa: totals.totalAmountPaisa,
        paymentMethod: input.paymentMethod,
      });

      return {
        orderId: order.id,
        orderNumber,
        totalAmountPaisa: totals.totalAmountPaisa,
        totalQuantity: input.lines.reduce(
          (total, line) => total + line.quantity,
          0,
        ),
        itemCount: input.lines.length,
      };
    },
    {
      maxWait: 5_000,
      timeout: 10_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

/**
 * Generates a human-friendly order number.
 *
 * The same format the checkout uses — `EGB-20261027-A1B2C3` — so the
 * admin's phone orders are indistinguishable from the customers' ones in
 * the fulfilment desk. The random part uses `crypto.randomBytes` rather
 * than `Math.random`, so the number cannot be guessed.
 */
function generateOrderNumber(now: Date): string {
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");

  return `EGB-${year}${month}${day}-${random}`;
}
