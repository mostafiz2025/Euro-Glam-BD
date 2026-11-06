import { describe, expect, it } from "vitest";

import {
  MAX_PRODUCT_IMAGES,
  productCreateSchema,
  productUpdateSchema,
} from "@/lib/validation/admin";

/**
 * The product image list, as the API validates it.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The image list travels as **storage keys** — `products/2026/10/<hex>.png`
 * — not URLs, so the storage driver can be swapped without rewriting a
 * row. The schema is the boundary that says which references are
 * acceptable.
 *
 * The bug these exist for was a **false refusal**: a client that sent
 * `images: null` — meaning "no images" — was told "The request failed
 * validation", with no field named and nothing wrong with what the
 * admin had done. "No images" is an ordinary state, and a JSON body
 * can express it in two ways: `null` and an omitted field. Both have
 * to be accepted, or the optionality is a fiction.
 *
 * The second half pins the **cap**. It was written out three times —
 * here, in the upload service, and in the picker — so the three could
 * drift: the form would offer twenty-one images, the server would
 * store them, and the schema would refuse the product. The constant is
 * now defined once, in the validation layer, and the other two import
 * it.
 */

/**
 * A key of the shape the upload endpoint returns.
 */
const UPLOADED_KEY = "products/2026/10/9f2c1a7b4e5d6c8a0b1c2d3e4f5a6b7c.png";

/**
 * The minimum body the create schema accepts.
 */
const BASE = {
  name: "CeraVe Hydrating Facial Cleanser",
  categoryId: "cat-1234567890",
  pricePaisa: 95_000,
};

describe("the product image list", () => {
  describe("the create body", () => {
    it("accepts an uploaded key", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: [UPLOADED_KEY],
      });

      expect(result.success).toBe(true);
    });

    it("keeps the key as it was sent", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: [UPLOADED_KEY],
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      // The key is stored, not the URL — the driver can be swapped
      // without rewriting the row.
      expect(result.data.images).toEqual([UPLOADED_KEY]);
    });

    it("accepts several uploaded keys", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: [
          UPLOADED_KEY,
          "products/2026/10/11111111111111111111111111111111.png",
          "products/2026/10/22222222222222222222222222222222.png",
        ],
      });

      expect(result.success).toBe(true);
    });

    it("accepts an empty list", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: [],
      });

      expect(result.success).toBe(true);
    });

    it("accepts a null image list", () => {
      // ── The bug this file exists for ────────────────────────────────────
      //
      // "No images" is an ordinary state. A client that says `null`
      // means the same thing as one that says `[]`, and the two must
      // not disagree — otherwise a body that is perfectly reasonable
      // is refused with an error that names no field.
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: null,
      });

      expect(result.success).toBe(true);
    });

    it("reads a null image list as no images", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: null,
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      // The service writes `input.images` straight into the column, so
      // the normalisation has to happen in the schema.
      expect(result.data.images).toEqual([]);
    });

    it("accepts an absent image list", () => {
      const result = productCreateSchema.safeParse(BASE);

      expect(result.success).toBe(true);

      if (!result.success) return;

      expect(result.data.images).toEqual([]);
    });

    it("accepts a legacy absolute URL", () => {
      // Rows written before the upload pipeline existed hold absolute
      // URLs. Refusing them would make those products unsaveable.
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: ["https://cdn.example.com/serum.png"],
      });

      expect(result.success).toBe(true);
    });

    it("still refuses a key that escapes the upload root", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: ["../../etc/passwd"],
      });

      expect(result.success).toBe(false);
    });

    it("still refuses an empty key", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: [""],
      });

      expect(result.success).toBe(false);
    });

    it("still refuses a list over the cap", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, () => UPLOADED_KEY),
      });

      expect(result.success).toBe(false);
    });

    it("names the cap in the error", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, () => UPLOADED_KEY),
      });

      expect(result.success).toBe(false);

      if (result.success) return;

      // A bare "too big" does not tell the admin what the limit is.
      expect(result.error.issues[0].message).toContain(
        String(MAX_PRODUCT_IMAGES),
      );
    });

    it("accepts a list exactly at the cap", () => {
      const result = productCreateSchema.safeParse({
        ...BASE,
        images: Array.from({ length: MAX_PRODUCT_IMAGES }, () => UPLOADED_KEY),
      });

      expect(result.success).toBe(true);
    });
  });

  describe("the update body", () => {
    it("leaves the images alone when the field is absent", () => {
      const result = productUpdateSchema.safeParse({ name: "New name" });

      expect(result.success).toBe(true);

      if (!result.success) return;

      // An absent field must stay absent — that is what a partial
      // update means.
      expect(result.data.images).toBeUndefined();
    });

    it("clears the images when the list is null", () => {
      const result = productUpdateSchema.safeParse({ images: null });

      expect(result.success).toBe(true);

      if (!result.success) return;

      expect(result.data.images).toEqual([]);
    });

    it("replaces the images when a list is sent", () => {
      const result = productUpdateSchema.safeParse({
        images: [UPLOADED_KEY],
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      expect(result.data.images).toEqual([UPLOADED_KEY]);
    });

    it("agrees with the create schema about what a client may send", () => {
      // The two schemas must not disagree — otherwise a body that one
      // route accepts and the other refuses is a bug waiting to be hit.
      const bodies: Record<string, unknown>[] = [
        { images: [UPLOADED_KEY] },
        { images: [] },
        { images: null },
        { images: ["../../etc/passwd"] },
        { images: "not-a-list" },
      ];

      for (const body of bodies) {
        const created = productCreateSchema.safeParse({ ...BASE, ...body });
        const updated = productUpdateSchema.safeParse(body);

        expect(created.success).toBe(updated.success);
      }
    });
  });

  describe("the cap", () => {
    it("is the same number the upload service enforces", async () => {
      // The service imports the constant from here, so the two cannot
      // drift. This asserts the import actually resolves to one value.
      const service = await import("@/lib/admin/product-images");

      expect(service.MAX_PRODUCT_IMAGES).toBe(MAX_PRODUCT_IMAGES);
    });
  });
});
