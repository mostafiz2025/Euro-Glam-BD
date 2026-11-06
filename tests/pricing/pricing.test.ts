import { describe, expect, it } from "vitest";

import {
  FLAT_SHIPPING_PAISA,
  FREE_SHIPPING_THRESHOLD_PAISA,
  calculateOrderTotals,
  effectivePricePaisa,
  formatPaisa,
  type PricedLine,
} from "@/lib/pricing";

/**
 * Pricing and total calculation tests.
 *
 * Money is the one thing that must never be wrong. These tests cover the
 * properties that make the arithmetic trustworthy:
 *
 *   1. The effective price honours a discount, including a zero discount.
 *   2. The subtotal is the exact sum of the line totals.
 *   3. The total is subtotal + shipping, with free shipping applied above
 *      the threshold.
 *   4. The arithmetic is exact — no floating-point drift.
 */

/**
 * Builds a priced line.
 */
function line(
  id: string,
  pricePaisa: number,
  quantity: number,
  discountPricePaisa: number | null = null,
): PricedLine {
  return {
    product: { id, pricePaisa, discountPricePaisa },
    quantity,
  };
}

describe("effectivePricePaisa", () => {
  it("returns the price when there is no discount", () => {
    expect(effectivePricePaisa({ id: "p", pricePaisa: 245000, discountPricePaisa: null })).toBe(
      245000,
    );
  });

  it("returns the discount price when there is one", () => {
    expect(
      effectivePricePaisa({ id: "p", pricePaisa: 245000, discountPricePaisa: 199000 }),
    ).toBe(199000);
  });

  it("returns a zero discount price rather than the full price", () => {
    // A zero discount is a legitimate value — a free item. A truthiness
    // check would wrongly return the full price here.
    expect(
      effectivePricePaisa({ id: "p", pricePaisa: 245000, discountPricePaisa: 0 }),
    ).toBe(0);
  });
});

describe("calculateOrderTotals", () => {
  it("returns zero for no lines", () => {
    const totals = calculateOrderTotals([]);

    expect(totals.subtotalPaisa).toBe(0);
    expect(totals.totalAmountPaisa).toBe(FLAT_SHIPPING_PAISA);
  });

  it("adds the flat shipping charge below the free-shipping threshold", () => {
    const totals = calculateOrderTotals([line("p1", 100000, 1)]);

    expect(totals.subtotalPaisa).toBe(100000);
    expect(totals.shippingPaisa).toBe(FLAT_SHIPPING_PAISA);
    expect(totals.shippingDiscountPaisa).toBe(0);
    expect(totals.totalAmountPaisa).toBe(100000 + FLAT_SHIPPING_PAISA);
  });

  it("waives shipping at the free-shipping threshold", () => {
    const totals = calculateOrderTotals([
      line("p1", FREE_SHIPPING_THRESHOLD_PAISA, 1),
    ]);

    expect(totals.subtotalPaisa).toBe(FREE_SHIPPING_THRESHOLD_PAISA);
    expect(totals.shippingPaisa).toBe(0);
    expect(totals.shippingDiscountPaisa).toBe(FLAT_SHIPPING_PAISA);
    expect(totals.totalAmountPaisa).toBe(FREE_SHIPPING_THRESHOLD_PAISA);
  });

  it("waives shipping above the free-shipping threshold", () => {
    const totals = calculateOrderTotals([
      line("p1", FREE_SHIPPING_THRESHOLD_PAISA + 1, 1),
    ]);

    expect(totals.shippingPaisa).toBe(0);
    expect(totals.totalAmountPaisa).toBe(totals.subtotalPaisa);
  });

  it("multiplies the price by the quantity", () => {
    const totals = calculateOrderTotals([line("p1", 12500, 4)]);

    expect(totals.subtotalPaisa).toBe(50000);
  });

  it("uses the discounted price in the subtotal", () => {
    const totals = calculateOrderTotals([line("p1", 200000, 2, 150000)]);

    expect(totals.subtotalPaisa).toBe(300000);
  });

  it("sums multiple lines", () => {
    const totals = calculateOrderTotals([
      line("p1", 10000, 2),
      line("p2", 20000, 1),
      line("p3", 5000, 3),
    ]);

    expect(totals.subtotalPaisa).toBe(20000 + 20000 + 15000);
  });

  it("is exact — no floating-point drift", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. In poisha (integers)
    // there is no drift at all.
    const totals = calculateOrderTotals([
      line("p1", 10, 1),
      line("p2", 20, 1),
    ]);

    expect(totals.subtotalPaisa).toBe(30);
    expect(Number.isInteger(totals.totalAmountPaisa)).toBe(true);
  });

  it("always returns integers", () => {
    const totals = calculateOrderTotals([line("p1", 33333, 3)]);

    expect(Number.isInteger(totals.subtotalPaisa)).toBe(true);
    expect(Number.isInteger(totals.shippingPaisa)).toBe(true);
    expect(Number.isInteger(totals.totalAmountPaisa)).toBe(true);
  });

  it("honours an explicit shipping amount", () => {
    const totals = calculateOrderTotals([line("p1", 10000, 1)], 0);

    expect(totals.shippingPaisa).toBe(0);
    expect(totals.totalAmountPaisa).toBe(10000);
  });

  it("waives an explicit shipping amount above the threshold", () => {
    const totals = calculateOrderTotals(
      [line("p1", FREE_SHIPPING_THRESHOLD_PAISA, 1)],
      5000,
    );

    expect(totals.shippingDiscountPaisa).toBe(5000);
    expect(totals.shippingPaisa).toBe(0);
  });

  it("does not grant free shipping on an empty cart", () => {
    // An empty cart has a zero subtotal, which is below the threshold.
    // The waiver must not apply, or the shipping discount would be
    // recorded on an order with nothing in it.
    const totals = calculateOrderTotals([]);

    expect(totals.shippingDiscountPaisa).toBe(0);
  });

  /**
   * ── The free-shipping discount is not deducted twice ──────────────────
   *
   * The free-shipping discount is **already** reflected in
   * `shippingPaisa`, which is the charge the customer actually pays for
   * delivery and is `0` when the order qualified. Deducting the total
   * discount from the total as well would count the same saving twice,
   * and would charge the customer ৳80 for a delivery that had been
   * waived.
   */
  it("does not deduct the free-shipping discount from the total twice", () => {
    const totals = calculateOrderTotals([
      line("p1", FREE_SHIPPING_THRESHOLD_PAISA, 1),
    ]);

    // The customer pays the subtotal, and nothing else.
    expect(totals.totalAmountPaisa).toBe(FREE_SHIPPING_THRESHOLD_PAISA);

    // The saving is still reported, so the screen can show it.
    expect(totals.discountAmountPaisa).toBe(FLAT_SHIPPING_PAISA);
  });

  it("keeps the invariant the order's columns follow", () => {
    // The order records `total = subtotal + shipping - coupon`, because
    // the free-shipping half of the discount is already inside the
    // shipping figure.
    const totals = calculateOrderTotals(
      [line("p1", FREE_SHIPPING_THRESHOLD_PAISA, 1)],
      undefined,
      60_000,
    );

    expect(totals.totalAmountPaisa).toBe(
      totals.subtotalPaisa + totals.shippingPaisa - totals.couponDiscountPaisa,
    );
  });

  it("charges a coupon on an order that also gets free delivery", () => {
    // A ৳3,000 order with a 20% coupon and free delivery. The customer
    // pays ৳2,400 — the coupon comes off the goods, and the delivery
    // is free.
    const totals = calculateOrderTotals(
      [line("p1", FREE_SHIPPING_THRESHOLD_PAISA, 1)],
      undefined,
      60_000,
    );

    expect(totals.subtotalPaisa).toBe(FREE_SHIPPING_THRESHOLD_PAISA);
    expect(totals.shippingPaisa).toBe(0);
    expect(totals.couponDiscountPaisa).toBe(60_000);
    expect(totals.discountAmountPaisa).toBe(FLAT_SHIPPING_PAISA + 60_000);
    expect(totals.totalAmountPaisa).toBe(240_000);
  });

  it("does not let a coupon push an order below the free-delivery threshold", () => {
    // A 20% coupon on a ৳3,100 order takes it to ৳2,480 — below the
    // threshold. The threshold is judged on the *undiscounted* subtotal,
    // so the delivery stays free rather than the coupon *adding* ৳80 of
    // delivery to the order.
    const totals = calculateOrderTotals(
      [line("p1", FREE_SHIPPING_THRESHOLD_PAISA + 10_000, 1)],
      undefined,
      62_000,
    );

    expect(totals.shippingPaisa).toBe(0);
    expect(totals.totalAmountPaisa).toBe(248_000);
  });

  it("charges the delivery on an order below the threshold", () => {
    const totals = calculateOrderTotals(
      [line("p1", 100_000, 1)],
      undefined,
      10_000,
    );

    expect(totals.shippingPaisa).toBe(FLAT_SHIPPING_PAISA);
    expect(totals.totalAmountPaisa).toBe(100_000 + FLAT_SHIPPING_PAISA - 10_000);
  });

  it("never returns a negative total", () => {
    // A coupon far larger than the order. The discount is capped at the
    // subtotal, so the customer pays the delivery and nothing more —
    // the total cannot go below zero, and the shop cannot end up owing
    // the customer money.
    const totals = calculateOrderTotals(
      [line("p1", 1_000, 1)],
      undefined,
      10_000_000,
    );

    expect(totals.couponDiscountPaisa).toBe(1_000);
    expect(totals.totalAmountPaisa).toBe(FLAT_SHIPPING_PAISA);
    expect(totals.totalAmountPaisa).toBeGreaterThanOrEqual(0);
  });
});

describe("formatPaisa", () => {
  it("formats whole taka", () => {
    expect(formatPaisa(245000)).toBe("৳2,450");
  });

  it("formats poisha", () => {
    expect(formatPaisa(245050)).toBe("৳2,450.50");
  });

  it("formats zero", () => {
    expect(formatPaisa(0)).toBe("৳0");
  });

  it("formats a negative amount", () => {
    expect(formatPaisa(-245000)).toBe("-৳2,450");
  });

  it("formats a single-digit paisa with a leading zero", () => {
    expect(formatPaisa(245005)).toBe("৳2,450.05");
  });
});
