import { describe, expect, it } from "vitest";

import {
  gatewayOutcomes,
  gatewaySessionSchema,
  gatewaySettleSchema,
} from "@/lib/validation/payments";

/**
 * The gateway's request bodies.
 *
 * ── What these tests are actually about ──────────────────────────────────
 *
 * The settle body carries the one-time session token and the outcome.
 * There is no amount, no product, no address — the server already knows
 * all of that, because it read it from the order.
 *
 * That matters. A settle request that carried an amount would be a
 * request that could be *edited*, and the whole point of the gateway
 * window is that the amount shown to the customer is the server's
 * number, not theirs.
 *
 * The body carries **two more** optional keys, for a mobile-banking
 * order: the sender number and the TrxID the customer quoted in the
 * gateway window. They are the reconciliation reference, and they are
 * the only thing about the payment the server cannot already know.
 *
 * So the interesting assertions here are the **refusals**: a body that
 * tries to smuggle in an amount, a card detail, or half a transfer
 * reference must be rejected loudly rather than quietly ignored.
 */
describe("gatewaySettleSchema", () => {
  it("accepts the two outcomes the sandbox window offers", () => {
    for (const outcome of gatewayOutcomes) {
      const result = gatewaySettleSchema.safeParse({
        sessionId: "a".repeat(32),
        outcome,
      });

      expect(result.success).toBe(true);
    }
  });

  it("accepts exactly two outcomes", () => {
    expect([...gatewayOutcomes]).toEqual(["SUCCESS", "FAILED"]);
  });

  it("refuses an outcome the gateway does not offer", () => {
    // `REFUNDED` in particular — a customer must never be able to tell
    // the system that they want their money back. That is the admin's
    // job, and it has its own audited path.
    for (const outcome of ["REFUNDED", "PENDING", "PAID", "CANCELLED"]) {
      const result = gatewaySettleSchema.safeParse({
        sessionId: "a".repeat(32),
        outcome,
      });

      expect(result.success).toBe(false);
    }
  });

  it("refuses an outcome in the wrong case", () => {
    // The outcome is an enum value. Accepting "success" would mean two
    // spellings of one state.
    for (const outcome of ["success", "failed", "Success"]) {
      const result = gatewaySettleSchema.safeParse({
        sessionId: "a".repeat(32),
        outcome,
      });

      expect(result.success).toBe(false);
    }
  });

  it("refuses a session token that is too short", () => {
    // Thirty-two hex characters is exactly what `generateGatewaySessionId`
    // produces, so anything shorter cannot have come from the gateway.
    for (const sessionId of ["", "a", "a".repeat(31)]) {
      const result = gatewaySettleSchema.safeParse({
        sessionId,
        outcome: "SUCCESS",
      });

      expect(result.success).toBe(false);
    }
  });

  it("refuses a session token that is too long", () => {
    const result = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(65),
      outcome: "SUCCESS",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a session token at both bounds", () => {
    for (const sessionId of ["a".repeat(32), "a".repeat(64)]) {
      const result = gatewaySettleSchema.safeParse({
        sessionId,
        outcome: "SUCCESS",
      });

      expect(result.success).toBe(true);
    }
  });

  it("refuses a body that carries an amount", () => {
    // The schema is strict, so an amount smuggled into the body is a
    // 400 rather than a silently dropped field. The amount shown to the
    // customer is the server's number — never the client's.
    const result = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
      outcome: "SUCCESS",
      amountPaisa: 1,
    });

    expect(result.success).toBe(false);
  });

  it("refuses a body that carries an unknown key", () => {
    const result = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
      outcome: "SUCCESS",
      orderId: "order_123",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a body that is missing the session token", () => {
    const result = gatewaySettleSchema.safeParse({ outcome: "SUCCESS" });

    expect(result.success).toBe(false);
  });

  it("refuses a body that is missing the outcome", () => {
    const result = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
    });

    expect(result.success).toBe(false);
  });

  it("trims the session token before measuring it", () => {
    // A token pasted with a stray space is still the token.
    const result = gatewaySettleSchema.safeParse({
      sessionId: `  ${"a".repeat(32)}  `,
      outcome: "SUCCESS",
    });

    expect(result.success).toBe(true);
  });

  it("refuses a body that carries a card detail", () => {
    // The PCI guarantee. The card details are typed in the gateway
    // window, checked in the browser, and **never sent** — so the
    // settle body must refuse them loudly rather than quietly drop
    // them. A schema that stripped them would hide a leak.
    for (const key of [
      "cardNumber",
      "cardExpiry",
      "cardCvc",
      "cardHolderName",
    ]) {
      const result = gatewaySettleSchema.safeParse({
        sessionId: "a".repeat(32),
        outcome: "SUCCESS",
        [key]: "4242424242424242",
      });

      expect(result.success).toBe(false);
    }
  });

  it("accepts a transfer reference for a mobile-banking order", () => {
    // The reference is quoted in the gateway window — the customer is
    // looking at the amount they are about to send — and it arrives
    // with the settle request rather than the placement request.
    const result = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
      outcome: "SUCCESS",
      paymentSenderNumber: "01712345678",
      paymentTransactionId: "8N3F2K9LM4",
    });

    expect(result.success).toBe(true);
  });

  it("refuses half a transfer reference", () => {
    // A transfer with a sender number but no TrxID cannot be matched to
    // a merchant statement line — so the pair must agree with each
    // other, at this boundary as well as at the service.
    const senderOnly = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
      outcome: "SUCCESS",
      paymentSenderNumber: "01712345678",
    });

    expect(senderOnly.success).toBe(false);

    if (!senderOnly.success) {
      const paths = senderOnly.error.issues.map((issue) => issue.path.join("."));

      expect(paths).toContain("paymentTransactionId");
    }

    const transactionOnly = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
      outcome: "SUCCESS",
      paymentTransactionId: "8N3F2K9LM4",
    });

    expect(transactionOnly.success).toBe(false);

    if (!transactionOnly.success) {
      const paths = transactionOnly.error.issues.map((issue) =>
        issue.path.join("."),
      );

      expect(paths).toContain("paymentSenderNumber");
    }
  });

  it("refuses a malformed transfer reference", () => {
    // The **same** schemas the checkout uses, aliased rather than
    // rewritten — so a TrxID the checkout accepted cannot be refused
    // here, and vice versa.
    const badNumber = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
      outcome: "SUCCESS",
      paymentSenderNumber: "12345",
      paymentTransactionId: "8N3F2K9LM4",
    });

    expect(badNumber.success).toBe(false);

    const badTransaction = gatewaySettleSchema.safeParse({
      sessionId: "a".repeat(32),
      outcome: "SUCCESS",
      paymentSenderNumber: "01712345678",
      paymentTransactionId: "8N3F 2K9L#M4",
    });

    expect(badTransaction.success).toBe(false);
  });
});

describe("gatewaySessionSchema", () => {
  it("accepts an empty body", () => {
    // The order id is in the path, and the server reads everything else
    // from the order. There is nothing for the client to send.
    expect(gatewaySessionSchema.safeParse({}).success).toBe(true);
  });

  it("refuses a body that carries anything", () => {
    const result = gatewaySessionSchema.safeParse({ amountPaisa: 100 });

    expect(result.success).toBe(false);
  });
});
