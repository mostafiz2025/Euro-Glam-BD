import { describe, expect, it } from "vitest";

import {
  MAX_PRODUCT_CONCERNS,
  productCreateSchema,
  productUpdateSchema,
} from "@/lib/validation/admin";

/**
 * The "Shop by Concern" validation.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * A concern is the **vocabulary of a browse**: a product that carries
 * "acne" appears on the acne page. So the slug list must be:
 *
 *   1. **Optional** — a product may carry no concerns, and a caller
 *      that does not care about the field need not name it.
 *   2. **Lowercase and slug-shaped** — the storefront builds its links
 *      from the slug, so "Fine Lines" and "fine-lines" must not be two
 *      different concerns.
 *   3. **Free of duplicates** — "acne" twice is one concern stored
 *      twice.
 *   4. **Bounded** — four concerns is a focused product; twenty is a
 *      product in every list on the site.
 *
 * Note what is *not* checked here: whether the concern **exists**. The
 * vocabulary is a table, so a slug can only be checked against the
 * `SkinConcern` table — which is the service's job, not the schema's.
 * The schema can only check the *shape* of a slug.
 */

/**
 * A valid product body, with the concern list overridden per test.
 */
function body(concernSlugs?: unknown): Record<string, unknown> {
  return {
    name: "CeraVe Hydrating Facial Cleanser",
    description: "A gentle cleanser.",
    categoryId: "ckq1example0000000000abc",
    pricePaisa: 95000,
    stockQuantity: 5,
    ingredientTags: [],
    images: [],
    ...(concernSlugs === undefined ? {} : { concernSlugs }),
  };
}

describe("productCreateSchema — concern slugs", () => {
  it("leaves the concerns alone when the field is absent", () => {
    expect(productCreateSchema.parse(body()).concernSlugs).toBeUndefined();
  });

  it("accepts a list of slugs", () => {
    const parsed = productCreateSchema.parse(
      body(["acne", "oil-control", "fine-lines"]),
    );

    expect(parsed.concernSlugs).toEqual(["acne", "oil-control", "fine-lines"]);
  });

  it("accepts an empty list", () => {
    expect(productCreateSchema.parse(body([])).concernSlugs).toEqual([]);
  });

  it("lowercases a slug", () => {
    expect(productCreateSchema.parse(body(["ACNE"])).concernSlugs).toEqual([
      "acne",
    ]);
  });

  it("trims a slug", () => {
    expect(productCreateSchema.parse(body(["  acne  "])).concernSlugs).toEqual([
      "acne",
    ]);
  });

  it("refuses a slug with spaces", () => {
    expect(() => productCreateSchema.parse(body(["fine lines"]))).toThrow();
  });

  it("refuses a slug with a leading or trailing hyphen", () => {
    expect(() => productCreateSchema.parse(body(["-acne"]))).toThrow();
    expect(() => productCreateSchema.parse(body(["acne-"]))).toThrow();
  });

  it("refuses a slug with a double hyphen", () => {
    expect(() => productCreateSchema.parse(body(["fine--lines"]))).toThrow();
  });

  it("refuses an empty slug", () => {
    expect(() => productCreateSchema.parse(body(["   "]))).toThrow();
  });

  it("refuses an over-long slug", () => {
    expect(() => productCreateSchema.parse(body(["a".repeat(101)]))).toThrow();
  });

  it("refuses a duplicate slug", () => {
    expect(() => productCreateSchema.parse(body(["acne", "acne"]))).toThrow();
  });

  it("refuses two spellings of the same slug", () => {
    // Both normalise to "acne", so the list holds it twice.
    expect(() => productCreateSchema.parse(body(["acne", "ACNE"]))).toThrow();
  });

  it("refuses more concerns than the cap", () => {
    const tooMany = Array.from(
      { length: MAX_PRODUCT_CONCERNS + 1 },
      (_, index) => `concern-${index}`,
    );

    expect(() => productCreateSchema.parse(body(tooMany))).toThrow();
  });

  it("accepts exactly the cap", () => {
    const atCap = Array.from(
      { length: MAX_PRODUCT_CONCERNS },
      (_, index) => `concern-${index}`,
    );

    expect(productCreateSchema.parse(body(atCap)).concernSlugs).toHaveLength(
      MAX_PRODUCT_CONCERNS,
    );
  });

  it("rejects a non-array", () => {
    expect(() => productCreateSchema.parse(body("acne"))).toThrow();
  });
});

describe("productUpdateSchema — concern slugs", () => {
  it("leaves the concerns alone when the field is absent", () => {
    expect(productUpdateSchema.parse({ name: "A new name" }).concernSlugs).toBeUndefined();
  });

  it("accepts a list of slugs", () => {
    expect(
      productUpdateSchema.parse({ concernSlugs: ["acne", "texture"] }).concernSlugs,
    ).toEqual(["acne", "texture"]);
  });

  it("accepts an empty list, which clears the concerns", () => {
    expect(productUpdateSchema.parse({ concernSlugs: [] }).concernSlugs).toEqual([]);
  });

  it("refuses a duplicate slug", () => {
    expect(() =>
      productUpdateSchema.parse({ concernSlugs: ["acne", "acne"] }),
    ).toThrow();
  });

  it("refuses more concerns than the cap", () => {
    const tooMany = Array.from(
      { length: MAX_PRODUCT_CONCERNS + 1 },
      (_, index) => `concern-${index}`,
    );

    expect(() => productUpdateSchema.parse({ concernSlugs: tooMany })).toThrow();
  });
});
