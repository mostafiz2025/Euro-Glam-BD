import { describe, expect, it } from "vitest";

import {
  CARD_DETAIL_KEYS,
  MAX_ITEM_QUANTITY,
  addToCartSchema,
  checkoutSchema,
  productListQuerySchema,
  shippingAddressSchema,
  updateCartItemSchema,
} from "@/lib/validation/commerce";

/**
 * Commerce validation tests.
 *
 * The Zod schemas are the boundary between untrusted input and the
 * database. These tests prove the boundary holds:
 *
 *   1. Prices never appear in a request body.
 *   2. Quantities are bounded.
 *   3. Invalid filters are rejected rather than silently ignored.
 *   4. The shipping address is fully validated.
 */

describe("productListQuerySchema", () => {
  it("applies sensible defaults", () => {
    const query = productListQuerySchema.parse({});

    expect(query.page).toBe(1);
    expect(query.limit).toBe(20);
    expect(query.sort).toBe("newest");
    expect(query.search).toBeUndefined();
  });

  it("coerces numeric strings from a query string", () => {
    const query = productListQuerySchema.parse({
      page: "3",
      limit: "50",
      minPricePaisa: "1000",
    });

    expect(query.page).toBe(3);
    expect(query.limit).toBe(50);
    expect(query.minPricePaisa).toBe(1000);
  });

  it("coerces boolean strings", () => {
    expect(productListQuerySchema.parse({ inStock: "true" }).inStock).toBe(true);
    expect(productListQuerySchema.parse({ inStock: "false" }).inStock).toBe(false);
  });

  it("rejects an unknown sort order", () => {
    expect(() =>
      productListQuerySchema.parse({ sort: "cheapest-ever" }),
    ).toThrow();
  });

  it("rejects a negative page", () => {
    expect(() => productListQuerySchema.parse({ page: "-1" })).toThrow();
  });

  it("rejects a zero page", () => {
    expect(() => productListQuerySchema.parse({ page: "0" })).toThrow();
  });

  it("rejects a limit above the cap", () => {
    expect(() => productListQuerySchema.parse({ limit: "1000" })).toThrow();
  });

  it("rejects a non-numeric page", () => {
    expect(() => productListQuerySchema.parse({ page: "abc" })).toThrow();
  });

  it("rejects a negative price", () => {
    expect(() =>
      productListQuerySchema.parse({ minPricePaisa: "-100" }),
    ).toThrow();
  });

  it("rejects a malformed category slug", () => {
    expect(() =>
      productListQuerySchema.parse({ category: "Not A Slug!" }),
    ).toThrow();
  });

  it("normalises the category slug to lower case", () => {
    expect(productListQuerySchema.parse({ category: "Baby-Care" }).category).toBe(
      "baby-care",
    );
  });

  it("upper-cases the ingredient tag", () => {
    expect(
      productListQuerySchema.parse({ ingredient: "retinol" }).ingredient,
    ).toBe("RETINOL");
  });

  /*
   * The concern filter.
   *
   * It is a **separate** filter from `ingredient`, and the two are
   * normalised in opposite directions: an ingredient tag is a canonical
   * upper-case ID ("RETINOL"), and a concern slug is a lower-case slug
   * ("fine-lines"). Getting this wrong is not a cosmetic bug — a
   * lower-cased ingredient would match nothing, and an upper-cased slug
   * would match nothing either.
   */
  it("lower-cases the concern slug", () => {
    expect(
      productListQuerySchema.parse({ concern: "Fine-Lines" }).concern,
    ).toBe("fine-lines");
  });

  it("trims the concern slug", () => {
    expect(
      productListQuerySchema.parse({ concern: "  acne  " }).concern,
    ).toBe("acne");
  });

  it("leaves the concern unset when it is not supplied", () => {
    expect(productListQuerySchema.parse({}).concern).toBeUndefined();
  });

  it("rejects an empty concern", () => {
    expect(() => productListQuerySchema.parse({ concern: "   " })).toThrow();
  });

  it("rejects an over-long concern", () => {
    expect(() =>
      productListQuerySchema.parse({ concern: "a".repeat(200) }),
    ).toThrow();
  });

  it("keeps the ingredient and the concern as independent filters", () => {
    const query = productListQuerySchema.parse({
      ingredient: "retinol",
      concern: "acne",
    });

    expect(query.ingredient).toBe("RETINOL");
    expect(query.concern).toBe("acne");
  });

  it("rejects an empty search term", () => {
    expect(() => productListQuerySchema.parse({ search: "   " })).toThrow();
  });

  it("rejects an over-long search term", () => {
    expect(() =>
      productListQuerySchema.parse({ search: "a".repeat(200) }),
    ).toThrow();
  });
});

describe("addToCartSchema", () => {
  it("accepts a product id with a default quantity", () => {
    const body = addToCartSchema.parse({ productId: "prod_123" });

    expect(body.productId).toBe("prod_123");
    expect(body.quantity).toBe(1);
  });

  it("rejects a missing product id", () => {
    expect(() => addToCartSchema.parse({})).toThrow();
  });

  it("rejects a zero quantity", () => {
    expect(() =>
      addToCartSchema.parse({ productId: "p1", quantity: 0 }),
    ).toThrow();
  });

  it("rejects a negative quantity", () => {
    expect(() =>
      addToCartSchema.parse({ productId: "p1", quantity: -5 }),
    ).toThrow();
  });

  it("rejects a fractional quantity", () => {
    expect(() =>
      addToCartSchema.parse({ productId: "p1", quantity: 1.5 }),
    ).toThrow();
  });

  it("rejects a quantity above the cap", () => {
    expect(() =>
      addToCartSchema.parse({
        productId: "p1",
        quantity: MAX_ITEM_QUANTITY + 1,
      }),
    ).toThrow();
  });

  it("accepts the maximum quantity", () => {
    expect(
      addToCartSchema.parse({ productId: "p1", quantity: MAX_ITEM_QUANTITY })
        .quantity,
    ).toBe(MAX_ITEM_QUANTITY);
  });
});

describe("updateCartItemSchema", () => {
  it("requires a quantity", () => {
    expect(() => updateCartItemSchema.parse({})).toThrow();
  });

  it("rejects a zero quantity", () => {
    // A zero quantity is a removal, and removal has its own endpoint.
    // Allowing it here would make "update" and "delete" ambiguous.
    expect(() => updateCartItemSchema.parse({ quantity: 0 })).toThrow();
  });
});

describe("shippingAddressSchema", () => {
  const validAddress = {
    fullName: "Ayesha Rahman",
    phone: "01712345678",
    addressLine1: "House 12, Road 5, Dhanmondi",
    city: "Dhaka",
    district: "Dhaka",
    postalCode: "1209",
  };

  it("accepts a valid address", () => {
    const address = shippingAddressSchema.parse(validAddress);

    expect(address.fullName).toBe("Ayesha Rahman");
    expect(address.postalCode).toBe("1209");
  });

  it("normalises the phone number to the +880 form", () => {
    // The local form is normalised, so the same number cannot be stored
    // in two spellings across two different orders.
    const address = shippingAddressSchema.parse(validAddress);

    expect(address.phone).toBe("+8801712345678");
  });

  it("accepts the +880 form of the phone number", () => {
    const address = shippingAddressSchema.parse({
      ...validAddress,
      phone: "+8801712345678",
    });

    expect(address.phone).toBe("+8801712345678");
  });

  it("rejects an invalid phone number", () => {
    expect(() =>
      shippingAddressSchema.parse({ ...validAddress, phone: "12345" }),
    ).toThrow();
  });

  it("rejects a non-Bangladeshi phone number", () => {
    expect(() =>
      shippingAddressSchema.parse({ ...validAddress, phone: "+14155552671" }),
    ).toThrow();
  });

  it("rejects a malformed postal code", () => {
    expect(() =>
      shippingAddressSchema.parse({ ...validAddress, postalCode: "120" }),
    ).toThrow();
  });

  it("rejects a missing address line", () => {
    const rest = { ...validAddress };
    delete (rest as Partial<typeof validAddress>).addressLine1;

    expect(() => shippingAddressSchema.parse(rest)).toThrow();
  });

  it("rejects an over-long note", () => {
    expect(() =>
      shippingAddressSchema.parse({
        ...validAddress,
        notes: "x".repeat(600),
      }),
    ).toThrow();
  });

  it("strips whitespace from the fields", () => {
    const address = shippingAddressSchema.parse({
      ...validAddress,
      fullName: "  Ayesha Rahman  ",
      city: "  Dhaka ",
    });

    expect(address.fullName).toBe("Ayesha Rahman");
    expect(address.city).toBe("Dhaka");
  });
});

describe("checkoutSchema", () => {
  const validAddress = {
    fullName: "Ayesha Rahman",
    phone: "01712345678",
    addressLine1: "House 12, Road 5, Dhanmondi",
    city: "Dhaka",
    district: "Dhaka",
    postalCode: "1209",
  };

  it("defaults to COD and to not confirming conflicts", () => {
    const body = checkoutSchema.parse({ shippingAddress: validAddress });

    expect(body.paymentMethod).toBe("COD");
    expect(body.confirmConflicts).toBe(false);
  });

  it("accepts an explicit confirmation", () => {
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      confirmConflicts: true,
    });

    expect(body.confirmConflicts).toBe(true);
  });

  it("requires a shipping address", () => {
    expect(() => checkoutSchema.parse({})).toThrow();
  });

  it("ignores a client-supplied price", () => {
    // A client that tries to state the total must not be able to. The
    // schema has no such field, so the value is simply not carried into
    // the order — and the server computes the real figure.
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      totalAmountPaisa: 1,
      pricePaisa: 1,
    });

    expect(body).not.toHaveProperty("totalAmountPaisa");
    expect(body).not.toHaveProperty("pricePaisa");
  });

  /*
   * ── The payment method ────────────────────────────────────────────
   *
   * Four methods are accepted. Two of them — bKash and Nagad — are
   * settled by a transfer the customer makes before the order ships,
   * so they carry two references the shop reconciles against a
   * merchant statement. The other two do not, and the schema refuses
   * a reference that was handed to them.
   */

  it("accepts every supported payment method", () => {
    // bKash and Nagad are settled by a transfer, so they carry the two
    // references the shop reconciles against a merchant statement.
    for (const method of ["COD", "BKASH", "NAGAD", "CARD"] as const) {
      const body = checkoutSchema.parse({
        shippingAddress: validAddress,
        paymentMethod: method,
        ...(method === "BKASH" || method === "NAGAD"
          ? {
              paymentSenderNumber: "01712345678",
              paymentTransactionId: "8N3F2K9LM4",
            }
          : {}),
      });

      expect(body.paymentMethod).toBe(method);
    }
  });

  it("rejects a payment method that is not one of the four", () => {
    expect(() =>
      checkoutSchema.parse({
        shippingAddress: validAddress,
        paymentMethod: "PAYPAL",
      }),
    ).toThrow();
  });

  it("accepts a mobile-banking order WITHOUT a transfer reference", () => {
    // The transfer reference is quoted in the **gateway window**, not at
    // checkout. The customer picks bKash, presses "Place order", and the
    // gateway window opens next to the amount — that is where they have
    // the confirmation screen in their hand.
    //
    // So the order is created first, with the transfer reference still
    // empty, and the requirement that a mobile-banking order settles
    // with one is enforced at the **settle** (see `settleGatewayPayment`
    // and `tests/integration/payment-gateway.test.ts`).
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      paymentMethod: "BKASH",
    });

    expect(body.paymentMethod).toBe("BKASH");

    // The keys are **absent**, not empty — the schema must not
    // manufacture a transfer that was never quoted.
    expect("paymentSenderNumber" in body).toBe(false);
    expect("paymentTransactionId" in body).toBe(false);
  });

  it("accepts a mobile-banking order with both references", () => {
    // The fields are still accepted here, and still normalised — the
    // schema is the definition of what a valid reference *is*, and it
    // does not change shape because the moment the customer is asked
    // has moved.
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      paymentMethod: "NAGAD",
      paymentSenderNumber: "01712345678",
      paymentTransactionId: "8N3F2K9LM4",
    });

    expect(body.paymentSenderNumber).toBe("01712345678");
    expect(body.paymentTransactionId).toBe("8N3F2K9LM4");
  });

  it("refuses a transfer reference on a cash or card order", () => {
    // A recorded transfer that does not exist is worse than a missing
    // one — the admin would look for a payment that was never made.
    for (const method of ["COD", "CARD"] as const) {
      const result = checkoutSchema.safeParse({
        shippingAddress: validAddress,
        paymentMethod: method,
        paymentSenderNumber: "01712345678",
        paymentTransactionId: "8N3F2K9LM4",
      });

      expect(result.success).toBe(false);
    }
  });

  it("normalises the sender number to the local 01XXXXXXXXX form", () => {
    // The number is a reconciliation key. The merchant statements list
    // it as the customer typed it, so it is stored in the local form —
    // not in E.164, which would appear in no statement.
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      paymentMethod: "BKASH",
      paymentSenderNumber: "+8801712345678",
      paymentTransactionId: "8N3F2K9LM4",
    });

    expect(body.paymentSenderNumber).toBe("01712345678");
  });

  it("strips spacing from the sender number and the transaction ID", () => {
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      paymentMethod: "BKASH",
      paymentSenderNumber: "01712 3456 78",
      paymentTransactionId: "  8N3F2K9LM4  ",
    });

    expect(body.paymentSenderNumber).toBe("01712345678");
    expect(body.paymentTransactionId).toBe("8N3F2K9LM4");
  });

  it("rejects a sender number that is not a Bangladeshi mobile number", () => {
    const result = checkoutSchema.safeParse({
      shippingAddress: validAddress,
      paymentMethod: "BKASH",
      paymentSenderNumber: "12345",
      paymentTransactionId: "8N3F2K9LM4",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a transaction ID with characters that are not letters or digits", () => {
    const result = checkoutSchema.safeParse({
      shippingAddress: validAddress,
      paymentMethod: "BKASH",
      paymentSenderNumber: "01712345678",
      paymentTransactionId: "8N3F 2K9L#M4",
    });

    expect(result.success).toBe(false);
  });

  it("leaves the transfer keys absent when they were not sent", () => {
    // An absent key and a present-but-empty key are different requests.
    // The schema is written against the absent one, so it must not
    // manufacture an empty string.
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      paymentMethod: "COD",
    });

    expect(body).not.toHaveProperty("paymentSenderNumber");
    expect(body).not.toHaveProperty("paymentTransactionId");
  });

  /*
   * ── The card details ─────────────────────────────────────────────────
   *
   * The checkout renders a card form in the browser so the page reads
   * like a real gateway. The values stay in the browser: they are
   * validated client-side and then discarded.
   *
   * These tests are the **canary** for that guarantee. The schema is
   * not `.strict()`, so without the explicit refusal a card field that
   * leaked into the body would be *stripped in silence* — no error, no
   * warning, and no failing test. The requirement would then be
   * enforced only by the discipline of whoever wrote the
   * `JSON.stringify`, and a future edit could break it invisibly.
   *
   * So the boundary refuses the keys outright. A leak becomes a loud
   * 400 rather than a quiet success.
   */

  it("refuses a body that carries a card number", () => {
    const result = checkoutSchema.safeParse({
      shippingAddress: validAddress,
      paymentMethod: "CARD",
      cardNumber: "4242424242424242",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a body that carries any of the card details", () => {
    // Each key is refused on its own. A client that leaked only the
    // CVC — the shortest and the most obviously secret — would still be
    // caught.
    for (const key of CARD_DETAIL_KEYS) {
      const result = checkoutSchema.safeParse({
        shippingAddress: validAddress,
        paymentMethod: "CARD",
        [key]: "4242",
      });

      expect(result.success, `${key} should be refused`).toBe(false);
    }
  });

  it("refuses a card detail even on a cash order", () => {
    // The refusal is about the **value**, not about the method. A card
    // number on a cash order is just as much a leak.
    const result = checkoutSchema.safeParse({
      shippingAddress: validAddress,
      paymentMethod: "COD",
      cardNumber: "4242424242424242",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a card detail that is present but empty", () => {
    // "Present" is the test, not "non-empty". A client that sent
    // `cardNumber: ""` has still sent the key, and the guarantee is
    // about the key.
    const result = checkoutSchema.safeParse({
      shippingAddress: validAddress,
      paymentMethod: "CARD",
      cardNumber: "",
    });

    expect(result.success).toBe(false);
  });

  it("leaves the card keys absent from a legitimate body", () => {
    // The other half of the guarantee: a body with no card keys parses
    // cleanly, and the parsed output carries no card properties. This
    // is what the order service reads.
    const body = checkoutSchema.parse({
      shippingAddress: validAddress,
      paymentMethod: "CARD",
    });

    expect(body).not.toHaveProperty("cardNumber");
    expect(body).not.toHaveProperty("cardExpiry");
    expect(body).not.toHaveProperty("cardCvc");
    expect(body).not.toHaveProperty("cardHolderName");
  });

  it("still accepts every supported payment method", () => {
    // The refusal must not have narrowed the method contract. A card
    // order is still a card order — it just carries no card details.
    for (const method of ["COD", "BKASH", "NAGAD", "CARD"] as const) {
      const result = checkoutSchema.safeParse({
        shippingAddress: validAddress,
        paymentMethod: method,
        ...(method === "BKASH" || method === "NAGAD"
          ? {
              paymentSenderNumber: "01712345678",
              paymentTransactionId: "8N3F2K9LM4",
            }
          : {}),
      });

      expect(result.success, `${method} should still be accepted`).toBe(true);
    }
  });
});
