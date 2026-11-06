import { z } from "zod";

import {
  senderNumberSchema,
  transactionIdSchema,
} from "./commerce";

/**
 * The transfer fields, under the names the settle body uses.
 *
 * The **same** schemas the checkout body uses, aliased rather than
 * rewritten. A second implementation of "what is a valid TrxID" would be
 * a second thing to keep in step with the first — and the two would
 * drift, so that a TrxID the checkout accepted would be refused by the
 * settle, or worse, the reverse.
 */
const gatewaySenderNumberSchema = senderNumberSchema;
const gatewayTransactionIdSchema = transactionIdSchema;

/**
 * Validation schemas for the payment gateway.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * The gateway's request body carries **two** things: the one-time session
 * token the browser holds, and the outcome the (simulated) gateway
 * returned. There is no amount, no product, no address — the server
 * already knows all of that, because it read it from the order.
 *
 * That matters. A settle request that carried an amount would be a
 * request that could be *edited* — and the whole point of the gateway
 * window is that the amount shown to the customer is the server's
 * number, not theirs.
 */

/**
 * The one-time gateway session token.
 *
 * Thirty-two hex characters, because that is exactly what
 * `generateGatewaySessionId` produces. The bounds are the schema's
 * statement of that fact: a token shorter than 32 or longer than 64
 * cannot have come from the gateway, and refusing it at the boundary is
 * cheaper than discovering it in a query.
 */
const gatewaySessionIdSchema = z
  .string()
  .trim()
  .min(32, "That payment session is not valid.")
  .max(64, "That payment session is not valid.");

/**
 * The outcome of a gateway attempt.
 *
 * Exactly two values, and they are the two the sandbox window offers.
 * `REFUNDED` is deliberately **not** here: a customer must never be able
 * to tell the system that they want their money back — that is the
 * admin's job, and it has its own audited path.
 */
export const gatewayOutcomes = ["SUCCESS", "FAILED"] as const;

export type GatewayOutcome = (typeof gatewayOutcomes)[number];

/**
 * The body of a settle request.
 *
 * **`.strict()`** — an unexpected key is a 400 rather than something
 * silently dropped. The house checkout schema is not strict, but that
 * schema is a large object where a stray field is harmless. This is a
 * small object, and a typo in `outcome` — `"success"`, `"CANCELLED"` —
 * should be loud rather than quietly absent.
 *
 * ── Why the two transfer fields live here ─────────────────────────────────
 *
 * The checkout page holds **only** the payment selection — the customer
 * picks bKash and presses "Place order". The transfer reference (the
 * sender's number and the TrxID from the confirmation screen) is
 * collected in the **gateway window**, because that is where the
 * customer is actually looking at the amount they are about to send.
 *
 * So the order is created first — its `paymentMethod` is fixed, and the
 * stock is reserved — and the transfer details are recorded on it as the
 * payment settles. That is why they are part of the **settle** body and
 * not the checkout body.
 *
 * They are **optional here**, and conditional on the method, because:
 *
 *   • A card or cash order has no transfer reference, and the schema
 *     refuses one — the same rule `checkoutSchema` enforces, applied at
 *     the second boundary.
 *   • The method is not in this body on purpose. The server reads it
 *     from the **order row**, which is the record (DECISIONS.md #147).
 *     A client-supplied method here would be a second, editable copy of
 *     the truth.
 */
export const gatewaySettleSchema = z
  .object({
    /** The one-time session token the browser holds. */
    sessionId: gatewaySessionIdSchema,

    /**
     * Whether the (simulated) gateway accepted the payment.
     *
     * Case-sensitive on purpose: the outcome is an enum value, and
     * accepting `"success"` would mean two spellings of one state.
     */
    outcome: z.enum(gatewayOutcomes),

    /**
     * The mobile number the transfer was sent FROM.
     *
     * Required for a mobile-banking order, refused for any other. The
     * shape is validated here, on the field, so a malformed number is a
     * malformed number — and the error carries the field's path.
     */
    paymentSenderNumber: gatewaySenderNumberSchema.optional(),

    /**
     * The TrxID the customer quoted from their confirmation screen.
     */
    paymentTransactionId: gatewayTransactionIdSchema.optional(),
  })
  .strict()
  /**
   * The same conditional rule `checkoutSchema` enforces, applied at the
   * second boundary.
   *
   * A mobile-banking order **cannot be settled without a transfer
   * reference** — an order that settles with no TrxID is an order the
   * shop cannot reconcile against a merchant statement. And the converse
   * is enforced too: a card or cash settle may not carry one, because a
   * recorded transfer that does not exist is worse than a missing one.
   */
  .superRefine((value, ctx) => {
    const hasSender =
      value.paymentSenderNumber !== undefined &&
      value.paymentSenderNumber.trim() !== "";
    const hasTransaction =
      value.paymentTransactionId !== undefined &&
      value.paymentTransactionId.trim() !== "";

    /*
     * The method is **not** in this body, so the server cannot check the
     * conditional here. It checks it in `settleGatewayPayment`, where the
     * order row is read — the method is known there, and the order row
     * is the record.
     *
     * What this boundary checks is the part it *can* check without the
     * order: the pair must agree with each other. A settle that carries
     * one of the two but not the other is a malformed request — the
     * customer quoted half a transfer.
     */
    if (hasSender !== hasTransaction) {
      const missing = hasSender ? "paymentTransactionId" : "paymentSenderNumber";

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [missing],
        message:
          missing === "paymentTransactionId"
            ? "Enter the transaction ID (TrxID) from your confirmation screen."
            : "Enter the mobile number you sent the payment from.",
      });
    }
  });

/**
 * The body of a request to open (or re-arm) a gateway session.
 *
 * Empty by design: the order id is in the path, and the server reads
 * everything else from the order. A request body that could carry an
 * amount would be a request that could be edited.
 */
export const gatewaySessionSchema = z.object({}).strict();
