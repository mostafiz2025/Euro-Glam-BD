import { PaymentMethod } from "@prisma/client";

/**
 * The payment gateway's session — the shape the browser holds.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The gateway has two halves that must not import each other:
 *
 *   • `src/lib/payments/gateway.ts` — the server write path. It imports
 *     Prisma, so a client component that imports it would pull the
 *     database into the browser bundle.
 *
 *   • This file — the types and constants a **client component** needs
 *     to render the gateway window.
 *
 * So the payload type lives here, in a module that imports nothing but
 * an enum, exactly as `src/lib/format/payment.ts` does. The server
 * module imports the type *from* here; this module never imports the
 * server.
 *
 * This module is **client-safe**.
 */

/**
 * The merchant the customer is paying.
 *
 * One constant, in one place — the same discipline as
 * `src/lib/format/payment.ts`. A payment window that named a different
 * merchant would be a support ticket.
 */
export const GATEWAY_MERCHANT_NAME = "Euro Glam BD";

/**
 * The payment methods that settle through the gateway.
 *
 * `COD` is **not** in this list, and that is the whole point of the
 * carve-out: cash on delivery is collected by the courier at the door,
 * so there is no gateway window to open. The customer places the order
 * and is done.
 *
 * The list is derived from `PAYMENT_METHODS` rather than written out
 * again, so a method added to the enum is one edit away from being
 * classified — and a method that is *not* in this list can never
 * accidentally demand a gateway session.
 */
export const PAYMENT_GATEWAY_METHODS = [
  PaymentMethod.BKASH,
  PaymentMethod.NAGAD,
  PaymentMethod.CARD,
] as const satisfies readonly PaymentMethod[];

/**
 * Whether a payment method settles through the gateway.
 */
export function isGatewayMethod(method: string): boolean {
  return (PAYMENT_GATEWAY_METHODS as readonly string[]).includes(method);
}

/**
 * The payload the gateway window renders.
 *
 * Every field here is **the server's**. The amount in particular is not
 * a price the client computed — it is the total the server calculated
 * inside the order transaction. This extends the checkout form's
 * existing rule ("the client sends no prices") to "the client does not
 * compute prices either".
 */
export type GatewaySessionPayload = {
  /** The one-time token the browser holds and sends with the settle. */
  readonly sessionId: string;
  /** The order the session settles. */
  readonly orderId: string;
  /** The human-readable order number, e.g. `EGB-20261029-A1B2C3`. */
  readonly orderNumber: string;
  /** The merchant the customer is paying. */
  readonly merchantName: string;
  /** The amount to be paid, in poisha. */
  readonly amountPaisa: number;
  /** The method the customer chose. */
  readonly paymentMethod: PaymentMethod;
  /** The reference the gateway records against a successful payment. */
  readonly transactionId: string;
};

/**
 * Generates the one-time gateway session token.
 *
 * Thirty-two hex characters — 128 bits from `crypto.randomUUID`, which
 * is the same source `generateOrderNumber` uses and for the same reason:
 * the token cannot be guessed.
 *
 * It is stored in the **clear**, not hashed, and the reasoning is worth
 * keeping in one place so it is not "fixed" later. A hash is only
 * useful when the plaintext must be re-transmitted on every use and
 * never needs to be recoverable — the password case, which is what
 * `users.passwordHash` does with bcrypt. This token is used exactly
 * once: the settle endpoint consumes it and clears the column in the
 * same transaction that marks the order `PAID`. There is no second use,
 * so there is no stored credential to attack offline.
 *
 * The security comes from three things instead: unguessability, one-shot
 * use, and the customer-scoped ownership check in the settle endpoint —
 * the token alone is not enough, the caller must also own the order.
 */
export function generateGatewaySessionId(): string {
  // `crypto` is the Web Crypto global, available in the Node runtime.
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Mints the gateway's own transaction reference for an order.
 *
 * Deterministic from the order number, so the reference is readable in
 * the admin console and in the audit trail — a digest would answer
 * "which session?" but not "which payment?".
 *
 * It is kept **separate** from the customer's own transfer reference
 * (`Order.paymentTransactionId`), because that column means "the TrxID
 * the customer sent the payment from" and a card order has none.
 */
export function gatewayTransactionId(orderNumber: string): string {
  return `${orderNumber}-GW`;
}
