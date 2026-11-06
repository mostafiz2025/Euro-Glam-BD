import { CouponDiscountType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  couponStatus,
  normaliseCouponCode,
} from "@/lib/admin/coupons";

/**
 * The coupon rules that are pure.
 *
 * These are the functions the **service** and the **API** both depend
 * on, so they are tested without a database. The properties they lock
 * down are:
 *
 *   1. The status is derived from the current time, not stored — so a
 *      coupon that expires while the database sits idle still reads as
 *      expired.
 *   2. The three reasons a coupon cannot be used are **different
 *      facts**, and an admin must be able to tell them apart.
 *   3. The code is normalised, so "eid2026" and "EID2026" cannot
 *      become two coupons.
 */

/**
 * A fixed "now", so the tests do not depend on the wall clock.
 */
const NOW = new Date("2026-10-28T12:00:00.000Z");

/**
 * Builds a coupon-shaped object for the status function.
 */
function coupon(overrides: {
  readonly isActive?: boolean;
  readonly expiresAt?: Date;
  readonly usageLimit?: number | null;
  readonly usageCount?: number;
} = {}) {
  return {
    isActive: overrides.isActive ?? true,
    expiresAt: overrides.expiresAt ?? new Date("2026-12-31T00:00:00.000Z"),
    usageLimit:
      overrides.usageLimit === undefined ? null : overrides.usageLimit,
    usageCount: overrides.usageCount ?? 0,
  };
}

describe("couponStatus", () => {
  it("reads a live coupon as ACTIVE", () => {
    expect(couponStatus(coupon(), NOW)).toBe("ACTIVE");
  });

  it("reads a switched-off coupon as INACTIVE", () => {
    expect(couponStatus(coupon({ isActive: false }), NOW)).toBe("INACTIVE");
  });

  it("reads a coupon past its expiry as EXPIRED", () => {
    expect(
      couponStatus(
        coupon({ expiresAt: new Date("2026-10-01T00:00:00.000Z") }),
        NOW,
      ),
    ).toBe("EXPIRED");
  });

  it("treats the exact expiry instant as expired", () => {
    // The expiry is a deadline, not a start. A coupon that expires at
    // 12:00:00 is not redeemable at 12:00:00.
    expect(
      couponStatus(coupon({ expiresAt: NOW }), NOW),
    ).toBe("EXPIRED");
  });

  it("reads a coupon at its usage limit as EXHAUSTED", () => {
    expect(
      couponStatus(coupon({ usageLimit: 10, usageCount: 10 }), NOW),
    ).toBe("EXHAUSTED");
  });

  it("reads a coupon over its usage limit as EXHAUSTED", () => {
    expect(
      couponStatus(coupon({ usageLimit: 10, usageCount: 14 }), NOW),
    ).toBe("EXHAUSTED");
  });

  it("does not call a coupon exhausted when it has no limit", () => {
    // A coupon with no usage limit is never exhausted, however many
    // times it has been redeemed. This is the case that a naive
    // `usageCount >= usageLimit` check would get wrong.
    expect(
      couponStatus(coupon({ usageLimit: null, usageCount: 9999 }), NOW),
    ).toBe("ACTIVE");
  });

  it("reports INACTIVE ahead of EXPIRED", () => {
    // A coupon that is switched off *and* past its expiry is both. The
    // admin switched it off, so that is the fact worth surfacing — it
    // is the one they can act on.
    expect(
      couponStatus(
        coupon({
          isActive: false,
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
        NOW,
      ),
    ).toBe("INACTIVE");
  });

  it("reports EXPIRED ahead of EXHAUSTED", () => {
    // Same rule: the clock running out is a fact about the calendar,
    // and the limit being hit is a fact about redemptions. The clock is
    // the one that explains why the code stopped working.
    expect(
      couponStatus(
        coupon({
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
          usageLimit: 5,
          usageCount: 5,
        }),
        NOW,
      ),
    ).toBe("EXPIRED");
  });
});

describe("normaliseCouponCode", () => {
  it("folds a lowercase code to uppercase", () => {
    expect(normaliseCouponCode("eid2026")).toBe("EID2026");
  });

  it("strips the surrounding whitespace", () => {
    expect(normaliseCouponCode("  EID2026  ")).toBe("EID2026");
  });

  it("is idempotent", () => {
    const once = normaliseCouponCode("  eid2026 ");

    expect(normaliseCouponCode(once)).toBe(once);
  });

  it("leaves an already-normalised code alone", () => {
    expect(normaliseCouponCode("EID-2026")).toBe("EID-2026");
  });
});

describe("the coupon discount types", () => {
  it("has exactly the two types the database declares", () => {
    // The type is a closed set. A third type would need a migration, a
    // validation rule and a way to render it — so the count is
    // asserted rather than assumed.
    expect(Object.values(CouponDiscountType)).toEqual([
      "PERCENTAGE",
      "FIXED",
    ]);
  });
});
