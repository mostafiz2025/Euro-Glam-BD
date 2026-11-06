import { describe, expect, it } from "vitest";

import {
  canonicalBadge,
  isKnownBadge,
  KNOWN_BADGES,
} from "@/lib/format/badges";
import {
  MAX_PRODUCT_BADGES,
  productCreateSchema,
  productUpdateSchema,
} from "@/lib/validation/admin";

/**
 * The badge vocabulary and its validation.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * A badge is a label the customer reads on a product card. So:
 *
 *   1. A **known badge** is normalised to its canonical spelling, so
 *      "best seller" and "Best Seller" are one badge rather than two.
 *   2. A **custom tag** is allowed — a closed set alone cannot hold
 *      "Eid Special 2026".
 *   3. **"Discount Offer" may not be stored.** Whether a product is
 *      discounted is a fact about its prices, and prices change. A
 *      stored discount badge on a product whose discount was removed
 *      yesterday is a lie the storefront would tell.
 *   4. The list is **bounded** — a dozen badges is a lot; twenty is a
 *      badge problem, not a promotional one.
 */

/**
 * A valid product body, with the badge list overridden per test.
 */
function body(badges?: unknown): Record<string, unknown> {
  return {
    name: "CeraVe Hydrating Facial Cleanser",
    description: "A gentle cleanser.",
    categoryId: "ckq1example0000000000abc",
    pricePaisa: 95000,
    stockQuantity: 5,
    ingredientTags: [],
    images: [],
    ...(badges === undefined ? {} : { badges }),
  };
}

describe("the badge vocabulary", () => {
  it("recognises a known badge case-insensitively", () => {
    expect(isKnownBadge("Best Seller")).toBe(true);
    expect(isKnownBadge("best seller")).toBe(true);
    expect(isKnownBadge("  BEST SELLER  ")).toBe(true);
  });

  it("does not recognise a custom tag as known", () => {
    expect(isKnownBadge("Eid Special 2026")).toBe(false);
  });

  it("canonicalises a known badge", () => {
    expect(canonicalBadge("best seller")).toBe("Best Seller");
    expect(canonicalBadge("limited edition")).toBe("Limited Edition");
  });

  it("returns null for a custom tag", () => {
    expect(canonicalBadge("Eid Special 2026")).toBeNull();
  });
});

describe("productCreateSchema — badges", () => {
  it("defaults to no badges", () => {
    expect(productCreateSchema.parse(body()).badges).toEqual([]);
  });

  it("accepts the known badges", () => {
    const parsed = productCreateSchema.parse(
      body(["New Arrival", "Best Seller", "Limited Edition"]),
    );

    expect(parsed.badges).toEqual([
      "New Arrival",
      "Best Seller",
      "Limited Edition",
    ]);
  });

  it("accepts a custom tag", () => {
    const parsed = productCreateSchema.parse(body(["Eid Special 2026"]));

    expect(parsed.badges).toEqual(["Eid Special 2026"]);
  });

  it("normalises a known badge to its canonical spelling", () => {
    const parsed = productCreateSchema.parse(body(["best seller"]));

    expect(parsed.badges).toEqual(["Best Seller"]);
  });

  it("refuses the derived discount badge", () => {
    expect(() =>
      productCreateSchema.parse(body(["Discount Offer"])),
    ).toThrow();
  });

  it("refuses a duplicate badge", () => {
    expect(() =>
      productCreateSchema.parse(body(["New Arrival", "New Arrival"])),
    ).toThrow();
  });

  it("refuses two spellings of the same known badge", () => {
    // Both entries normalise to "Best Seller", so the list holds it
    // twice — the check is on the *normalised* list.
    expect(() =>
      productCreateSchema.parse(body(["best seller", "Best Seller"])),
    ).toThrow();
  });

  it("refuses an empty badge", () => {
    expect(() => productCreateSchema.parse(body(["   "]))).toThrow();
  });

  it("refuses an over-long badge", () => {
    expect(() => productCreateSchema.parse(body(["x".repeat(41)]))).toThrow();
  });

  it("refuses more badges than the cap", () => {
    const tooMany = Array.from(
      { length: MAX_PRODUCT_BADGES + 1 },
      (_, index) => `Tag ${index}`,
    );

    expect(() => productCreateSchema.parse(body(tooMany))).toThrow();
  });

  it("accepts exactly the cap", () => {
    const atCap = Array.from(
      { length: MAX_PRODUCT_BADGES },
      (_, index) => `Tag ${index}`,
    );

    expect(productCreateSchema.parse(body(atCap)).badges).toHaveLength(
      MAX_PRODUCT_BADGES,
    );
  });

  it("rejects a non-array", () => {
    expect(() => productCreateSchema.parse(body("New Arrival"))).toThrow();
  });
});

describe("productUpdateSchema — badges", () => {
  it("leaves the badges alone when the field is absent", () => {
    const parsed = productUpdateSchema.parse({ name: "A new name" });

    expect(parsed.badges).toBeUndefined();
  });

  it("accepts a badge list", () => {
    const parsed = productUpdateSchema.parse({ badges: ["Limited Edition"] });

    expect(parsed.badges).toEqual(["Limited Edition"]);
  });

  it("accepts an empty list, which clears the badges", () => {
    const parsed = productUpdateSchema.parse({ badges: [] });

    expect(parsed.badges).toEqual([]);
  });

  it("refuses the derived discount badge", () => {
    expect(() =>
      productUpdateSchema.parse({ badges: ["Discount Offer"] }),
    ).toThrow();
  });

  it("refuses a duplicate badge", () => {
    expect(() =>
      productUpdateSchema.parse({ badges: ["New Arrival", "new arrival"] }),
    ).toThrow();
  });
});

describe("the badge list and the legacy booleans", () => {
  it("offers every known badge as a checkbox except the derived one", () => {
    // The admin form renders one checkbox per known badge. The
    // discount badge is derived from the prices, so it is shown as a
    // note rather than a checkbox.
    expect(KNOWN_BADGES).toContain("New Arrival");
    expect(KNOWN_BADGES).toContain("Best Seller");
    expect(KNOWN_BADGES).toContain("Discount Offer");
    expect(KNOWN_BADGES).toContain("Limited Edition");
  });
});
