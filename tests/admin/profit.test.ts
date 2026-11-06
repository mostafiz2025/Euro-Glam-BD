import { describe, expect, it } from "vitest";

import {
  computeMarginPercentage,
  unitProfitPaisa,
} from "@/lib/admin/profit";

/**
 * The profit arithmetic.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The margin is the one number in the admin console that has to be
 * **exactly right** — it is what the shop decides its prices by — and it
 * is the one number with three separate ways to go wrong:
 *
 *   1. **The wrong base.** Profit is the selling price the customer
 *      actually paid, minus the cost, minus the discount given away. Not
 *      the list price, and not the cost alone.
 *   2. **The discount counted twice.** A product on sale is written to
 *      the order line at its *discounted* price, so the product's own
 *      discount is already out of the base. The coupon's share is the
 *      **only** extra discount that comes off the top.
 *   3. **A percentage against a zero base.** `profit ÷ 0` is a division
 *      by zero wearing a percentage's clothes. The answer is `null`, and
 *      the screen renders it as a dash — never `0%`, and never `+100%`.
 *
 * ── Why these are pure functions ──────────────────────────────────────────
 *
 * The arithmetic lives in `src/lib/admin/profit.ts` as pure functions,
 * with no database and no clock, precisely so it can be tested like this.
 * A margin that is computed inline in three different screens is three
 * different margins the first time somebody changes one of them.
 */
describe("the profit arithmetic", () => {
  describe("unitProfitPaisa", () => {
    it("subtracts the cost and the discount from the selling price", () => {
      // ৳1,000 charged, ৳600 cost, ৳100 of coupon given away.
      expect(unitProfitPaisa(100_000, 60_000, 10_000)).toBe(30_000);
    });

    it("is the full margin when nothing was discounted", () => {
      expect(unitProfitPaisa(100_000, 60_000, 0)).toBe(40_000);
    });

    it("goes negative when the discount takes the sale below cost", () => {
      // The finding the shop most needs to see: a product sold at a
      // loss.
      expect(unitProfitPaisa(100_000, 90_000, 20_000)).toBe(-10_000);
    });

    it("is zero at exactly break-even", () => {
      expect(unitProfitPaisa(100_000, 100_000, 0)).toBe(0);
    });

    it("counts a discount that exactly cancels the margin", () => {
      expect(unitProfitPaisa(100_000, 70_000, 30_000)).toBe(0);
    });
  });

  describe("computeMarginPercentage", () => {
    it("is the profit as a percentage of the revenue", () => {
      expect(computeMarginPercentage(40_000, 100_000)).toBe(40);
    });

    it("is negative when the shop sold at a loss", () => {
      expect(computeMarginPercentage(-10_000, 100_000)).toBe(-10);
    });

    it("is null when the revenue is zero", () => {
      // A percentage against a zero base is a division by zero wearing
      // a percentage's clothes. The screen renders it as a dash.
      expect(computeMarginPercentage(0, 0)).toBeNull();
    });

    it("is null when the revenue is negative", () => {
      expect(computeMarginPercentage(-1_000, -2_000)).toBeNull();
    });

    it("is zero at exactly break-even", () => {
      expect(computeMarginPercentage(0, 100_000)).toBe(0);
    });
  });

  describe("the interaction between the two", () => {
    it("agrees with the margin a screen would show", () => {
      /*
       * A ৳1,200 sale of a product that cost the shop ৳800, with ৳100
       * of coupon given away.
       *
       * The profit is ৳300, and the margin is 25% of the ৳1,200 the
       * customer was charged.
       */
      const sellingPaisa = 120_000;
      const purchasePaisa = 80_000;
      const discountPaisa = 10_000;

      const profit = unitProfitPaisa(
        sellingPaisa,
        purchasePaisa,
        discountPaisa,
      );

      expect(profit).toBe(30_000);
      expect(computeMarginPercentage(profit, sellingPaisa)).toBe(25);
    });
  });
});
