import { describe, expect, it } from "vitest";

import {
  adminProductQuerySchema,
  productCreateSchema,
  productDeleteSchema,
  productUpdateSchema,
} from "@/lib/validation/admin";

/**
 * The product CRUD validation schemas.
 *
 * The rules under test are the same everywhere else in the codebase:
 *
 *   1. An invalid field is **rejected**, never silently ignored.
 *   2. Free text is **bounded** — a name is not a document.
 *   3. A price is a **whole number of poisha**, never a float.
 *   4. A partial update changes **only what it names**.
 *   5. A stock change is a **signed delta that is not zero** — "change
 *      the stock by zero" is not a change.
 *   6. A discount price may not exceed the price.
 */

/**
 * A plausible entity id — a cuid is 25 lowercase alphanumeric chars.
 */
const entityId = "ckq1example0000000000abc";

describe("productCreateSchema", () => {
  const valid = {
    name: "A brightening serum",
    categoryId: entityId,
    pricePaisa: 95000,
  };

  it("accepts a minimal product", () => {
    const parsed = productCreateSchema.parse(valid);

    expect(parsed.name).toBe("A brightening serum");
    expect(parsed.pricePaisa).toBe(95000);
  });

  it("defaults the stock to zero", () => {
    const parsed = productCreateSchema.parse(valid);

    // A new product with no stated stock has none. Defaulting to
    // anything else would invent units on the shelf.
    expect(parsed.stockQuantity).toBe(0);
  });

  it("defaults the flags and the lists", () => {
    const parsed = productCreateSchema.parse(valid);

    expect(parsed.ingredientTags).toEqual([]);
    expect(parsed.images).toEqual([]);
    expect(parsed.badges).toEqual([]);

    // The legacy booleans are **optional** now, because the badge list
    // is the source of truth for the promotional labels. A client that
    // sends only the list must not also be made to send a boolean that
    // says the same thing.
    expect(parsed.isNewArrival).toBeUndefined();
    expect(parsed.isBestSeller).toBeUndefined();
  });

  it("requires a name", () => {
    expect(() => productCreateSchema.parse({ ...valid, name: "" })).toThrow();
  });

  it("rejects a name that is only whitespace", () => {
    expect(() => productCreateSchema.parse({ ...valid, name: "   " })).toThrow();
  });

  it("rejects a name longer than 160 characters", () => {
    expect(() =>
      productCreateSchema.parse({ ...valid, name: "x".repeat(161) }),
    ).toThrow();
  });

  it("requires a category", () => {
    expect(() =>
      productCreateSchema.parse({ name: "x", pricePaisa: 1000 }),
    ).toThrow();
  });

  it("rejects a negative price", () => {
    expect(() =>
      productCreateSchema.parse({ ...valid, pricePaisa: -1 }),
    ).toThrow();
  });

  it("rejects a fractional price", () => {
    // Money is an integer count of poisha. A float cannot be stored
    // without a rounding decision that two systems might make
    // differently.
    expect(() =>
      productCreateSchema.parse({ ...valid, pricePaisa: 950.5 }),
    ).toThrow();
  });

  it("rejects a negative stock", () => {
    expect(() =>
      productCreateSchema.parse({ ...valid, stockQuantity: -1 }),
    ).toThrow();
  });

  it("accepts a storage key as an image", () => {
    // The `images` column holds **storage adapter keys**, not URLs. A
    // `.url()` check here would have rejected every key the upload
    // pipeline produces — and the pipeline is the only way an image
    // gets into the catalogue now.
    const parsed = productCreateSchema.parse({
      ...valid,
      images: ["products/2026/10/9f2c1a7b4e5d6c8a0b1c2d3e4f5a6b7c.png"],
    });

    expect(parsed.images).toEqual([
      "products/2026/10/9f2c1a7b4e5d6c8a0b1c2d3e4f5a6b7c.png",
    ]);
  });

  it("accepts a legacy absolute URL as an image", () => {
    // Rows written before the upload pipeline existed hold absolute
    // URLs, and `imageUrl()` passes them through untouched. Rejecting
    // them would make those products unsaveable — an admin opening one
    // to fix a typo would get a 400 and no way to save.
    const parsed = productCreateSchema.parse({
      ...valid,
      images: ["https://cdn.example.com/serum.jpg"],
    });

    expect(parsed.images).toEqual(["https://cdn.example.com/serum.jpg"]);
  });

  it("rejects an image key that escapes the upload root", () => {
    // A parent-directory segment is a path-traversal attempt, not a
    // typo. It is refused on the way in rather than at render time.
    expect(() =>
      productCreateSchema.parse({
        ...valid,
        images: ["products/../../etc/passwd.png"],
      }),
    ).toThrow();
  });

  it("normalises a legacy absolute filesystem path into a storage key", () => {
    // The seeded catalogue holds the **absolute path on the machine
    // that uploaded the file**. Joining it onto `/uploads` produced a
    // URL that resolved to nothing, so those products showed their
    // placeholder while the image sat on disk.
    //
    // The path is rewritten to the key it was pointing at. The file
    // has not moved; only the reference is corrected. And because the
    // rewrite happens in the schema, saving a legacy product repairs
    // it — no migration script, and no risk of touching a row by
    // mistake.
    const parsed = productCreateSchema.parse({
      ...valid,
      images: [
        "C:\\Users\\someone\\Euro Glam BD\\public\\uploads\\products\\serum.jpg",
      ],
    });

    expect(parsed.images).toEqual(["products/serum.jpg"]);
  });

  it("normalises a legacy path on update too", () => {
    const parsed = productUpdateSchema.parse({
      images: [
        "C:\\Users\\someone\\Euro Glam BD\\public\\uploads\\products\\serum.jpg",
      ],
    });

    expect(parsed.images).toEqual(["products/serum.jpg"]);
  });

  it("leaves an absolute path outside the uploads root alone", () => {
    // A path that is not one of ours is not ours to rewrite, and
    // guessing at it would be worse than leaving it alone. It is
    // refused rather than silently mangled.
    expect(() =>
      productCreateSchema.parse({
        ...valid,
        images: ["C:\\Windows\\System32\\config.png"],
      }),
    ).toThrow();
  });

  it("rejects an image key with a null byte", () => {
    expect(() =>
      productCreateSchema.parse({
        ...valid,
        images: ["products/2026/10/evil\u0000.png"],
      }),
    ).toThrow();
  });

  it("rejects an empty image reference", () => {
    expect(() =>
      productCreateSchema.parse({ ...valid, images: [""] }),
    ).toThrow();
  });

  it("rejects too many images", () => {
    expect(() =>
      productCreateSchema.parse({
        ...valid,
        images: Array.from(
          { length: 21 },
          (_, i) => `products/2026/10/${i}.png`,
        ),
      }),
    ).toThrow();
  });

  it("rejects a description longer than 2000 characters", () => {
    expect(() =>
      productCreateSchema.parse({ ...valid, description: "x".repeat(2001) }),
    ).toThrow();
  });
});

describe("productUpdateSchema", () => {
  it("accepts an empty update", () => {
    // Every field is optional. An update that changes nothing is a
    // no-op, and the service decides whether that is an error — not
    // the schema.
    expect(() => productUpdateSchema.parse({})).not.toThrow();
  });

  it("accepts a single field", () => {
    const parsed = productUpdateSchema.parse({ name: "A new name" });

    expect(parsed.name).toBe("A new name");
    expect(parsed.pricePaisa).toBeUndefined();
  });

  it("accepts a stock delta", () => {
    expect(productUpdateSchema.parse({ stockDelta: -3 }).stockDelta).toBe(-3);
    expect(productUpdateSchema.parse({ stockDelta: 7 }).stockDelta).toBe(7);
  });

  it("rejects a zero stock delta", () => {
    // "Change the stock by zero" is not a change.
    expect(() => productUpdateSchema.parse({ stockDelta: 0 })).toThrow();
  });

  it("rejects a fractional stock delta", () => {
    expect(() => productUpdateSchema.parse({ stockDelta: 1.5 })).toThrow();
  });

  it("rejects an out-of-range stock delta", () => {
    expect(() => productUpdateSchema.parse({ stockDelta: 10_001 })).toThrow();
    expect(() => productUpdateSchema.parse({ stockDelta: -10_001 })).toThrow();
  });

  it("allows a null discount price — that is how a discount is removed", () => {
    const parsed = productUpdateSchema.parse({ discountPricePaisa: null });

    expect(parsed.discountPricePaisa).toBeNull();
  });

  it("rejects a discount price above the price", () => {
    expect(() =>
      productUpdateSchema.parse({
        pricePaisa: 100000,
        discountPricePaisa: 120000,
      }),
    ).toThrow();
  });

  it("allows a discount price below the price", () => {
    expect(() =>
      productUpdateSchema.parse({
        pricePaisa: 100000,
        discountPricePaisa: 80000,
      }),
    ).not.toThrow();
  });

  it("allows the discount price to equal the price", () => {
    expect(() =>
      productUpdateSchema.parse({
        pricePaisa: 100000,
        discountPricePaisa: 100000,
      }),
    ).not.toThrow();
  });

  it("rejects a reason longer than 500 characters", () => {
    expect(() =>
      productUpdateSchema.parse({ reason: "x".repeat(501) }),
    ).toThrow();
  });
});

describe("productDeleteSchema", () => {
  it("defaults the mode to archive", () => {
    // Archive is the default delete, because a hard delete is usually
    // impossible — the order history references the product.
    const parsed = productDeleteSchema.parse({
      confirmName: "A serum",
      reason: "Discontinued",
    });

    expect(parsed.mode).toBe("archive");
  });

  it("accepts the hard mode", () => {
    const parsed = productDeleteSchema.parse({
      confirmName: "A serum",
      reason: "Never sold",
      mode: "hard",
    });

    expect(parsed.mode).toBe("hard");
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      productDeleteSchema.parse({
        confirmName: "A serum",
        reason: "x",
        mode: "obliterate",
      }),
    ).toThrow();
  });

  it("requires a confirmation name", () => {
    expect(() =>
      productDeleteSchema.parse({ reason: "Discontinued" }),
    ).toThrow();
  });

  it("requires a reason", () => {
    // A deletion is the one admin action that leaves nothing behind to
    // inspect, so the record of why is the only thing that remains.
    expect(() =>
      productDeleteSchema.parse({ confirmName: "A serum" }),
    ).toThrow();
  });

  it("rejects an empty reason", () => {
    expect(() =>
      productDeleteSchema.parse({ confirmName: "A serum", reason: "   " }),
    ).toThrow();
  });

  it("rejects a reason longer than 500 characters", () => {
    expect(() =>
      productDeleteSchema.parse({
        confirmName: "A serum",
        reason: "x".repeat(501),
      }),
    ).toThrow();
  });
});

describe("adminProductQuerySchema", () => {
  it("accepts the ARCHIVED filter", () => {
    const parsed = adminProductQuerySchema.parse({ stock: "ARCHIVED" });

    expect(parsed.stock).toBe("ARCHIVED");
  });

  it("defaults the stock filter to ALL", () => {
    expect(adminProductQuerySchema.parse({}).stock).toBe("ALL");
  });

  it("rejects an unknown stock filter", () => {
    expect(() => adminProductQuerySchema.parse({ stock: "SOLD_OUT" })).toThrow();
  });
});
