import { describe, expect, it } from "vitest";

import {
  couponDiscountPaisa,
  couponProblemMessage,
  couponStatus,
  normaliseCouponCode,
  type CouponTerms,
  type CouponValue,
} from "@/lib/coupons/rules";

/**
 * Coupon rule tests.
 *
 * These are the rules the **admin desk** and the **shopfront** both
 * import, so they are the one place a disagreement between "what the
 * offer says" and "what the customer is charged" could hide.
 *
 * The four properties that matter:
 *
 *   1. A coupon's status tells you *which* problem it has — inactive,
 *      expired, or exhausted — not just that it has one.
 *   2. A discount never exceeds the subtotal, so a total can never go
 *      negative.
 *   3. A percentage rounds to whole poisha, because money is integer
 *      poisha.
 *   4. A code is normalised, so " eid2026 " and "EID2026" are the same
 *      code and cannot become two coupons.
 */

/**
 * A fixed "now" so the clock never ticks mid-test.
 */
const NOW = new Date("2026-06-01T00:00:00.000Z");

/**
 * Builds a coupon's terms.
 */
function terms(overrides: Partial<CouponTerms> = {}): CouponTerms {
  return {
    isActive: true,
    expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    usageLimit: null,
    usageCount: 0,
    ...overrides,
  };
}

describe("couponStatus", () => {
  it("is ACTIVE for a live, unexpired, unexhausted coupon", () => {
    expect(couponStatus(terms(), NOW)).toBe("ACTIVE");
  });

  it("is INACTIVE when the admin switched it off", () => {
    expect(couponStatus(terms({ isActive: false }), NOW)).toBe("INACTIVE");
  });

  it("is EXPIRED once the clock passes the expiry", () => {
    const expired = terms({ expiresAt: new Date("2026-05-31T00:00:00.000Z") });
    expect(couponStatus(expired, NOW)).toBe("EXPIRED");
  });

  it("is EXPIRED at the exact expiry instant, not one tick after", () => {
    const atExpiry = terms({ expiresAt: NOW });
    expect(couponStatus(atExpiry, NOW)).toBe("EXPIRED");
  });

  it("is EXHAUSTED once usage reaches the limit", () => {
    const used = terms({ usageLimit: 10, usageCount: 10 });
    expect(couponStatus(used, NOW)).toBe("EXHAUSTED");
  });

  it("is not EXHAUSTED one below the limit", () => {
    const nearly = terms({ usageLimit: 10, usageCount: 9 });
    expect(couponStatus(nearly, NOW)).toBe("ACTIVE");
  });

  it("ignores the usage limit when there is no limit", () => {
    const unlimited = terms({ usageLimit: null, usageCount: 9_999 });
    expect(couponStatus(unlimited, NOW)).toBe("ACTIVE");
  });

  it("prefers INACTIVE over EXPIRED", () => {
    const off = terms({
      isActive: false,
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(couponStatus(off, NOW)).toBe("INACTIVE");
  });

  it("prefers EXPIRED over EXHAUSTED", () => {
    const both = terms({
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      usageLimit: 1,
      usageCount: 1,
    });
    expect(couponStatus(both, NOW)).toBe("EXPIRED");
  });
});

describe("couponProblemMessage", () => {
  it("has no message for an active coupon", () => {
    expect(couponProblemMessage("ACTIVE")).toBeNull();
  });

  it("names each problem distinctly", () => {
    const messages = [
      couponProblemMessage("INACTIVE"),
      couponProblemMessage("EXPIRED"),
      couponProblemMessage("EXHAUSTED"),
    ];

    expect(messages.every((message) => message !== null)).toBe(true);
    expect(new Set(messages).size).toBe(3);
  });
});

describe("normaliseCouponCode", () => {
  it("uppercases the code", () => {
    expect(normaliseCouponCode("eid2026")).toBe("EID2026");
  });

  it("trims the ends", () => {
    expect(normaliseCouponCode("  EID2026  ")).toBe("EID2026");
  });

  it("is idempotent", () => {
    const once = normaliseCouponCode(" eid2026 ");
    expect(normaliseCouponCode(once)).toBe(once);
  });
});

describe("couponDiscountPaisa", () => {
  const percentage: CouponValue = {
    discountType: "PERCENTAGE",
    percentOff: 20,
    amountOffPaisa: null,
  };

  const fixed: CouponValue = {
    discountType: "FIXED",
    percentOff: null,
    amountOffPaisa: 20_000,
  };

  it("takes a percentage of the subtotal", () => {
    expect(couponDiscountPaisa(percentage, 100_000)).toBe(20_000);
  });

  it("rounds a percentage to whole poisha", () => {
    // 33% of 101 poisha is 33.33 — it must land on a whole poisha.
    const third: CouponValue = {
      discountType: "PERCENTAGE",
      percentOff: 33,
      amountOffPaisa: null,
    };
    const discount = couponDiscountPaisa(third, 101);
    expect(Number.isInteger(discount)).toBe(true);
    expect(discount).toBe(33);
  });

  it("takes a fixed amount off the subtotal", () => {
    expect(couponDiscountPaisa(fixed, 100_000)).toBe(20_000);
  });

  it("never discounts more than the subtotal", () => {
    expect(couponDiscountPaisa(fixed, 5_000)).toBe(5_000);
  });

  it("never discounts a percentage more than the subtotal", () => {
    const huge: CouponValue = {
      discountType: "PERCENTAGE",
      percentOff: 150,
      amountOffPaisa: null,
    };
    expect(couponDiscountPaisa(huge, 10_000)).toBe(10_000);
  });

  it("is worth nothing on an empty subtotal", () => {
    expect(couponDiscountPaisa(percentage, 0)).toBe(0);
    expect(couponDiscountPaisa(fixed, 0)).toBe(0);
  });

  it("is worth nothing on a negative subtotal", () => {
    expect(couponDiscountPaisa(percentage, -100)).toBe(0);
  });

  it("is worth nothing when the percentage is missing", () => {
    const missing: CouponValue = {
      discountType: "PERCENTAGE",
      percentOff: null,
      amountOffPaisa: null,
    };
    expect(couponDiscountPaisa(missing, 100_000)).toBe(0);
  });

  it("is worth nothing when the fixed amount is missing", () => {
    const missing: CouponValue = {
      discountType: "FIXED",
      percentOff: null,
      amountOffPaisa: null,
    };
    expect(couponDiscountPaisa(missing, 100_000)).toBe(0);
  });

  it("leaves a total of zero or more for every subtotal", () => {
    const subtotals = [0, 1, 999, 100_000, 1_000_000];
    const coupons = [percentage, fixed];

    for (const subtotal of subtotals) {
      for (const coupon of coupons) {
        expect(subtotal - couponDiscountPaisa(coupon, subtotal)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
