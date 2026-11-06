import { PaymentMethod, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { PAYMENT_STATUS_TRANSITIONS } from "@/lib/orders/payment-status";
import {
  GATEWAY_MERCHANT_NAME,
  PAYMENT_GATEWAY_METHODS,
  gatewayTransactionId,
  generateGatewaySessionId,
  isGatewayMethod,
} from "@/lib/payments/session";

/**
 * The payment gateway's pure logic.
 *
 * These tests need no database, because the facts they check are facts
 * about *shape*: which methods open a gateway window, what a session
 * token looks like, and — most importantly — **which payment transitions
 * the gateway is allowed to make**.
 *
 * The last one is the canary for the whole design. The gateway is a
 * customer path, and it deliberately shares the transition table with the
 * staff desk rather than restating it. If a future change ever adds a
 * `FAILED → PENDING` path to that table — the path that a "mark the
 * payment failed, then let the customer retry" reading of the gateway
 * would need — this test fails, because a failed gateway attempt must
 * never leave the payment in a state the table says is terminal.
 */
describe("the gateway session", () => {
  it("names the merchant once, in one place", () => {
    // A payment window that named a different merchant would be a
    // support ticket, so the name is a single constant.
    expect(GATEWAY_MERCHANT_NAME).toBe("Euro Glam BD");
  });

  it("settles bKash, Nagad and card through the gateway — and never cash on delivery", () => {
    expect([...PAYMENT_GATEWAY_METHODS]).toEqual([
      PaymentMethod.BKASH,
      PaymentMethod.NAGAD,
      PaymentMethod.CARD,
    ]);

    // Cash on delivery is collected by the courier at the door, so
    // there is no gateway window to open.
    expect(PAYMENT_GATEWAY_METHODS).not.toContain(PaymentMethod.COD);
  });

  it("classifies a method the same way everywhere", () => {
    expect(isGatewayMethod("BKASH")).toBe(true);
    expect(isGatewayMethod("NAGAD")).toBe(true);
    expect(isGatewayMethod("CARD")).toBe(true);

    expect(isGatewayMethod("COD")).toBe(false);
    expect(isGatewayMethod("")).toBe(false);
    expect(isGatewayMethod("UNKNOWN")).toBe(false);
  });

  it("never classifies an unknown method as a gateway method", () => {
    // The list is a closed set. A method this codebase does not know
    // must not be routed into the gateway — that would open a payment
    // window for a payment nobody can settle.
    const gatewayMethods: readonly PaymentMethod[] = PAYMENT_GATEWAY_METHODS;

    for (const method of Object.values(PaymentMethod)) {
      expect(isGatewayMethod(method)).toBe(gatewayMethods.includes(method));
    }
  });
});

describe("the gateway session token", () => {
  it("is thirty-two hexadecimal characters", () => {
    const token = generateGatewaySessionId();

    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is different on every call", () => {
    // The token is the only thing standing between "the customer holds a
    // token" and "the customer holds *someone else's* token", so two
    // calls must never collide.
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateGatewaySessionId()),
    );

    expect(tokens.size).toBe(200);
  });

  it("carries no dashes, so it is a single opaque string", () => {
    expect(generateGatewaySessionId()).not.toContain("-");
  });
});

describe("the gateway transaction reference", () => {
  it("is derived from the order number", () => {
    // Deterministic, so the reference is readable in the admin console
    // and in the audit trail.
    expect(gatewayTransactionId("EGB-20261029-A1B2C3")).toBe(
      "EGB-20261029-A1B2C3-GW",
    );
  });

  it("is not the customer's own transfer reference", () => {
    // The two references are different things and must never be
    // confused: one is what the customer quoted, the other is what the
    // gateway issued.
    expect(gatewayTransactionId("EGB-20261029-A1B2C3")).not.toBe(
      "8N3F2K9LM4",
    );
  });
});

describe("the gateway and the payment transition table", () => {
  it("may only settle a payment that is pending", () => {
    // The gateway's only legal write is `PENDING → PAID`, and that
    // transition already exists in the shared table — the gateway uses
    // the table, it does not extend it.
    expect(PAYMENT_STATUS_TRANSITIONS[PaymentStatus.PENDING]).toContain(
      PaymentStatus.PAID,
    );
  });

  it("cannot settle a payment that has already ended", () => {
    // `FAILED` and `REFUNDED` are terminal in the table, so the gateway
    // has no way to move them. This is what makes a replayed settle
    // request a no-op rather than a second charge.
    expect(PAYMENT_STATUS_TRANSITIONS[PaymentStatus.FAILED]).toEqual([]);
    expect(PAYMENT_STATUS_TRANSITIONS[PaymentStatus.REFUNDED]).toEqual([]);
  });

  it("has no way back out of a failed payment", () => {
    // The design decision, stated as a test: a failed gateway attempt
    // does **not** move the payment to `FAILED`, because `FAILED` is
    // terminal and a customer must be able to retry. The attempt is
    // recorded as a `PaymentAttempt` row and the payment stays
    // `PENDING`, so the retry happens on the same order.
    expect(PAYMENT_STATUS_TRANSITIONS[PaymentStatus.FAILED]).not.toContain(
      PaymentStatus.PENDING,
    );
  });

  it("cannot move a paid payment to anything but a refund", () => {
    expect(PAYMENT_STATUS_TRANSITIONS[PaymentStatus.PAID]).toEqual([
      PaymentStatus.REFUNDED,
    ]);
  });
});
