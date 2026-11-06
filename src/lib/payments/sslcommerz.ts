import { PaymentStatus, Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { isGatewayMethod } from "@/lib/payments/session";

import {
  initiatePayment,
  paisaToTaka,
  type SslCommerzSession,
} from "@/lib/sslcommerz";

import type { ShippingAddress } from "@/lib/validation/commerce";

/**
 * The SSLCOMMERZ payment service.
 *
 * ── Why this sits between the route and the gateway ───────────────────────
 *
 * `src/lib/sslcommerz.ts` knows the **gateway's** shape: the parameter
 * names, the currency, the response fields. It knows nothing about the
 * shop: it cannot read an order, it cannot tell a customer from an
 * admin.
 *
 * This file knows the **shop's** shape: the order row, the poisha
 * arithmetic, the customer's saved address. It knows nothing about the
 * gateway's wire format.
 *
 * The two meet here, once. A route handler asks for a gateway session
 * for an order; this file reads the order, works out the amount and the
 * customer block, and hands a fully-formed initiation to the gateway
 * wrapper.
 *
 * ── The three rules that shape it ─────────────────────────────────────────
 *
 * **1. The amount comes from the order, never from the request.**
 *
 * The caller names an *order id*. Every figure — the total, the item
 * count, the unit price — is read from the order row inside the
 * transaction. There is no code path in which a client-supplied number
 * reaches the gateway. A client that asks for a session on a ৳2,400
 * order gets a session for ৳2,400.
 *
 * **2. The customer block is derived from the saved address.**
 *
 * SSLCOMMERZ requires a name, an email, a phone and a postal address.
 * The order carries the postal address; the email comes from the
 * customer's account. Neither is read from the request.
 *
 * **3. The session is recorded before the customer is redirected.**
 *
 * The gateway hands back a `sessionkey`, and that key is what the
 * validation endpoint accepts. If it were not stored, the callback
 * handler would have nothing to validate against — and a callback that
 * cannot be validated is a callback that cannot be trusted. So the key
 * is written to the order in the same transaction that created the
 * session.
 */

/**
 * The shape of the shipping address as it is stored on `Order`.
 *
 * `Order.shippingAddress` is a plain `Json` column, so its contents are
 * only as trustworthy as the write that put them there. The checkout
 * validates the address with `shippingAddressSchema` before it is
 * written, which is what makes this parse meaningful — and the parse is
 * deliberately *defensive*: a row written by an older version of the
 * shop, or edited by hand, must not crash the checkout with a raw
 * `TypeError`. A malformed address degrades to "no address", and the
 * gateway session is refused with a message a human can act on.
 */
function parseShippingAddress(value: unknown): ShippingAddress | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<ShippingAddress>;

  if (
    typeof candidate.fullName !== "string" ||
    typeof candidate.phone !== "string" ||
    typeof candidate.addressLine1 !== "string" ||
    typeof candidate.city !== "string" ||
    typeof candidate.district !== "string" ||
    typeof candidate.postalCode !== "string"
  ) {
    return null;
  }

  return {
    fullName: candidate.fullName,
    phone: candidate.phone,
    addressLine1: candidate.addressLine1,
    addressLine2:
      typeof candidate.addressLine2 === "string" ? candidate.addressLine2 : undefined,
    city: candidate.city,
    district: candidate.district,
    postalCode: candidate.postalCode,
  };
}

/**
 * The result of opening an SSLCOMMERZ session for an order.
 */
export type SslCommerzOrderSession = {
  /** The order the session settles. */
  readonly orderId: string;
  /** The order's human-readable number, e.g. `EGB-20261030-A1B2C3`. */
  readonly orderNumber: string;
  /** Where the customer is sent to pay. */
  readonly gatewayPageUrl: string;
  /** The gateway's session key — how the transaction is validated later. */
  readonly sessionKey: string;
  /** The merchant's own reference for this transaction. */
  readonly tranId: string;
  /** The amount, in taka, that the gateway is being asked for. */
  readonly amountTaka: number;
};

/**
 * Opens an SSLCOMMERZ session for an order and records it on the order.
 *
 * ── The order of operations ───────────────────────────────────────────────
 *
 * 1. Read the order, its customer and its items.
 * 2. Ask the gateway to open a session.
 * 3. Record the returned session key on the order.
 *
 * Step 2 is a **network call**, and step 3 is a **database write**. They
 * cannot be in one transaction — a transaction held open across a call
 * to a third-party gateway would hold a pooled connection for as long as
 * that gateway takes to answer, and a slow gateway would exhaust the
 * pool.
 *
 * So the write happens after the call, and the failure mode is
 * explicit: if the order is deleted or settled between the read and the
 * write, the session is refused and the customer is not redirected. A
 * gateway session nobody can correlate is worse than no session at all.
 *
 * @param userId  - The customer who owns the order.
 * @param orderId - The order to open a session for.
 *
 * @throws ApiError 404 when the order does not exist, or is not the
 *         customer's.
 * @throws ApiError 409 when the order's payment is no longer PENDING,
 *         or the order does not settle through a gateway.
 * @throws ApiError 502 when the gateway declines to open a session.
 */
export async function openSslCommerzSession(
  userId: string,
  orderId: string,
): Promise<SslCommerzOrderSession> {
  const order = await db.order.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true,
      orderNumber: true,
      paymentStatus: true,
      paymentMethod: true,
      totalAmountPaisa: true,
      shippingAddress: true,
      user: { select: { email: true } },
      items: {
        select: {
          productName: true,
          pricePaisa: true,
          quantity: true,
        },
      },
    },
  });

  // Scoped by `userId`, so a foreign order is simply not found.
  if (!order) {
    throw ApiError.notFound("That order does not exist.");
  }

  /**
   * Only an unresolved payment can be opened.
   *
   * A `PAID` order has nothing left to pay, and a `FAILED` one is
   * terminal — the existing transition table has no path out of
   * `FAILED`, and inventing one here would be a second, divergent copy
   * of the rules.
   */
  if (order.paymentStatus !== PaymentStatus.PENDING) {
    throw ApiError.conflict(
      "This order's payment has already been settled.",
      { currentPaymentStatus: order.paymentStatus },
    );
  }

  /**
   * A `COD` order opens no gateway session.
   *
   * Cash on delivery is collected by the courier at the door. There is
   * nothing for a gateway to charge, and sending a cash order through
   * SSLCOMMERZ would create a session the customer has no reason to
   * use.
   */
  if (!isGatewayMethod(order.paymentMethod)) {
    throw ApiError.conflict(
      "This order is not paid through the payment gateway.",
      { paymentMethod: order.paymentMethod },
    );
  }

  const address = parseShippingAddress(order.shippingAddress);

  if (!address) {
    throw ApiError.conflict(
      "This order's delivery address is incomplete. Contact us and we will sort it out.",
    );
  }

  if (order.items.length === 0) {
    throw ApiError.conflict("This order has no items to charge for.");
  }

  const amountTaka = paisaToTaka(order.totalAmountPaisa);

  /**
   * The amount is sent to the gateway in **taka**, as a decimal string.
   *
   * The shop's internal unit is poisha, and the conversion is a floor —
   * see `paisaToTaka` for why rounding up is not an option.
   */
  if (amountTaka <= 0) {
    throw ApiError.conflict("This order's total is too low to charge.");
  }

  /**
   * The product name on the gateway page.
   *
   * The gateway shows one line, not a basket, so the names are joined
   * into a single readable summary. It is truncated because the gateway
   * truncates too, and a string of 4,000 characters is a support ticket
   * rather than a description.
   */
  const productName =
    order.items.length === 1
      ? order.items[0].productName
      : `${order.items[0].productName} + ${order.items.length - 1} more item${
          order.items.length > 2 ? "s" : ""
        }`;

  const totalQuantity = order.items.reduce(
    (total, item) => total + item.quantity,
    0,
  );

  /**
   * The unit price.
   *
   * For a single-line order this is the line's own price. For a
   * multi-line order there is no single unit price, so the total is
   * divided across the quantity — which is what the gateway's
   * "price per item" field is for: it is a display figure, and the
   * figure that is actually charged is `total_amount`.
   */
  const unitPriceTaka =
    totalQuantity > 0
      ? Number((amountTaka / totalQuantity).toFixed(2))
      : amountTaka;

  const session: SslCommerzSession = await initiatePayment({
    tranId: order.orderNumber,
    orderId: order.id,
    totalAmountTaka: amountTaka,
    customer: {
      name: address.fullName,
      email: order.user.email,
      phone: address.phone,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 ?? null,
      city: address.city,
      district: address.district,
      postalCode: address.postalCode,
    },
    product: {
      name: productName.slice(0, 255),
      quantity: totalQuantity,
      unitPriceTaka,
      totalAmountTaka: amountTaka,
    },
  });

  /**
   * Record the session key on the order.
   *
   * The key is what the gateway's validation endpoint accepts, so
   * without it a callback could not be verified. The write is
   * conditional on the payment still being `PENDING` — if it settled
   * while the gateway was answering, the customer has already paid and
   * must not be sent to a second checkout.
   */
  const updated = await db.order.updateMany({
    where: {
      id: order.id,
      userId,
      paymentStatus: PaymentStatus.PENDING,
    },
    data: { paymentGatewaySessionKey: session.sessionKey },
  });

  if (updated.count === 0) {
    throw ApiError.conflict(
      "That order was changed while we were opening your payment session. Reload and try again.",
    );
  }

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    gatewayPageUrl: session.gatewayPageUrl,
    sessionKey: session.sessionKey,
    tranId: session.tranId,
    amountTaka,
  };
}

/**
 * The Prisma select that reads an order for a callback.
 *
 * Narrow on purpose: a callback touches the payment columns and the
 * display columns, and reading the whole row would drag the shipping
 * JSON along for no reason.
 */
export const CALLBACK_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  totalAmountPaisa: true,
  paymentGatewaySessionKey: true,
  paymentGatewayValidationId: true,
  paymentGatewayTransactionId: true,
  shippingAddress: true,
  user: { select: { email: true, name: true } },
} satisfies Prisma.OrderSelect;
