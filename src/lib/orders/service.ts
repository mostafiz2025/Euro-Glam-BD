import {
  AdminNotificationKind,
  CouponDiscountType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  type PrismaClient,
} from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { createNotification } from "@/lib/admin/notifications";
import { evaluateConflicts } from "@/lib/conflict-engine";
import {
  couponDiscountPaisa as couponDiscountPaisaFor,
  couponProblemMessage,
  couponStatus,
} from "@/lib/coupons/rules";
import { db } from "@/lib/db";
import {
  gatewaySessionForNewOrder,
} from "@/lib/payments/gateway";
import {
  generateGatewaySessionId,
  isGatewayMethod,
  type GatewaySessionPayload,
} from "@/lib/payments/session";
import {
  calculateOrderTotals,
  type PricedLine,
} from "@/lib/pricing";
import type { CheckoutInput } from "@/lib/validation/commerce";
import { isMobileBankingMethod } from "@/lib/validation/commerce";

/**
 * The order service.
 *
 * ── Why this is the most careful file in the codebase ────────────────────
 *
 * Placing an order does several things that must either all happen or
 * none of them happen:
 *
 *   1. Create the order.
 *   2. Create the order items.
 *   3. Decrement the stock of every product.
 *   4. Empty the cart.
 *
 * If the process dies between step 2 and step 3, the customer has an
 * order for products that were never reserved — the shop sells stock it
 * has already promised to somebody else. If it dies after step 3 but
 * before step 4, the customer is charged for a cart that still holds the
 * items and may check out again.
 *
 * So all four run inside **one interactive transaction**. Either the
 * order exists and the stock is deducted, or neither happened.
 *
 * ── Stock deduction ──────────────────────────────────────────────────────
 *
 * The decrement is written as a **conditional** update, not a read-then-
 * write:
 *
 * ```sql
 * UPDATE products SET stock = stock - $qty
 * WHERE id = $id AND stock >= $qty
 * ```
 *
 * This is the whole point. A read-then-write (`SELECT stock` followed by
 * `UPDATE ... SET stock = $newValue`) has a race: two concurrent checkouts
 * both read `stock = 1`, both compute `newValue = 0`, and the second
 * write silently overwrites the first — selling one unit twice. The
 * conditional update makes the check and the write a single atomic
 * operation, and the row lock it takes serialises concurrent checkouts of
 * the same product.
 *
 * When the conditional update affects zero rows, the stock was not
 * available and the whole transaction is rolled back.
 *
 * ── Order status vs payment status ──────────────────────────────────────
 *
 * These are separate columns with separate enums, and they mean different
 * things:
 *
 *   • `status` — where the *order* is in the fulfilment pipeline:
 *     PENDING → PROCESSING → SHIPPED → DELIVERED (or CANCELLED).
 *   • `paymentStatus` — where the *money* is: PENDING, PAID, FAILED or
 *     REFUNDED.
 *
 * A COD order is `PENDING` for both: nobody has paid yet, and the order
 * is waiting to be dispatched. When the courier collects the cash, the
 * payment becomes `PAID` while the order may still be `SHIPPED`. Keeping
 * them apart means the admin can answer "has this been paid?" without
 * also having to answer "has this shipped?".
 */

/**
 * The result of placing an order.
 */
export type PlaceOrderResult = {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  /**
   * The transfer reference the customer quoted, for a mobile-banking
   * order. `null` for `COD` and `CARD`.
   */
  paymentTransactionId: string | null;
  /**
   * The number the transfer was sent from, in the local `01XXXXXXXXX`
   * form. `null` for `COD` and `CARD`.
   */
  paymentSenderNumber: string | null;
  subtotalPaisa: number;
  shippingPaisa: number;
  shippingDiscountPaisa: number;
  /**
   * The coupon's discount, in poisha.
   *
   * `0` when no coupon was redeemed. Kept apart from
   * `shippingDiscountPaisa` because the two are different facts — one is
   * a promotion, the other is a property of the order's value — and
   * because the customer is entitled to see which one saved them what.
   */
  couponDiscountPaisa: number;
  /**
   * The code that was redeemed, or `null`.
   *
   * Recorded on the order so the shop can see which campaign an order
   * came from, and so the customer can see the code they used.
   */
  couponCode: string | null;
  totalAmountPaisa: number;
  totalQuantity: number;
  /** The order items, as placed. */
  items: Array<{
    productId: string;
    productName: string;
    pricePaisa: number;
    quantity: number;
  }>;
  /**
   * The ingredient conflicts that were present in the cart at checkout.
   *
   * Recorded on the order so the shop can see what the customer was
   * warned about, and so the advice can be repeated in a confirmation
   * message.
   */
  conflicts: Array<{
    ruleId: string;
    severity: "BLOCK" | "WARN";
    title: string;
    message: string;
    remedy: string;
    involvedProductIds: string[];
  }>;
  /**
   * The gateway session, for an order that settles through the sandbox
   * payment gateway.
   *
   * `null` for a `COD` order — cash on delivery opens no gateway
   * session, because there is nothing for a gateway to settle.
   *
   * The client does not decide whether a gateway session exists: this
   * field is the server's answer, and the checkout form opens the
   * gateway window **iff** this is non-null. One source of truth.
   */
  gateway: GatewaySessionPayload | null;
};

/**
 * The order shape returned by the list endpoint.
 */
export type OrderSummary = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  totalAmountPaisa: number;
  totalQuantity: number;
  createdAt: string;
  itemCount: number;
};

/**
 * The order shape returned by the detail endpoint.
 */
export type OrderDetail = OrderSummary & {
  subtotalPaisa: number;
  shippingPaisa: number;
  /**
   * The **total** discount on the order — free shipping plus any coupon.
   */
  discountAmountPaisa: number;
  /**
   * The coupon's discount alone, in poisha.
   *
   * Separate from `discountAmountPaisa` so the order page can show
   * *which* discount applied, rather than one anonymous number.
   */
  couponDiscountPaisa: number;
  /**
   * The coupon code that was redeemed, or `null` when the order carried
   * no code.
   */
  couponCode: string | null;
  shippingAddress: unknown;
  /**
   * The transfer reference the customer quoted, for a mobile-banking
   * order. `null` for `COD` and `CARD`.
   */
  paymentTransactionId: string | null;
  /**
   * The number the transfer was sent from, in the local `01XXXXXXXXX`
   * form. `null` for `COD` and `CARD`.
   */
  paymentSenderNumber: string | null;
  /**
   * The gateway's own transaction reference, recorded when a gateway
   * payment succeeds. `null` until it does.
   *
   * Separate from `paymentTransactionId`, which is the *customer's* own
   * transfer reference — so a card order has this one and not that one.
   */
  paymentGatewayTransactionId: string | null;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    pricePaisa: number;
    quantity: number;
  }>;
};

/**
 * Generates a human-friendly order number.
 *
 * `EGB-20261027-A1B2C3` — the date plus six characters of randomness. It
 * is for humans to quote over the phone, not a primary key, so a collision
 * is not catastrophic; the `Order.id` remains the identity. The random
 * part uses `crypto.randomBytes` rather than `Math.random` so the number
 * cannot be guessed.
 */
function generateOrderNumber(now: Date): string {
  // `crypto` is the Web Crypto global, available in the Node runtime.
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();

  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");

  return `EGB-${year}${month}${day}-${random}`;
}

/**
 * The Prisma client type that an interactive transaction receives.
 *
 * `Prisma.TransactionClient` omits the `$transaction` and `$connect`
 * methods, which is exactly the set of operations that are safe inside a
 * transaction.
 */
type TransactionClient = Prisma.TransactionClient;

/**
 * Places an order.
 *
 * The whole operation is one interactive transaction.
 *
 * @param userId  - The customer placing the order.
 * @param checkout - The validated checkout body.
 *
 * @throws ApiError 409 when the cart is empty, a product is out of stock,
 *         or the customer declined a blocking conflict.
 * @throws ApiError 403 when a `BLOCK` conflict is present and the request
 *         did not confirm it.
 */
export async function placeOrder(
  userId: string,
  checkout: CheckoutInput,
): Promise<PlaceOrderResult> {
  /**
   * The `maxWait` and `timeout` options bound how long the transaction may
   * hold a connection.
   *
   * `maxWait` is how long the client waits for a free connection from the
   * pool; `timeout` is how long the transaction may run once it has one.
   * Both matter here: a transaction that hangs holds a pooled connection,
   * and a pool of 10 connections can be exhausted by 10 hung checkouts.
   */
  return db.$transaction(
    async (tx: TransactionClient) => {
      // ── 1. Load the cart ───────────────────────────────────────────────
      const cart = await tx.cart.findUnique({
        where: { userId },
        select: {
          id: true,
          couponCode: true,
          items: {
            select: {
              id: true,
              productId: true,
              quantity: true,
              product: {
                select: {
                  id: true,
                  name: true,
                  pricePaisa: true,
                  discountPricePaisa: true,
                  purchasePricePaisa: true,
                  stockQuantity: true,
                  ingredientTags: true,
                  // The archive flag is **read**, not filtered.
                  //
                  // A nested `where: { archivedAt: null }` here would
                  // compile to an inner join, and the archived line would
                  // be omitted from `cart.items` entirely — the order
                  // would be placed for fewer lines than the customer
                  // saw, and the cart item would then be deleted by the
                  // `deleteMany` below without ever being ordered. The
                  // customer's line would vanish with no explanation.
                  //
                  // So the flag is read and checked in application code,
                  // and the checkout is refused with a message that says
                  // what actually happened.
                  archivedAt: true,
                },
              },
            },
          },
        },
      });

      if (!cart || cart.items.length === 0) {
        throw ApiError.validation("Your cart is empty.");
      }

      // ── 1a. Refuse a cart containing a withdrawn product ───────────────
      /**
       * An archived product is no longer for sale, so the checkout is
       * refused — **before** the order row is created and before any
       * stock is touched.
       *
       * The message is distinct from the "not enough stock" message. An
       * archived product is not sold out; it is withdrawn, and telling a
       * customer that a withdrawn product is "out of stock" is a
       * different (and wrong) claim about why they cannot buy it.
       *
       * The check lives here, at the **read**, rather than on the stock
       * decrement below. On the decrement, `count === 0` already means
       * "not enough stock" — adding an archive filter there would make
       * an archived product produce the same signal, and the customer
       * would be told the wrong thing. It would also skip the decrement
       * while the order row was already written, which is overselling.
       */
      const withdrawn = cart.items.filter(
        (item) => item.product.archivedAt !== null,
      );

      if (withdrawn.length > 0) {
        const names = withdrawn.map((item) => item.product.name);

        throw ApiError.conflict(
          names.length === 1
            ? `"${names[0]}" is no longer available. Please remove it from your cart to continue.`
            : `${names.length} items in your cart are no longer available (${names.join(", ")}). Please remove them to continue.`,
        );
      }

      // ── 2. Check the ingredient conflicts ──────────────────────────────
      /**
       * The conflict engine runs inside the transaction, on the cart's
       * actual contents.
       *
       * It is the same pure function used in the cart API, so the warning
       * the customer saw while adding items is the warning they are
       * checked against at checkout. There is no second, looser
       * implementation of the rules anywhere in the codebase.
       */
      const evaluation = evaluateConflicts(
        cart.items.map((item) => ({
          id: item.productId,
          ingredientTags: item.product.ingredientTags,
        })),
      );

      const blockingConflicts = evaluation.conflicts.filter(
        (conflict) => conflict.severity === "BLOCK",
      );

      /**
       * A `BLOCK` conflict must be explicitly confirmed.
       *
       * Unlike the cart, where the customer can add the item and be told
       * about the conflict, checkout is the point of no return. So the
       * request must carry `confirmConflicts: true` to proceed.
       *
       * The default is therefore "do not place the order", which is the
       * safe direction for a safety rule. The customer sees the conflict
       * and the remedy, and confirms.
       */
      if (blockingConflicts.length > 0 && !checkout.confirmConflicts) {
        throw new ApiError(
          "CONFLICT",
          "This order contains products that should not be used together without advice. Please review the conflict and confirm to continue.",
          {
            conflicts: blockingConflicts.map((conflict) => ({
              ruleId: conflict.ruleId,
              severity: conflict.severity,
              title: conflict.title,
              message: conflict.message,
              remedy: conflict.remedy,
              involvedProductIds: conflict.involvedProductIds,
            })),
          },
        );
      }

      // ── 3. Price the order ─────────────────────────────────────────────
      /**
       * The prices come from the database, read inside the transaction.
       *
       * The client sent no prices, and none are accepted. The amounts
       * below are the only ones that can reach the order.
       */
      const lines: PricedLine[] = cart.items.map((item) => ({
        product: {
          id: item.product.id,
          pricePaisa: item.product.pricePaisa,
          discountPricePaisa: item.product.discountPricePaisa,
        },
        quantity: item.quantity,
      }));

      // ── 3a. Validate the coupon ──────────────────────────────────────
      /**
       * The coupon is checked **again**, here, rather than trusted from
       * the cart page.
       *
       * Between the customer applying a code and pressing "Place order",
       * the coupon can expire, be deactivated by an admin, or run out of
       * uses. The cart page's answer was true when it was given; this
       * is the moment the money moves.
       *
       * And the order is **refused** if the coupon is no longer good.
       * It is not quietly ignored, and a smaller discount is not
       * quietly applied — a customer who was quoted a total deserves
       * to have the order fail loudly rather than succeed at a
       * different price. The coupon module owns the wording, so the
       * customer is told *which* thing happened.
       */
      let couponCode: string | null = null;
      let couponDiscountPaisa = 0;
      /**
       * The coupon's terms, as read inside this transaction.
       *
       * Held onto so the usage increment further down can repeat the
       * same conditional write against the same observed values. It is
       * `null` when the cart carried no code.
       */
      let redeemedCoupon: {
        readonly usageLimit: number | null;
        readonly usageCount: number;
      } | null = null;

      if (cart.couponCode) {
        const coupon = await tx.coupon.findUnique({
          where: { code: cart.couponCode },
          select: {
            code: true,
            isActive: true,
            expiresAt: true,
            usageLimit: true,
            usageCount: true,
            discountType: true,
            percentOff: true,
            amountOffPaisa: true,
          },
        });

        const status = coupon
          ? couponStatus(coupon, new Date())
          : ("INACTIVE" as const);

        if (!coupon || status !== "ACTIVE") {
          throw ApiError.conflict(
            couponProblemMessage(status) ??
              "That code is no longer active.",
            { code: cart.couponCode, status },
          );
        }

        const subtotalPaisa = lines.reduce(
          (total, line) =>
            total +
            (line.product.discountPricePaisa ?? line.product.pricePaisa) *
              line.quantity,
          0,
        );

        couponDiscountPaisa = couponDiscountPaisaFor(
          {
            discountType:
              coupon.discountType === CouponDiscountType.PERCENTAGE
                ? "PERCENTAGE"
                : "FIXED",
            percentOff: coupon.percentOff,
            amountOffPaisa: coupon.amountOffPaisa,
          },
          subtotalPaisa,
        );

        couponCode = coupon.code;
        redeemedCoupon = {
          usageLimit: coupon.usageLimit,
          usageCount: coupon.usageCount,
        };
      }

      const totals = calculateOrderTotals(
        lines,
        undefined,
        couponDiscountPaisa,
      );

      // ── 3b. Allocate the coupon across the lines ──────────────────────
      /**
       * The coupon is an **order-level** discount, but the profit
       * arithmetic is **line-level**. So the coupon's giveaway has to be
       * split across the lines before it can be subtracted from any
       * single line's margin.
       *
       * The allocation is **proportional to the line's share of the
       * subtotal**, and the shares are computed from the *charged* price
       * (the price the customer actually paid per unit, already net of
       * the product's own discount). The last line takes the remainder,
       * so the parts always sum to exactly the coupon's discount — no
       * poisha is lost to rounding, and no poisha is invented.
       *
       * This is a snapshot of the allocation **rule**, not a fact about
       * the product. A product's own sale discount is not repeated here:
       * `OrderItem.pricePaisa` is already the price the customer paid.
       */
      const lineSubtotals = cart.items.map((item) => {
        const unitPricePaisa =
          item.product.discountPricePaisa ?? item.product.pricePaisa;

        return unitPricePaisa * item.quantity;
      });

      const allocationBasePaisa = lineSubtotals.reduce(
        (total, amount) => total + amount,
        0,
      );

      /**
       * The coupon's share of each line, in poisha.
       *
       * The final line is corrected so the parts sum to exactly the
       * coupon's discount. When the base is zero (a fully free line,
       * which cannot happen today but is arithmetic, not policy) the
       * whole discount lands on the last line rather than being divided
       * by zero.
       */
      const couponShareByLine = cart.items.map((_, index) => {
        if (couponDiscountPaisa === 0) return 0;

        const isLast = index === cart.items.length - 1;

        if (isLast) {
          const allocatedSoFar = cart.items
            .slice(0, index)
            .reduce(
              (total, _, prior) =>
                total +
                (allocationBasePaisa === 0
                  ? 0
                  : Math.floor(
                      (couponDiscountPaisa * lineSubtotals[prior]) /
                        allocationBasePaisa,
                    )),
              0,
            );

          return couponDiscountPaisa - allocatedSoFar;
        }

        if (allocationBasePaisa === 0) return 0;

        return Math.floor(
          (couponDiscountPaisa * lineSubtotals[index]) / allocationBasePaisa,
        );
      });

      // ── 4. Create the order ────────────────────────────────────────────
      const now = new Date();
      const orderNumber = generateOrderNumber(now);

      /**
       * The gateway session token.
       *
       * Minted **here**, inside the transaction, for an order that settles
       * through the gateway. It has to be inside: the session is part of
       * the order's creation, and a session created outside the
       * transaction could exist for an order that rolled back.
       *
       * A `COD` order gets no session — there is nothing for a gateway to
       * settle.
       */
      const gatewaySessionId = isGatewayMethod(checkout.paymentMethod)
        ? generateGatewaySessionId()
        : null;

      const order = await tx.order.create({
        data: {
          userId,
          orderNumber,
          paymentGatewaySessionId: gatewaySessionId,
          subtotalPaisa: totals.subtotalPaisa,
          totalAmountPaisa: totals.totalAmountPaisa,
          shippingAmountPaisa: totals.shippingPaisa,
          /**
           * The **total** discount — the free-shipping discount plus the
           * coupon's.
           *
           * One column, because the customer is charged one number and
           * every screen that shows the discount must show *that*
           * number. `couponDiscountPaisa` beside it records the
           * coupon's share, so the admin can still answer "how much did
           * this campaign give away?".
           */
          discountAmountPaisa: totals.discountAmountPaisa,
          couponDiscountPaisa: totals.couponDiscountPaisa,
          couponCode,
          shippingAddress: checkout.shippingAddress as Prisma.InputJsonValue,
          /**
           * Order status and payment status are set independently.
           *
           * A COD order is `PENDING` for both: it has not been paid, and
           * it has not been dispatched. Nothing about a COD order means it
           * is "processing" until an admin picks it up.
           */
          status: OrderStatus.PENDING,
          paymentMethod: checkout.paymentMethod,
          /**
           * The transfer references, for a mobile-banking order.
           *
           * They are written **only** when the customer paid by mobile
           * banking, and they are written **from the validated input** —
           * never from anything the client could have slipped past the
           * schema.
           *
           * The validation schema already refuses a transaction reference
           * on a non-mobile-banking order, so this branch is a second
           * line of defence rather than the only one. It is written out
           * explicitly because `paymentTransactionId: undefined` on a
           * `CARD` order is not the same thing as `null`, and a stray
           * `undefined` in a Prisma `data` object means "do not set this
           * column" — which for a fresh row is the same as NULL, but
           * reads as an oversight to anyone auditing the code.
           */
          paymentTransactionId: isMobileBankingMethod(checkout.paymentMethod)
            ? (checkout.paymentTransactionId ?? null)
            : null,
          paymentSenderNumber: isMobileBankingMethod(checkout.paymentMethod)
            ? (checkout.paymentSenderNumber ?? null)
            : null,
          /**
           * The payment status.
           *
           * Every method starts as `PENDING`, including mobile banking.
           *
           * This is deliberate and it is the honest answer: the customer
           * has *told* us they sent a transfer, but nobody has verified
           * that the money arrived. bKash and Nagad transfers can fail,
           * can be sent to the wrong number, or can be a screenshot of
           * somebody else's payment. An admin confirms the transfer
           * against the merchant statement and moves this to `PAID`.
           *
           * Marking it `PAID` at checkout would be a claim the system
           * cannot make — and a customer could do it themselves by
           * choosing a mobile banking method.
           */
          paymentStatus: PaymentStatus.PENDING,
          items: {
            create: cart.items.map((item, index) => ({
              productId: item.productId,
              /**
               * The name and price are snapshotted.
               *
               * If the catalogue later renames the product or changes its
               * price, the historical order must not change with it. The
               * snapshot is what the customer actually agreed to buy.
               */
              productName: item.product.name,
              pricePaisa:
                item.product.discountPricePaisa ?? item.product.pricePaisa,
              /**
               * The cost, snapshotted at the moment of the sale.
               *
               * `null` when the product's cost has never been recorded.
               * The profit figures **exclude** such a line rather than
               * counting it as if the goods were free — see
               * `src/lib/admin/profit.ts`.
               */
              purchasePricePaisa: item.product.purchasePricePaisa,
              /**
               * The coupon's share of this line, in poisha.
               *
               * The product's own sale discount is **not** repeated
               * here — `pricePaisa` above is already the price the
               * customer paid per unit, so it is already net of that
               * discount.
               */
              discountAmountPaisa: couponShareByLine[index],
              quantity: item.quantity,
            })),
          },
        },
        select: { id: true },
      });

      // ── 5. Deduct the stock, atomically ────────────────────────────────
      for (const item of cart.items) {
        /**
         * The conditional decrement.
         *
         * `updateMany` with a `stockQuantity >= quantity` filter is a
         * single atomic statement. It returns the number of affected
         * rows: 0 means somebody else took the stock first.
         *
         * A plain `update` with `data: { stockQuantity: { decrement: n } }`
         * would let the stock go negative — the database has no CHECK
         * constraint on it — so the guard has to be in the WHERE clause.
         */
        const result = await tx.product.updateMany({
          where: {
            id: item.productId,
            stockQuantity: { gte: item.quantity },
          },
          data: {
            stockQuantity: { decrement: item.quantity },
            /**
             * The units-sold counter moves in the **same** statement as
             * the stock decrement.
             *
             * Two counters that move in two statements can disagree — a
             * crash between them would leave the shop saying it sold
             * stock it still has on the shelf. One statement cannot
             * disagree with itself.
             *
             * The counter is a **convenience figure**, not an
             * accounting record. The authoritative figure for money is
             * always the sum of the order items, and the profit numbers
             * are computed from the order items rather than from this
             * column — so a counter that drifted would misreport a
             * popularity ranking but could never misreport the shop's
             * money.
             */
            soldCount: { increment: item.quantity },
          },
        });

        if (result.count === 0) {
          /**
           * Not enough stock. Throwing here rolls the whole transaction
           * back — the order, the items and any stock already deducted by
           * an earlier line in this loop.
           *
           * This is why the stock deduction happens *after* the order is
           * created rather than before: it does not matter, because the
           * transaction makes it atomic either way. It is placed here so
           * the error message can name the product that ran out.
           */
          throw ApiError.conflict(
            `"${item.product.name}" does not have enough stock left. Please reduce the quantity and try again.`,
          );
        }
      }

      // ── 6. Empty the cart ──────────────────────────────────────────────
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      // ── 6b. Count the coupon's use ─────────────────────────────────────
      /**
       * The usage is counted **here**, at the order, and not when the
       * code was applied.
       *
       * Counting it at the apply would let a customer apply a limited
       * coupon, abandon the cart, and exhaust the campaign without
       * buying anything — and the shop's advertisement would have been
       * used up by people who never paid.
       *
       * The increment is **conditional** on the coupon still being
       * usable, for the same reason the stock decrement is: two
       * customers redeeming the last use of a coupon at the same moment
       * must produce one winner and one 409, not two orders that both
       * took the last use.
       *
       * The condition also carries the current `usageCount`, so the
       * update matches on what this transaction read.
       */
      if (couponCode && redeemedCoupon) {
        const used = await tx.coupon.updateMany({
          where: {
            code: couponCode,
            isActive: true,
            expiresAt: { gt: new Date() },
            /*
             * The `usageCount` this transaction read, and — when the
             * coupon has a limit — the requirement that there is still a
             * use left. Both live in the same filter object, so
             * Prisma combines them with `AND`.
             */
            usageCount:
              redeemedCoupon.usageLimit === null
                ? redeemedCoupon.usageCount
                : {
                    equals: redeemedCoupon.usageCount,
                    lt: redeemedCoupon.usageLimit,
                  },
          },
          data: { usageCount: { increment: 1 } },
        });

        if (used.count === 0) {
          throw ApiError.conflict(
            "That code has just been used up by someone else. Please remove it and try again.",
            { code: couponCode },
          );
        }
      }

      // ── 6a. Announce the order to the admin desk ───────────────────────
      /**
       * The notification is written **here**, inside the transaction that
       * made the order.
       *
       * That placement is the whole point. An order with no notification
       * is an order the admin may never see, and an order that exists but
       * was never announced is indistinguishable from an order that was
       * never placed. Writing the notification in the same transaction
       * means the two facts commit together or not at all — there is no
       * window in which the order exists and the bell is silent.
       *
       * The customer name is snapshotted from the validated shipping
       * address, for the same reason the notification service documents:
       * the bell renders without a join, and the row survives the order.
       */
      await createNotification(tx, {
        kind: AdminNotificationKind.ORDER_PLACED,
        orderId: order.id,
        orderNumber,
        customerName: checkout.shippingAddress.fullName,
        totalAmountPaisa: totals.totalAmountPaisa,
        paymentMethod: checkout.paymentMethod,
      });

      // ── 7. Return the order ────────────────────────────────────────────
      return {
        orderId: order.id,
        orderNumber,
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: checkout.paymentMethod,
        paymentTransactionId: isMobileBankingMethod(checkout.paymentMethod)
          ? (checkout.paymentTransactionId ?? null)
          : null,
        paymentSenderNumber: isMobileBankingMethod(checkout.paymentMethod)
          ? (checkout.paymentSenderNumber ?? null)
          : null,
        subtotalPaisa: totals.subtotalPaisa,
        shippingPaisa: totals.shippingPaisa,
        shippingDiscountPaisa: totals.shippingDiscountPaisa,
        couponDiscountPaisa: totals.couponDiscountPaisa,
        couponCode,
        totalAmountPaisa: totals.totalAmountPaisa,
        totalQuantity: cart.items.reduce(
          (total, item) => total + item.quantity,
          0,
        ),
        items: cart.items.map((item) => ({
          productId: item.productId,
          productName: item.product.name,
          pricePaisa:
            item.product.discountPricePaisa ?? item.product.pricePaisa,
          quantity: item.quantity,
        })),
        conflicts: evaluation.conflicts.map((conflict) => ({
          ruleId: conflict.ruleId,
          severity: conflict.severity,
          title: conflict.title,
          message: conflict.message,
          remedy: conflict.remedy,
          involvedProductIds: conflict.involvedProductIds,
        })),
        /**
         * The gateway session, for an order that settles through the
         * gateway.
         *
         * `null` for a `COD` order. The checkout form opens the gateway
         * window **iff** this is non-null — it never decides for itself.
         */
        gateway: gatewaySessionId
          ? gatewaySessionForNewOrder({
              id: order.id,
              orderNumber,
              paymentMethod: checkout.paymentMethod,
              totalAmountPaisa: totals.totalAmountPaisa,
              sessionId: gatewaySessionId,
            })
          : null,
      };
    },
    {
      /**
       * How long to wait for a connection from the pool.
       *
       * Under normal load this is never reached. It bounds the wait when
       * the pool is saturated, so a request fails fast rather than
       * hanging.
       */
      maxWait: 5_000,
      /**
       * How long the transaction may run.
       *
       * The body is a handful of indexed queries — milliseconds. Ten
       * seconds is a generous ceiling that still guarantees the
       * connection is returned to the pool.
       */
      timeout: 10_000,
      /**
       * The isolation level.
       *
       * `ReadCommitted` is PostgreSQL's default and is sufficient here:
       * the stock decrement is a conditional write, so the row lock it
       * takes provides the serialisation that matters. `Serializable`
       * would also work but adds retry overhead for a benefit this
       * design does not need.
       */
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

/**
 * Lists the customer's orders, newest first.
 */
export async function listOrders(
  userId: string,
  page = 1,
  limit = 20,
): Promise<{ orders: OrderSummary[]; total: number }> {
  const skip = (page - 1) * limit;

  const [orders, total] = await Promise.all([
    db.order.findMany({
      where: { userId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        totalAmountPaisa: true,
        createdAt: true,
        items: { select: { quantity: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    db.order.count({ where: { userId } }),
  ]);

  return {
    total,
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      totalAmountPaisa: order.totalAmountPaisa,
      totalQuantity: order.items.reduce(
        (total, item) => total + item.quantity,
        0,
      ),
      createdAt: order.createdAt.toISOString(),
      itemCount: order.items.length,
    })),
  };
}

/**
 * Loads a single order belonging to the customer.
 *
 * Scoped by `userId` in the where clause, so an order belonging to
 * another customer returns `null` — the same result as a non-existent
 * id. The endpoint cannot be used to discover other customers' orders.
 */
export async function getOrderById(
  userId: string,
  orderId: string,
): Promise<OrderDetail | null> {
  const order = await db.order.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      totalAmountPaisa: true,
      subtotalPaisa: true,
      shippingAmountPaisa: true,
      discountAmountPaisa: true,
      couponDiscountPaisa: true,
      couponCode: true,
      shippingAddress: true,
      paymentTransactionId: true,
      paymentSenderNumber: true,
      paymentGatewayTransactionId: true,
      createdAt: true,
      items: {
        select: {
          id: true,
          productId: true,
          productName: true,
          pricePaisa: true,
          quantity: true,
        },
      },
    },
  });

  if (!order) return null;

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    totalAmountPaisa: order.totalAmountPaisa,
    subtotalPaisa: order.subtotalPaisa,
    shippingPaisa: order.shippingAmountPaisa,
    discountAmountPaisa: order.discountAmountPaisa,
    couponDiscountPaisa: order.couponDiscountPaisa,
    couponCode: order.couponCode,
    shippingAddress: order.shippingAddress,
    paymentTransactionId: order.paymentTransactionId,
    paymentSenderNumber: order.paymentSenderNumber,
    paymentGatewayTransactionId: order.paymentGatewayTransactionId,
    createdAt: order.createdAt.toISOString(),
    totalQuantity: order.items.reduce(
      (total, item) => total + item.quantity,
      0,
    ),
    itemCount: order.items.length,
    items: order.items,
  };
}

/**
 * The Prisma client type used by the order service.
 *
 * Re-exported for the tests, which construct their own client.
 */
export type { PrismaClient };
