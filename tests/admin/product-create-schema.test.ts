import { describe, expect, it } from "vitest";

import { productCreateSchema } from "@/lib/validation/admin";

/**
 * The product creation body.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The admin product form sends a body that a human would call complete.
 * This schema is what decides whether that body is accepted.
 *
 * The bug this file exists for was a **mismatch between the form and the
 * schema**, and it was invisible until the form was filled in:
 *
 *   • The form sends `climateTips: null` for an empty field — because
 *     "no climate tips" is what an empty text field means.
 *   • The schema wanted a **string** and was only `.optional()`, not
 *     `.nullable()`.
 *   • So `null` was refused, the request failed validation, and the
 *     admin was told "The request failed validation" — with no field
 *     named, on a form that looked complete.
 *
 * The `null` and "absent" pair is the whole point of these tests. A
 * field that is *optional* still has to accept the value a client
 * naturally sends for "the user left this blank" — otherwise the
 * optionality is a fiction and the schema rejects correct requests.
 *
 * The second half of the file pins the **other** direction: the schema
 * must still refuse what it should. A schema that accepts everything
 * fixes the error message by removing the error, which is not a fix.
 */
describe("the admin product form's body", () => {
  /**
   * The body the form sends when the admin fills in everything except
   * the optional fields.
   *
   * This is the shape that failed. It is spelled out here rather than
   * built, because the point of the test is that *this exact body* is
   * accepted.
   */
  const FORM_BODY = {
    name: "CeraVe Hydrating Facial Cleanser",
    description: "A gentle cleanser for normal to dry skin.",
    brand: null,
    categoryId: "cat-1234567890",
    pricePaisa: 95_000,
    discountPricePaisa: 80_000,
    stockQuantity: 10,
    ingredientTags: ["AHA", "NIACINAMIDE"],
    climateTips: null,
    images: [],
    badges: [],
  };

  it("accepts the body the form sends", () => {
    const result = productCreateSchema.safeParse(FORM_BODY);

    expect(result.success).toBe(true);
  });

  it("accepts a null climate tip", () => {
    // ── The bug ────────────────────────────────────────────────────────
    //
    // The column is `String?` and the service reads `?? null`, so
    // `null` has always meant "no climate tips" everywhere except
    // here.
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      climateTips: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a null description", () => {
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      description: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a null discount price", () => {
    // "No discount" is a real, ordinary state — the column is `Int?`.
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      discountPricePaisa: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a null brand", () => {
    // A product genuinely may have no brand.
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      brand: null,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a body with only the required fields", () => {
    // The minimum the form can send.
    const result = productCreateSchema.safeParse({
      name: "Minimal Product",
      categoryId: "cat-1234567890",
      pricePaisa: 50_000,
    });

    expect(result.success).toBe(true);
  });

  it("accepts every optional field being absent", () => {
    const result = productCreateSchema.safeParse({
      name: "Minimal Product",
      categoryId: "cat-1234567890",
      pricePaisa: 50_000,
    });

    expect(result.success).toBe(true);

    if (!result.success) return;

    // The defaults fill in the rest.
    expect(result.data.stockQuantity).toBe(0);
    expect(result.data.ingredientTags).toEqual([]);
    expect(result.data.images).toEqual([]);
    expect(result.data.badges).toEqual([]);
  });

  it("treats an empty string as no climate tips", () => {
    // The form sends `null`, but a client that sends `""` means the
    // same thing, and the schema trims it.
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      climateTips: "   ",
    });

    expect(result.success).toBe(true);

    if (!result.success) return;

    expect(result.data.climateTips).toBe("");
  });

  it("still refuses a missing name", () => {
    // The other direction. A schema that accepts everything fixes the
    // error message by removing the error, which is not a fix.
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      name: "   ",
    });

    expect(result.success).toBe(false);
  });

  it("still refuses a missing category", () => {
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      categoryId: "",
    });

    expect(result.success).toBe(false);
  });

  it("still refuses a negative price", () => {
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      pricePaisa: -1,
    });

    expect(result.success).toBe(false);
  });

  it("still refuses a fractional price", () => {
    // Money is an integer number of poisha.
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      pricePaisa: 95_000.5,
    });

    expect(result.success).toBe(false);
  });

  it("still refuses a negative stock", () => {
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      stockQuantity: -1,
    });

    expect(result.success).toBe(false);
  });

  it("still refuses a number where a string belongs", () => {
    // The form sends a string for `name`; a number is a different
    // shape entirely and must not be coerced.
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      name: 42,
    });

    expect(result.success).toBe(false);
  });

  it("still refuses an image reference that escapes the upload root", () => {
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      images: ["../../etc/passwd"],
    });

    expect(result.success).toBe(false);
  });

  it("still refuses a duplicate badge", () => {
    const result = productCreateSchema.safeParse({
      ...FORM_BODY,
      badges: ["New Arrival", "new arrival"],
    });

    expect(result.success).toBe(false);
  });
});
