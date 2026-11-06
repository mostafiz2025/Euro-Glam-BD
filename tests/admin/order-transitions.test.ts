import { OrderStatus, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  CANCELLABLE_FROM,
  ORDER_STATUS_TRANSITIONS,
  PAYMENT_STATUS_TRANSITIONS,
  canTransitionOrder,
  canTransitionPayment,
  permittedOrderTargets,
  permittedPaymentTargets,
} from "@/lib/admin/orders";

/**
 * The order transition tables.
 *
 * These are pure functions, so they are tested without a database. They
 * lock down the rules the whole fulfilment desk depends on:
 *
 *   1. Fulfilment moves **forward only**. There is no path back to
 *      `PENDING`, and no path out of a terminal state.
 *   2. `SHIPPED → CANCELLED` is **absent**. The goods have left the
 *      warehouse; a cancellation would be a lie.
 *   3. `DELIVERED` and `CANCELLED` are terminal.
 *   4. Payment moves **independently** of fulfilment, so a COD order can
 *      be shipped while the payment is still pending.
 */

describe("the fulfilment transition table", () => {
  it("moves PENDING to PROCESSING or CANCELLED", () => {
    expect(permittedOrderTargets(OrderStatus.PENDING)).toEqual([
      OrderStatus.PROCESSING,
      OrderStatus.CANCELLED,
    ]);
  });

  it("moves PROCESSING to SHIPPED or CANCELLED", () => {
    expect(permittedOrderTargets(OrderStatus.PROCESSING)).toEqual([
      OrderStatus.SHIPPED,
      OrderStatus.CANCELLED,
    ]);
  });

  it("moves SHIPPED to DELIVERED only", () => {
    expect(permittedOrderTargets(OrderStatus.SHIPPED)).toEqual([
      OrderStatus.DELIVERED,
    ]);
  });

  it("treats DELIVERED as terminal", () => {
    expect(permittedOrderTargets(OrderStatus.DELIVERED)).toEqual([]);
  });

  it("treats CANCELLED as terminal", () => {
    expect(permittedOrderTargets(OrderStatus.CANCELLED)).toEqual([]);
  });

  it("does not permit SHIPPED to CANCELLED", () => {
    // The rule that makes "cancelling restores the stock" safe: every
    // permitted cancellation is pre-dispatch, so the goods are still on
    // the shelf.
    expect(canTransitionOrder(OrderStatus.SHIPPED, OrderStatus.CANCELLED)).toBe(
      false,
    );
  });

  it("does not permit a step backwards", () => {
    expect(canTransitionOrder(OrderStatus.DELIVERED, OrderStatus.SHIPPED)).toBe(
      false,
    );
    expect(
      canTransitionOrder(OrderStatus.PROCESSING, OrderStatus.PENDING),
    ).toBe(false);
    expect(canTransitionOrder(OrderStatus.SHIPPED, OrderStatus.PROCESSING)).toBe(
      false,
    );
  });

  it("does not permit a self-transition", () => {
    expect(canTransitionOrder(OrderStatus.PENDING, OrderStatus.PENDING)).toBe(
      false,
    );
    expect(canTransitionOrder(OrderStatus.SHIPPED, OrderStatus.SHIPPED)).toBe(
      false,
    );
  });

  it("lists every status in the table", () => {
    // A status added to the enum but not to the table would be a status
    // no order could ever enter.
    for (const status of Object.values(OrderStatus)) {
      expect(ORDER_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("never permits a transition out of a terminal state", () => {
    for (const terminal of [OrderStatus.DELIVERED, OrderStatus.CANCELLED]) {
      expect(ORDER_STATUS_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it("only ever permits a cancellation from a pre-dispatch status", () => {
    // The invariant behind the stock restoration. If this ever fails,
    // cancelling would put goods back on a shelf they have already left.
    for (const status of Object.values(OrderStatus)) {
      const canCancel = ORDER_STATUS_TRANSITIONS[status].includes(
        OrderStatus.CANCELLED,
      );

      if (canCancel) {
        expect(CANCELLABLE_FROM).toContain(status);
      }
    }

    expect([...CANCELLABLE_FROM].sort()).toEqual(
      [OrderStatus.PENDING, OrderStatus.PROCESSING].sort(),
    );
  });
});

describe("the payment transition table", () => {
  it("moves PENDING to PAID, FAILED or REFUNDED", () => {
    expect(permittedPaymentTargets(PaymentStatus.PENDING)).toEqual([
      PaymentStatus.PAID,
      PaymentStatus.FAILED,
      PaymentStatus.REFUNDED,
    ]);
  });

  it("moves PAID to REFUNDED only", () => {
    expect(permittedPaymentTargets(PaymentStatus.PAID)).toEqual([
      PaymentStatus.REFUNDED,
    ]);
  });

  it("treats FAILED and REFUNDED as terminal", () => {
    expect(permittedPaymentTargets(PaymentStatus.FAILED)).toEqual([]);
    expect(permittedPaymentTargets(PaymentStatus.REFUNDED)).toEqual([]);
  });

  it("does not permit a payment to move backwards", () => {
    expect(canTransitionPayment(PaymentStatus.PAID, PaymentStatus.PENDING)).toBe(
      false,
    );
    expect(
      canTransitionPayment(PaymentStatus.REFUNDED, PaymentStatus.PAID),
    ).toBe(false);
  });

  it("lists every status in the table", () => {
    for (const status of Object.values(PaymentStatus)) {
      expect(PAYMENT_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe("the two axes are independent", () => {
  it("lets a shipped order still have a pending payment", () => {
    // A COD order ships before the cash is collected. If the two axes
    // were coupled, this would be impossible to record.
    const orderStatus = OrderStatus.SHIPPED;
    const paymentStatus = PaymentStatus.PENDING;

    expect(permittedOrderTargets(orderStatus)).toContain(
      OrderStatus.DELIVERED,
    );
    expect(permittedPaymentTargets(paymentStatus)).toContain(PaymentStatus.PAID);
  });

  it("does not let a payment change alter the fulfilment target", () => {
    const before = permittedOrderTargets(OrderStatus.PROCESSING);

    // The payment table has no bearing on the order table.
    expect(permittedPaymentTargets(PaymentStatus.PAID)).not.toContain(
      OrderStatus.DELIVERED,
    );
    expect(before).toEqual([OrderStatus.SHIPPED, OrderStatus.CANCELLED]);
  });
});
