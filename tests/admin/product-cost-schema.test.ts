import { describe, expect, it } from "vitest";

import {
  productCreateSchema,
  productUpdateSchema,
} from "@/lib/validation/admin";

/**
 * The cost side of the product schemas.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The admin product form gained two fields — the **purchase price** and
 * the **selling price** — and the whole profit figure depends on them.
 * Two things have to hold for the feature to be worth anything:
 *
 *   1. A **blank** cost must be accepted, and must mean "not known".
 *      The form sends `null` for a field the admin left empty, and the
 *      column is nullable. If the schema refused `null`, the admin
 *      could not save a product whose cost has not been worked out yet —
 *      which is the state of every product in a shop that has just
 *      added cost tracking.
 *
 *   2. A **negative** or **fractional** cost must be refused. Money in
 *      this codebase is an integer number of poisha, and a cost is
 *      money. A float cost would put the profit figure outside the one
 *      money convention the schema holds to, and the drift would land
 *      directly on the margin — the number this feature exists to
 *      produce.
 *
 * The update schema's **nullable** pair is the other half. A partial
 * update that names `purchasePricePaisa: null` is a deliberate edit —
 * "the cost is no longer known" — while omitting the field entirely
 * means "leave the cost alone". The two must not be confused, because
 * one of them is a change and the other is not.
 */
describe("the product cost fields", () => {
  const CREATE_BODY = {
    name: "CeraVe Hydrating Facial Cleanser",
    categoryId: "cat-1234567890",
    pricePaisa: 95_000,
  };

  describe("on creation", () => {
    it("accepts a product with no cost recorded", () => {
      // The ordinary state of a catalogue that has just gained cost
      // tracking. The cost is "not known", not zero.
      const result = productCreateSchema.safeParse({
        ...CREATE_BODY,
        purchasePricePaisa: null,
        sellingPricePaisa: null,
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      expect(result.data.purchasePricePaisa).toBeNull();
      expect(result.data.sellingPricePaisa).toBeNull();
    });

    it("accepts a product with both costs recorded", () => {
      const result = productCreateSchema.safeParse({
        ...CREATE_BODY,
        purchasePricePaisa: 60_000,
        sellingPricePaisa: 95_000,
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      expect(result.data.purchasePricePaisa).toBe(60_000);
      expect(result.data.sellingPricePaisa).toBe(95_000);
    });

    it("accepts a zero cost", () => {
      // Zero is a real cost — a promotional item the shop got for
      // nothing. It is not the same as "not known", and the schema
      // must not confuse the two.
      const result = productCreateSchema.safeParse({
        ...CREATE_BODY,
        purchasePricePaisa: 0,
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      expect(result.data.purchasePricePaisa).toBe(0);
    });

    it("refuses a negative cost", () => {
      const result = productCreateSchema.safeParse({
        ...CREATE_BODY,
        purchasePricePaisa: -1,
      });

      expect(result.success).toBe(false);
    });

    it("refuses a fractional cost", () => {
      // Money is an integer number of poisha. A float cost would put
      // this column outside the one money convention the schema holds
      // to, and the drift would land on the profit figure.
      const result = productCreateSchema.safeParse({
        ...CREATE_BODY,
        purchasePricePaisa: 60_000.5,
      });

      expect(result.success).toBe(false);
    });

    it("refuses a cost beyond the maximum", () => {
      const result = productCreateSchema.safeParse({
        ...CREATE_BODY,
        purchasePricePaisa: 100_000_001,
      });

      expect(result.success).toBe(false);
    });
  });

  describe("on update", () => {
    it("accepts a null cost, which clears it", () => {
      const result = productUpdateSchema.safeParse({
        purchasePricePaisa: null,
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      expect(result.data.purchasePricePaisa).toBeNull();
    });

    it("accepts an absent cost, which leaves it alone", () => {
      const result = productUpdateSchema.safeParse({
        name: "A Renamed Product",
      });

      expect(result.success).toBe(true);

      if (!result.success) return;

      // `undefined` is not the same as `null` here: one is "leave it
      // alone", the other is "clear it".
      expect(result.data.purchasePricePaisa).toBeUndefined();
    });

    it("refuses a negative cost", () => {
      const result = productUpdateSchema.safeParse({
        purchasePricePaisa: -1,
      });

      expect(result.success).toBe(false);
    });

    it("refuses a fractional selling price", () => {
      const result = productUpdateSchema.safeParse({
        sellingPricePaisa: 95_000.5,
      });

      expect(result.success).toBe(false);
    });
  });
});
