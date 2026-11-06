import { describe, expect, it } from "vitest";

import { productStockWhere } from "@/lib/admin/stats";
import { stockAdjustmentSchema } from "@/lib/validation/admin";

/**
 * The inventory service's pure logic.
 *
 * The write path itself — the transaction, the conditional update, the
 * audit entry — is proven against a real database in
 * `tests/integration/admin-products.test.ts`. What is tested here is
 * the two pieces of *decision* that a unit test can pin down exactly:
 *
 *   1. The stock filter's `where` shape. The list and the counts use
 *      the same shape, so a filter that matches nothing shows `0` in
 *      both places rather than looking like an empty shelf.
 *   2. The adjustment's validation. A delta of zero changes nothing; a
 *      delta of `NaN` is not a number of units; and the bound keeps a
 *      fat-fingered entry from taking the whole shelf.
 */
describe("productStockWhere", () => {
  it("matches everything for ALL", () => {
    expect(productStockWhere("ALL")).toEqual({});
  });

  it("matches products with units on the shelf for IN_STOCK", () => {
    expect(productStockWhere("IN_STOCK")).toEqual({
      stockQuantity: { gt: 0 },
    });
  });

  it("matches products with no units for OUT_OF_STOCK", () => {
    // `lte: 0` rather than `eq: 0`. A product whose stock has somehow
    // gone negative is not buyable either, and it must show up in the
    // out-of-stock band rather than in neither band at all.
    expect(productStockWhere("OUT_OF_STOCK")).toEqual({
      stockQuantity: { lte: 0 },
    });
  });

  it("matches only the low band for LOW_STOCK", () => {
    // The lower bound matters. A product with **zero** units is out of
    // stock, not low stock — the two bands must not overlap, or the
    // counts on the dashboard would double-count the same product.
    expect(productStockWhere("LOW_STOCK")).toEqual({
      stockQuantity: { gt: 0, lte: 5 },
    });
  });

  it("keeps the low and out-of-stock bands disjoint", () => {
    const low = productStockWhere("LOW_STOCK") as {
      stockQuantity: { gt: number; lte: number };
    };

    const out = productStockWhere("OUT_OF_STOCK") as {
      stockQuantity: { lte: number };
    };

    // The bands meet at the boundary but do not overlap: low is
    // `(0, 5]` — strictly greater than zero — and out of stock is
    // `(-inf, 0]`. A product with exactly zero units is out of stock,
    // not low stock, so the two counts never double-count a product.
    expect(low.stockQuantity.gt).toBe(0);
    expect(low.stockQuantity.lte).toBe(5);
    expect(out.stockQuantity.lte).toBe(0);
  });
});

describe("stockAdjustmentSchema", () => {
  it("accepts a positive adjustment", () => {
    const parsed = stockAdjustmentSchema.parse({ delta: 10 });

    expect(parsed.delta).toBe(10);
  });

  it("accepts a negative adjustment", () => {
    const parsed = stockAdjustmentSchema.parse({ delta: -3 });

    expect(parsed.delta).toBe(-3);
  });

  it("rejects an adjustment of zero", () => {
    // "Add zero" is not an action. Accepting it would write an audit
    // entry describing a change that did not happen.
    const result = stockAdjustmentSchema.safeParse({ delta: 0 });

    expect(result.success).toBe(false);
  });

  it("rejects a fractional adjustment", () => {
    // Stock is counted in whole units. Half a bottle is not a thing
    // the shelf holds.
    const result = stockAdjustmentSchema.safeParse({ delta: 2.5 });

    expect(result.success).toBe(false);
  });

  it("rejects an adjustment that is too large", () => {
    expect(stockAdjustmentSchema.safeParse({ delta: 100_001 }).success).toBe(
      false,
    );
    expect(stockAdjustmentSchema.safeParse({ delta: -100_001 }).success).toBe(
      false,
    );
  });

  it("accepts an adjustment at the bound", () => {
    expect(stockAdjustmentSchema.safeParse({ delta: 10_000 }).success).toBe(true);
    expect(stockAdjustmentSchema.safeParse({ delta: -10_000 }).success).toBe(
      true,
    );
  });

  it("accepts an optional reason", () => {
    const parsed = stockAdjustmentSchema.parse({
      delta: 5,
      reason: "Restocked from the back room",
    });

    expect(parsed.reason).toBe("Restocked from the back room");
  });

  it("rejects a reason that is too long", () => {
    const result = stockAdjustmentSchema.safeParse({
      delta: 5,
      reason: "x".repeat(501),
    });

    expect(result.success).toBe(false);
  });

  it("trims the reason", () => {
    const parsed = stockAdjustmentSchema.parse({
      delta: 5,
      reason: "  counted twice  ",
    });

    expect(parsed.reason).toBe("counted twice");
  });
});
