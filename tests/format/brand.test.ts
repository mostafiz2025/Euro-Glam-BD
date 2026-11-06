import { describe, expect, it } from "vitest";

import {
  KNOWN_BRANDS,
  MAX_BRAND_LENGTH,
  canonicalBrand,
  displayBrand,
  isKnownBrand,
  splitBrandAndTitle,
} from "@/lib/format/brand";
import { productCreateSchema } from "@/lib/validation/admin";

/**
 * The brand vocabulary and the name derivation.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The brand is now a **stored, editable field** — `Product.brand`. The
 * derivation from the name survives as the **fallback**, for a product
 * written before the column existed or one whose brand was never set.
 *
 * So two properties matter, and they are different:
 *
 *   1. The **derivation** must never produce a *wrong* brand. A wrong
 *      brand is worse than no brand: a customer reading a card labelled
 *      "The" would know something was broken.
 *   2. The **stored** brand always wins over the derived one. An admin
 *      who deliberately set "Bioderma" on a product named "CeraVe
 *      Serum" must keep that choice.
 */
describe("splitBrandAndTitle", () => {
  it("splits a registered brand prefix", () => {
    expect(splitBrandAndTitle("CeraVe Hydrating Facial Cleanser")).toEqual({
      brand: "CeraVe",
      title: "Hydrating Facial Cleanser",
    });
  });

  it("prefers the longest registered prefix", () => {
    // "The Ordinary" is 13 characters; "The" is not in the registry at
    // all, so a naive first-word split would brand this "The".
    const split = splitBrandAndTitle("The Ordinary Niacinamide 10% + Zinc 1%");

    expect(split.brand).toBe("The Ordinary");
    expect(split.title).toBe("Niacinamide 10% + Zinc 1%");
  });

  it("prefers the longest prefix when two brands share a prefix", () => {
    // "Musta Makeup" and "Musta Baby" both start with "Musta". The
    // longer one must win.
    expect(splitBrandAndTitle("Musta Baby Lip Balm").brand).toBe("Musta Baby");
    expect(splitBrandAndTitle("Musta Makeup Lipstick").brand).toBe(
      "Musta Makeup",
    );
  });

  it("returns no brand for an unregistered prefix", () => {
    const split = splitBrandAndTitle("Some Unknown Brand Hydrating Cream");

    expect(split.brand).toBeNull();
    expect(split.title).toBe("Some Unknown Brand Hydrating Cream");
  });

  it("does not match a brand that is not followed by whitespace", () => {
    const split = splitBrandAndTitle("Ceramide Cream");

    expect(split.brand).toBeNull();
    expect(split.title).toBe("Ceramide Cream");
  });

  it("does not match a brand that appears mid-name", () => {
    const split = splitBrandAndTitle("Hydrating Cream by Bioderma");

    expect(split.brand).toBeNull();
    expect(split.title).toBe("Hydrating Cream by Bioderma");
  });

  it("matches case-insensitively", () => {
    expect(splitBrandAndTitle("CERAVE Hydrating Cream").brand).toBe("CeraVe");
  });

  it("collapses internal whitespace", () => {
    const split = splitBrandAndTitle("  CeraVe   Hydrating   Cream  ");

    expect(split.brand).toBe("CeraVe");
    expect(split.title).toBe("Hydrating Cream");
  });

  it("keeps the whole name when the name is only the brand", () => {
    const split = splitBrandAndTitle("CeraVe");

    expect(split.brand).toBeNull();
    expect(split.title).toBe("CeraVe");
  });

  it("handles an empty name", () => {
    expect(splitBrandAndTitle("")).toEqual({ brand: null, title: "" });
    expect(splitBrandAndTitle("   ")).toEqual({ brand: null, title: "" });
  });

  it("splits every registered brand", () => {
    for (const brand of KNOWN_BRANDS) {
      const split = splitBrandAndTitle(`${brand} Sample Product`);

      expect(split.brand).toBe(brand);
      expect(split.title).toBe("Sample Product");
    }
  });
});

describe("canonicalBrand", () => {
  it("folds a known brand to its registry spelling", () => {
    expect(canonicalBrand("cerave")).toBe("CeraVe");
    expect(canonicalBrand("  THE ORDINARY  ")).toBe("The Ordinary");
  });

  it("returns a custom brand in its trimmed, collapsed form", () => {
    expect(canonicalBrand("  New   Skin  ")).toBe("New Skin");
  });

  it("returns null for an empty brand", () => {
    expect(canonicalBrand("")).toBeNull();
    expect(canonicalBrand("   ")).toBeNull();
  });
});

describe("isKnownBrand", () => {
  it("recognises a registered brand case-insensitively", () => {
    expect(isKnownBrand("bioderma")).toBe(true);
    expect(isKnownBrand("BIODERMA")).toBe(true);
  });

  it("does not recognise a custom brand", () => {
    expect(isKnownBrand("New Skin")).toBe(false);
  });
});

describe("the brand vocabulary", () => {
  it("holds no duplicates, in any casing", () => {
    const folded = KNOWN_BRANDS.map((brand) => brand.toLowerCase());

    expect(new Set(folded).size).toBe(folded.length);
  });

  it("holds no blank or whitespace-only brand", () => {
    for (const brand of KNOWN_BRANDS) {
      expect(brand.trim()).toBe(brand);
      expect(brand.length).toBeGreaterThan(0);
    }
  });

  it("holds no brand longer than the column allows", () => {
    // The column is `VARCHAR(80)`. A registered brand longer than that
    // would fail to store — and the failure would happen at the
    // database, on a save, rather than at the picker, where the admin
    // could see it.
    for (const brand of KNOWN_BRANDS) {
      expect(brand.length).toBeLessThanOrEqual(MAX_BRAND_LENGTH);
    }
  });

  it("registers every brand the storefront's carousel shows", () => {
    // The carousel used to carry its own copy of the brand list, and
    // the two had already drifted. The carousel now reads the `Brand`
    // table, which the seed populates from `KNOWN_BRANDS` — so the
    // check that keeps them honest is against the **seeded rows**.
    //
    // That check needs the database, so it lives in the integration
    // suite (`tests/integration/discovery.test.ts`). What is asserted
    // here is the property that makes it hold: the registry is the
    // single source of truth, and the canonical spelling it holds is
    // the spelling the `Brand` table is seeded with.
    for (const brand of KNOWN_BRANDS) {
      expect(canonicalBrand(brand)).toBe(brand);
    }
  });
});

describe("the brand validation schema", () => {
  it("accepts a known brand in any casing", () => {
    const parsed = productCreateSchema.safeParse({
      name: "A test product",
      categoryId: "cat-1",
      pricePaisa: 1000,
      brand: "cerave",
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.brand).toBe("CeraVe");
    }
  });

  it("accepts a custom brand", () => {
    const parsed = productCreateSchema.safeParse({
      name: "A test product",
      categoryId: "cat-1",
      pricePaisa: 1000,
      brand: "New Skin",
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.brand).toBe("New Skin");
    }
  });

  it("accepts no brand at all", () => {
    const parsed = productCreateSchema.safeParse({
      name: "A test product",
      categoryId: "cat-1",
      pricePaisa: 1000,
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.brand).toBeUndefined();
    }
  });

  it("accepts an explicitly null brand", () => {
    const parsed = productCreateSchema.safeParse({
      name: "A test product",
      categoryId: "cat-1",
      pricePaisa: 1000,
      brand: null,
    });

    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.brand).toBeNull();
    }
  });

  it("refuses an empty brand", () => {
    // An empty string is not the same as "no brand". "No brand" is
    // `null` or absent; an empty string is a value that would be
    // stored as an empty label and rendered as a blank line.
    const parsed = productCreateSchema.safeParse({
      name: "A test product",
      categoryId: "cat-1",
      pricePaisa: 1000,
      brand: "   ",
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a brand longer than the column", () => {
    const parsed = productCreateSchema.safeParse({
      name: "A test product",
      categoryId: "cat-1",
      pricePaisa: 1000,
      brand: "x".repeat(MAX_BRAND_LENGTH + 1),
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a brand exactly at the length limit", () => {
    const parsed = productCreateSchema.safeParse({
      name: "A test product",
      categoryId: "cat-1",
      pricePaisa: 1000,
      brand: "x".repeat(MAX_BRAND_LENGTH),
    });

    expect(parsed.success).toBe(true);
  });
});

describe("displayBrand", () => {
  it("prefers the stored brand over the derived one", () => {
    // An admin deliberately set "Bioderma" on a product named
    // "CeraVe Serum". The stored choice wins — the derivation is only
    // ever a fallback.
    expect(displayBrand("Bioderma", "CeraVe Hydrating Cream")).toBe(
      "Bioderma",
    );
  });

  it("falls back to the derivation when the brand is null", () => {
    expect(displayBrand(null, "Vichy Aqualia Thermal Water")).toBe("Vichy");
  });

  it("falls back to the derivation when the brand is undefined", () => {
    expect(displayBrand(undefined, "CeraVe Hydrating Cream")).toBe("CeraVe");
  });

  it("falls back to the derivation when the brand is blank", () => {
    expect(displayBrand("   ", "CeraVe Hydrating Cream")).toBe("CeraVe");
  });

  it("returns null when there is neither a stored brand nor a derivation", () => {
    expect(displayBrand(null, "Something Unregistered")).toBeNull();
  });
});
