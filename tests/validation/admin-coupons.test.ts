import { describe, expect, it } from "vitest";

import {
  adminAuditLogQuerySchema,
  adminCouponQuerySchema,
  auditActionFilterSchema,
  couponCreateSchema,
  couponDeactivateSchema,
  couponUpdateSchema,
} from "@/lib/validation/admin";

/**
 * The coupon and audit-log validation schemas.
 *
 * The rules under test are the same everywhere else in the codebase:
 *
 *   1. An invalid filter is **rejected**, never silently ignored.
 *   2. Money is an integer of poisha — never a float of taka.
 *   3. The expiry must be in the future. A coupon that has already
 *      expired is not a coupon anyone can use.
 *   4. The deactivation reason is **mandatory**, because a customer
 *      holding the code is entitled to an explanation.
 */

/**
 * A date far enough in the future that the test does not rot.
 */
const FUTURE = "2099-12-31T23:59:59.000Z";

/**
 * A date in the past.
 */
const PAST = "2020-01-01T00:00:00.000Z";

describe("couponCreateSchema", () => {
  it("accepts a percentage coupon", () => {
    const parsed = couponCreateSchema.parse({
      code: "EID2026",
      discountType: "PERCENTAGE",
      percentOff: 20,
      expiresAt: FUTURE,
    });

    expect(parsed.code).toBe("EID2026");
    expect(parsed.percentOff).toBe(20);
  });

  it("accepts a fixed-amount coupon", () => {
    const parsed = couponCreateSchema.parse({
      code: "FLAT150",
      discountType: "FIXED",
      amountOffPaisa: 15_000,
      expiresAt: FUTURE,
    });

    expect(parsed.amountOffPaisa).toBe(15_000);
  });

  it("defaults isActive to true", () => {
    const parsed = couponCreateSchema.parse({
      code: "EID2026",
      discountType: "PERCENTAGE",
      percentOff: 20,
      expiresAt: FUTURE,
    });

    expect(parsed.isActive).toBe(true);
  });

  it("rejects a code shorter than three characters", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "AB",
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("rejects a code with spaces", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID 2026",
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("rejects a code with punctuation", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID!2026",
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("accepts dashes and underscores in a code", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID-2026_NOW",
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: FUTURE,
      }),
    ).not.toThrow();
  });

  it("rejects a percentage of zero", () => {
    // A coupon worth nothing is not a coupon — it is a rounding error
    // with a code attached.
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        discountType: "PERCENTAGE",
        percentOff: 0,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("rejects a percentage above 100", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        discountType: "PERCENTAGE",
        percentOff: 101,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("rejects a fractional percentage", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        discountType: "PERCENTAGE",
        percentOff: 12.5,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("rejects a zero fixed amount", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "FLAT0",
        discountType: "FIXED",
        amountOffPaisa: 0,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("rejects an expiry in the past", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: PAST,
      }),
    ).toThrow();
  });

  it("rejects a usage limit below one", () => {
    // Zero would mean "nobody may use this", which is a different thing
    // from "no limit" — and an accidental zero would silently kill a
    // campaign.
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: FUTURE,
        usageLimit: 0,
      }),
    ).toThrow();
  });

  it("accepts an omitted usage limit", () => {
    const parsed = couponCreateSchema.parse({
      code: "EID2026",
      discountType: "PERCENTAGE",
      percentOff: 20,
      expiresAt: FUTURE,
    });

    expect(parsed.usageLimit).toBeUndefined();
  });

  it("accepts a null description", () => {
    // The admin form sends `null` for an empty description box, and a
    // coupon with no description is perfectly ordinary — so a schema
    // that accepted only a string would refuse the most common
    // creation there is.
    const parsed = couponCreateSchema.parse({
      code: "EID2026",
      description: null,
      discountType: "PERCENTAGE",
      percentOff: 20,
      expiresAt: FUTURE,
    });

    expect(parsed.description).toBeNull();
  });

  it("accepts an omitted description", () => {
    const parsed = couponCreateSchema.parse({
      code: "EID2026",
      discountType: "PERCENTAGE",
      percentOff: 20,
      expiresAt: FUTURE,
    });

    expect(parsed.description).toBeUndefined();
  });

  it("rejects an over-long description", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        description: "x".repeat(201),
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("rejects an unknown discount type", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        discountType: "BUY_ONE_GET_ONE",
        percentOff: 20,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("requires a code", () => {
    expect(() =>
      couponCreateSchema.parse({
        discountType: "PERCENTAGE",
        percentOff: 20,
        expiresAt: FUTURE,
      }),
    ).toThrow();
  });

  it("requires an expiry", () => {
    expect(() =>
      couponCreateSchema.parse({
        code: "EID2026",
        discountType: "PERCENTAGE",
        percentOff: 20,
      }),
    ).toThrow();
  });
});

describe("couponUpdateSchema", () => {
  it("accepts an empty body", () => {
    // Every field is optional — a partial update changes only what it
    // names. The *route* refuses an empty patch, because a save that
    // changes nothing is not a save.
    expect(couponUpdateSchema.parse({})).toEqual({});
  });

  it("accepts a single field", () => {
    const parsed = couponUpdateSchema.parse({ description: "Eid campaign" });

    expect(parsed.description).toBe("Eid campaign");
  });

  it("accepts an explicit null to clear the description", () => {
    const parsed = couponUpdateSchema.parse({ description: null });

    expect(parsed.description).toBeNull();
  });

  it("accepts an explicit null to clear the usage limit", () => {
    const parsed = couponUpdateSchema.parse({ usageLimit: null });

    expect(parsed.usageLimit).toBeNull();
  });

  it("accepts switching the coupon on", () => {
    const parsed = couponUpdateSchema.parse({ isActive: true });

    expect(parsed.isActive).toBe(true);
  });

  it("rejects a percentage of zero", () => {
    expect(() => couponUpdateSchema.parse({ percentOff: 0 })).toThrow();
  });

  it("rejects a percentage above 100", () => {
    expect(() => couponUpdateSchema.parse({ percentOff: 101 })).toThrow();
  });

  it("rejects an expiry in the past", () => {
    expect(() => couponUpdateSchema.parse({ expiresAt: PAST })).toThrow();
  });
});

describe("couponDeactivateSchema", () => {
  it("accepts a reason", () => {
    const parsed = couponDeactivateSchema.parse({
      reason: "The campaign ended early.",
    });

    expect(parsed.reason).toBe("The campaign ended early.");
  });

  it("trims the reason", () => {
    const parsed = couponDeactivateSchema.parse({
      reason: "   The campaign ended early.   ",
    });

    expect(parsed.reason).toBe("The campaign ended early.");
  });

  it("rejects an empty reason", () => {
    // The reason is mandatory: deactivating a coupon stops an
    // advertised discount working, and a customer holding that code is
    // entitled to an explanation.
    expect(() => couponDeactivateSchema.parse({ reason: "" })).toThrow();
  });

  it("rejects a whitespace-only reason", () => {
    expect(() => couponDeactivateSchema.parse({ reason: "   " })).toThrow();
  });

  it("rejects a missing reason", () => {
    expect(() => couponDeactivateSchema.parse({})).toThrow();
  });

  it("rejects an over-long reason", () => {
    expect(() =>
      couponDeactivateSchema.parse({ reason: "x".repeat(501) }),
    ).toThrow();
  });
});

describe("adminCouponQuerySchema", () => {
  it("defaults to the first page", () => {
    const parsed = adminCouponQuerySchema.parse({});

    expect(parsed.page).toBe(1);
  });

  it("coerces the page from a string", () => {
    const parsed = adminCouponQuerySchema.parse({ page: "3" });

    expect(parsed.page).toBe(3);
  });

  it("rejects a page below one", () => {
    expect(() => adminCouponQuerySchema.parse({ page: "0" })).toThrow();
  });

  it("rejects a fractional page", () => {
    expect(() => adminCouponQuerySchema.parse({ page: "1.5" })).toThrow();
  });

  it("accepts a search term", () => {
    const parsed = adminCouponQuerySchema.parse({ search: "EID" });

    expect(parsed.search).toBe("EID");
  });

  it("rejects an over-long search term", () => {
    expect(() =>
      adminCouponQuerySchema.parse({ search: "x".repeat(121) }),
    ).toThrow();
  });
});

describe("auditActionFilterSchema", () => {
  it("accepts every action in the enum", () => {
    // The schema lists the actions explicitly rather than deriving them
    // from Prisma, so a new enum member does not silently become
    // filterable until somebody adds it here on purpose. This test
    // keeps that promise honest in the other direction: the schema must
    // not lag behind the enum.
    const actions = [
      "REVIEW_APPROVED",
      "REVIEW_HIDDEN",
      "REVIEW_UNHIDDEN",
      "ORDER_STATUS_CHANGED",
      "ORDER_PAYMENT_STATUS_CHANGED",
      "ORDER_CANCELLED",
      "SMS_REMINDER_SWEEP",
      "SMS_REMINDER_SENT",
      "SMS_REMINDER_RESENT",
      "PRODUCT_STOCK_ADJUSTED",
      "PRODUCT_CREATED",
      "PRODUCT_UPDATED",
      "PRODUCT_DELETED",
      "AI_CONFIG_UPDATED",
      "COUPON_CREATED",
      "COUPON_UPDATED",
      "COUPON_DELETED",
      "CATEGORY_CREATED",
      "CATEGORY_UPDATED",
      "CATEGORY_DELETED",
      "CONCERN_CREATED",
      "CONCERN_UPDATED",
      "CONCERN_DELETED",
      "BRAND_CREATED",
      "BRAND_UPDATED",
      "BRAND_DELETED",
    ];

    for (const action of actions) {
      expect(auditActionFilterSchema.parse(action)).toBe(action);
    }
  });

  it("rejects an unknown action", () => {
    expect(() => auditActionFilterSchema.parse("PRODUCT_SAINTED")).toThrow();
  });
});

describe("adminAuditLogQuerySchema", () => {
  it("defaults to the first page", () => {
    const parsed = adminAuditLogQuerySchema.parse({});

    expect(parsed.page).toBe(1);
  });

  it("accepts an action filter", () => {
    const parsed = adminAuditLogQuerySchema.parse({
      action: "COUPON_CREATED",
    });

    expect(parsed.action).toBe("COUPON_CREATED");
  });

  it("rejects an unknown action filter", () => {
    // An unrecognised action is a 400, not a default. An admin who
    // filters for something the server does not recognise and gets back
    // an unfiltered list would have no way of knowing their filter was
    // ignored.
    expect(() =>
      adminAuditLogQuerySchema.parse({ action: "PRODUCT_SAINTED" }),
    ).toThrow();
  });

  it("accepts an entity-type filter", () => {
    const parsed = adminAuditLogQuerySchema.parse({ entityType: "coupon" });

    expect(parsed.entityType).toBe("coupon");
  });

  it("rejects an unknown entity-type filter", () => {
    expect(() =>
      adminAuditLogQuerySchema.parse({ entityType: "unicorn" }),
    ).toThrow();
  });

  it("accepts a search term", () => {
    const parsed = adminAuditLogQuerySchema.parse({ search: "Sarah" });

    expect(parsed.search).toBe("Sarah");
  });

  it("rejects an over-long search term", () => {
    expect(() =>
      adminAuditLogQuerySchema.parse({ search: "x".repeat(121) }),
    ).toThrow();
  });
});
