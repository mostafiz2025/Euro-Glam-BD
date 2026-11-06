import { z } from "zod";

import { bdPhoneSchema } from "./schemas";

/**
 * Validation schemas for the catalogue, cart and checkout APIs.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **Every value that reaches the database is validated here first.**
 *
 * A route handler never reads a field from the request body and passes it
 * straight to Prisma. The Zod schema is the single definition of what a
 * valid request looks like, and it is applied at the boundary — so a
 * malformed request cannot become a malformed row.
 *
 * Three rules in particular:
 *
 *  1. **Quantities are bounded.** A client asking for 999,999 units of a
 *     product would otherwise create an absurd cart and, at checkout,
 *     drive a stock decrement that locks a row for no reason.
 *  2. **Prices never come from the client.** The checkout body carries no
 *     price, no total, and no amount of any kind. The server computes
 *     every figure from the database. A client-supplied price is a
 *     vulnerability, not a convenience.
 *  3. **IDs are length-bounded strings.** Prisma's `cuid()` ids are short;
 *     an unbounded string in a `where` clause is at best a waste and at
 *     worst an injection-adjacent nuisance.
 */

/**
 * A Prisma cuid-style identifier.
 *
 * Cuid and cuid2 both match this pattern. The bound is generous enough for
 * any legitimate id and tight enough to reject garbage before it reaches
 * the query planner.
 */
export const entityIdSchema = z
  .string()
  .trim()
  .min(1, "An id is required.")
  .max(64, "That id is not valid.");

/**
 * A product id.
 */
export const productIdSchema = entityIdSchema;

/**
 * A category slug.
 *
 * Slugs are lowercase, hyphen-separated words — the shape every slug in
 * the catalogue already uses.
 */
export const categorySlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "A category is required.")
  .max(140, "That category is not valid.")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "That category is not valid.",
  );

/**
 * The maximum quantity of a single product in a cart or an order.
 *
 * 10 units of one skincare product is already an unusually large order.
 * The bound exists so a malicious or buggy client cannot create a cart
 * line with an absurd quantity.
 */
export const MAX_ITEM_QUANTITY = 10;

/**
 * The minimum quantity of a single product in a cart or an order.
 */
export const MIN_ITEM_QUANTITY = 1;

/**
 * A cart line quantity.
 */
export const quantitySchema = z
  .number()
  .int("Quantity must be a whole number.")
  .min(MIN_ITEM_QUANTITY, "Quantity must be at least 1.")
  .max(
    MAX_ITEM_QUANTITY,
    `You can order at most ${MAX_ITEM_QUANTITY} of a single product.`,
  );

/**
 * The query parameters for the product list endpoint.
 *
 * Every field is optional and bounded. `page` and `limit` are coerced from
 * the strings that arrive in a query string.
 */
export const productListQuerySchema = z.object({
  /**
   * A free-text search term.
   *
   * Matched against the product name and description with a
   * case-insensitive `contains`. The term is trimmed and length-bounded,
   * and the `%`/`_` characters that would otherwise act as SQL wildcards
   * inside a `contains` are escaped by the query builder.
   */
  search: z
    .string()
    .trim()
    .min(1, "Search cannot be empty.")
    .max(120, "That search term is too long.")
    .optional(),

  /** Filter by category slug. */
  category: categorySlugSchema.optional(),

  /** Filter by one or more ingredient tags. */
  ingredient: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "An ingredient is required.")
    .max(64, "That ingredient is not valid.")
    .optional(),

  /**
   * Filter by a **skin concern** — the "Shop by Concern" axis.
   *
   * The slug of a concern in the `SkinConcern` table, so the link is
   * `/products?concern=acne`.
   *
   * This is a **different** filter from `ingredient`, and both are
   * needed. The ingredient filter asks "what is in this product?"; the
   * concern filter asks "what is this product for?" — and a product
   * containing salicylic acid is not thereby an acne product.
   *
   * The slug is lower-cased, because that is the form the product
   * stores.
   */
  concern: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "A concern is required.")
    .max(100, "That concern is not valid.")
    .optional(),

  /** Show only new arrivals. */
  isNewArrival: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),

  /** Show only best sellers. */
  isBestSeller: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),

  /** Only products in stock. */
  inStock: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),

  /** Maximum price in poisha. */
  maxPricePaisa: z
    .coerce
    .number()
    .int("The price must be a whole number of poisha.")
    .nonnegative("The price cannot be negative.")
    .max(100_000_000, "That price is too large.")
    .optional(),

  /** Minimum price in poisha. */
  minPricePaisa: z
    .coerce
    .number()
    .int("The price must be a whole number of poisha.")
    .nonnegative("The price cannot be negative.")
    .max(100_000_000, "That price is too large.")
    .optional(),

  /** The sort order. */
  sort: z
    .enum([
      "newest",
      "oldest",
      "price-asc",
      "price-desc",
      "name-asc",
      "name-desc",
    ])
    .default("newest"),

  /** 1-based page number. */
  page: z.coerce.number().int().min(1).max(10_000).default(1),

  /** Rows per page. */
  limit: z.coerce.number().int().min(1).max(60).default(20),
});

export type ProductListQuery = z.infer<typeof productListQuerySchema>;

/**
 * The body for adding an item to the cart.
 */
export const addToCartSchema = z.object({
  productId: productIdSchema,
  quantity: quantitySchema.default(1),
});

export type AddToCartInput = z.infer<typeof addToCartSchema>;

/**
 * The body for updating a cart line.
 *
 * Only the quantity is editable. The product itself is fixed by the line's
 * id — changing what a line points at would break the price snapshot
 * logic at checkout.
 */
export const updateCartItemSchema = z.object({
  quantity: quantitySchema,
});

export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;

/**
 * The body for applying a coupon code to the cart.
 *
 * ── What is deliberately absent ───────────────────────────────────────────
 *
 * No discount amount, no percentage, no total. The client sends a **code**
 * and the server decides what it is worth, from the coupon's own terms in
 * the database. A client-supplied discount would be a number the client
 * made up — the same rule the checkout already follows for prices.
 *
 * The code is normalised to uppercase here, at the boundary, so that
 * "eid2026" and "EID2026" are the same request and the same stored value.
 * The identical normalisation is applied by the coupon rules, so the two
 * cannot disagree about which code was meant.
 */
export const couponCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Enter a discount code.")
    .max(40, "That code is too long.")
    .transform((value) => value.toUpperCase()),
});

export type CouponCodeInput = z.infer<typeof couponCodeSchema>;

/**
 * A postal code.
 *
 * Bangladeshi postal codes are 4 digits.
 */
export const postalCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{4}$/, "Enter a valid 4-digit postal code.");

/**
 * The shipping address for an order.
 *
 * Stored as JSON on `Order.shippingAddress`. The shape is validated here
 * because the column is untyped — this schema is the only thing standing
 * between a client and a malformed address row.
 */
export const shippingAddressSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Enter the recipient's full name.")
    .max(160, "That name is too long."),

  /**
   * The recipient's mobile number.
   *
   * Reuses `bdPhoneSchema` from the auth schemas rather than repeating
   * the pattern. That schema already handles every format a customer
   * actually types — `01712345678`, `+8801712345678`, `0171-2345678` —
   * and normalises them all to `+880XXXXXXXXX`, so the same phone number
   * cannot be stored in two different forms.
   */
  phone: bdPhoneSchema,

  addressLine1: z
    .string()
    .trim()
    .min(3, "Enter the street address.")
    .max(200, "That address is too long."),

  addressLine2: z
    .string()
    .trim()
    .max(200, "That address is too long.")
    .optional(),

  city: z
    .string()
    .trim()
    .min(2, "Enter the city or district.")
    .max(120, "That city name is too long."),

  district: z
    .string()
    .trim()
    .min(2, "Enter the district.")
    .max(120, "That district name is too long."),

  postalCode: postalCodeSchema,

  /**
   * Delivery notes from the customer.
   *
   * Free text, so it is length-bounded. The column is a plain `Json`
   * field holding a validated object — no markup is ever rendered from it
   * without escaping.
   */
  notes: z.string().trim().max(500, "Those notes are too long.").optional(),
});

export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

/**
 * The payment methods a customer can choose.
 *
 * These are the four values of the `PaymentMethod` enum, and they are
 * four different **settlement paths**, not four different buttons:
 *
 *   • `COD`   — cash collected by the courier on delivery.
 *   • `BKASH` — a bKash mobile-banking transfer.
 *   • `NAGAD` — a Nagad mobile-banking transfer.
 *   • `CARD`  — an online card payment.
 *
 * bKash and Nagad are separate values rather than one combined
 * "MOBILE BANKING" value because the shop **settles each transfer
 * against a specific operator's account**. A single combined value would
 * leave the admin unable to tell whose wallet to check, which is the one
 * thing the column has to answer.
 */
export const PAYMENT_METHODS = ["COD", "BKASH", "NAGAD", "CARD"] as const;

export type PaymentMethodInput = (typeof PAYMENT_METHODS)[number];

/**
 * The card fields the checkout must never send.
 *
 * ── Why these names are written down here ─────────────────────────────────
 *
 * The checkout renders a card form so the page reads like a real
 * gateway, and the values stay in the browser. They are collected,
 * formatted and validated client-side, and then discarded.
 *
 * These four names are the **boundary's** list of forbidden keys. The
 * client's card form has its own field names, and the two are kept
 * deliberately separate: this list is a security rule about what the
 * server will accept, and it does not depend on any component.
 *
 * A shop that stores a card number is a shop that has breached PCI DSS.
 * This shop stores the payment *method* and the gateway's own reference,
 * and nothing else.
 */
export const CARD_DETAIL_KEYS = [
  "cardNumber",
  "cardExpiry",
  "cardCvc",
  "cardHolderName",
] as const;

export type CardDetailKey = (typeof CARD_DETAIL_KEYS)[number];

/**
 * The payment methods that are settled by a mobile-banking transfer.
 *
 * These are the methods that carry a **transaction reference**: the
 * customer sends money first and quotes a TrxID, so the shop can match
 * the transfer against the order.
 *
 * The list is derived from `PAYMENT_METHODS` rather than written out
 * again, so a method added to the enum is one edit away from being
 * classified — and a method that is *not* in this list can never
 * accidentally demand a TrxID.
 */
export const MOBILE_BANKING_METHODS = ["BKASH", "NAGAD"] as const satisfies readonly PaymentMethodInput[];

/**
 * Whether a payment method is settled by a mobile-banking transfer.
 */
export function isMobileBankingMethod(
  method: string,
): method is (typeof MOBILE_BANKING_METHODS)[number] {
  return (MOBILE_BANKING_METHODS as readonly string[]).includes(method);
}

/**
 * The sender's mobile number on a mobile-banking transfer.
 *
 * ── Why this is NOT `bdPhoneSchema` ───────────────────────────────────────
 *
 * `bdPhoneSchema` normalises to `+880XXXXXXXXX`, which is right for a
 * **contact** number: the same person cannot be stored in two forms, and
 * the E.164 form is what an SMS gateway wants.
 *
 * This field is a different thing. It is a **reconciliation key** — the
 * admin looks it up in the bKash or Nagad merchant statement to find the
 * transfer. Those statements list the number exactly as the customer
 * typed it into the app: `01712345678`, `+8801712345678`, and so on.
 *
 * So the number is accepted in every format a customer might type and
 * stored in the **local `01XXXXXXXXX` form** — the format the operators
 * themselves display. Normalising to E.164 here would store a number
 * that appears in *no* statement, defeating the purpose of the column.
 *
 * The pattern accepts `+8801712345678`, `8801712345678`, `01712345678`
 * and `1712345678`, and requires a real Bangladeshi mobile prefix
 * (`1` followed by `3`–`9`) so a landline number cannot be submitted.
 */
export const senderNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine(
    (value) => /^(?:\+?880|0)?1[3-9]\d{8}$/.test(value),
    "Enter the sender's mobile number (e.g. 01712345678).",
  )
  .transform((value) => {
    // Strip a `+880` / `880` / `0` prefix and keep the local form.
    const national = value.replace(/^(?:\+?880|0)/, "");

    return `0${national}`;
  });

/**
 * The transaction ID on a mobile-banking transfer.
 *
 * The TrxID is what bKash and Nagad show on their confirmation screen —
 * a short alphanumeric string. It is the reference the shop quotes back
 * to the operator, so it is required and it is length-bounded.
 *
 * The pattern is deliberately permissive about *shape* and strict about
 * *presence*: the two operators do not use identical formats, and this
 * codebase should not be the thing that rejects a legitimate TrxID over
 * a formatting rule. What it does reject is anything with whitespace or
 * punctuation, which would be a paste error rather than a TrxID.
 */
export const transactionIdSchema = z
  .string()
  .trim()
  .min(4, "Enter the transaction ID (TrxID) from your confirmation screen.")
  .max(64, "That transaction ID is too long.")
  .regex(
    /^[A-Za-z0-9]+$/,
    "A transaction ID is letters and numbers only — check it against your confirmation screen.",
  )
  /**
   * Upper-cased.
   *
   * `abc123` and `ABC123` are the same TrxID typed two different ways,
   * and they must be **one value** in the database — matching on one
   * reconciliation query.
   *
   * The normalisation lives **here**, in the shared schema, rather than
   * in the checkout body's transform. It used to live in the transform,
   * which meant the rule applied only to the body that quoted the TrxID
   * at *placement*. Now that the reference is quoted at *settlement*,
   * a transform-local rule would have been silently dropped from the
   * settle path — and the two would have drifted, so a TrxID the
   * checkout accepted would be stored under a different key from the
   * same TrxID quoted in the gateway window.
   *
   * One schema, one rule, both boundaries.
   */
  .transform((value) => value.toUpperCase());

/**
 * The checkout request body.
 *
 * Note what is **absent**: no price, no total, no payment amount, no
 * product details. The body says *what* the customer wants delivered and
 * *where*; the server decides what it costs.
 */
export const checkoutSchema = z
  .object({
    shippingAddress: shippingAddressSchema,

    /**
     * The payment method.
     *
     * Defaults to `COD` — Cash on Delivery remains the platform's
     * primary and default payment method (DECISIONS.md #4), and it is
     * the only method that needs no further information from the
     * customer.
     */
    paymentMethod: z.enum(PAYMENT_METHODS).default("COD"),

    /**
     * The mobile number the transfer was sent FROM.
     *
     * **Optional here.** The transfer reference is quoted in the
     * **gateway window**, after the order is placed, and arrives with
     * the settle request instead. It is refused on a non-mobile-banking
     * order — see the `superRefine` below, and
     * `settleGatewayPayment` for the requirement that now lives at
     * settlement.
     *
     * The **shape** is validated here, on the field, rather than in the
     * transform: a malformed number is a malformed number whichever
     * method was chosen, and a field-level failure carries the field's
     * path, so the API's error mapper can point at it in the form.
     */
    paymentSenderNumber: senderNumberSchema.optional(),

    /**
     * The transaction ID the customer quoted from their confirmation
     * screen.
     *
     * Optional here, for the same reason as the sender number above —
     * and with the same converse rule: meaningless, and refused, on an
     * order that is not settled by a mobile-banking transfer.
     */
    paymentTransactionId: transactionIdSchema.optional(),

    /**
     * Whether the customer has confirmed a blocking ingredient conflict.
     *
     * Defaults to `false`, so the safe direction is the default. When the
     * cart contains a `BLOCK` conflict and this is not `true`, the
     * checkout is refused with a 409 that carries the conflict details
     * and the remedy. The customer reads it, decides, and confirms.
     *
     * This is the difference between the cart and the checkout. In the
     * cart, the customer can add a conflicting product and be warned —
     * they may well remove it. At checkout the order is about to be
     * created, so the warning has to be acknowledged first.
     */
    confirmConflicts: z.boolean().default(false),

    /**
     * An optional note attached to the order.
     */
    note: z.string().trim().max(500, "That note is too long.").optional(),

    /**
     * ── The card fields, which are never allowed ────────────────────────
     *
     * These four are declared **only so they can be refused**.
     *
     * They are declared as `z.unknown().optional()` rather than being
     * left out of the schema entirely, because a schema that does not
     * mention a key cannot check whether the key was present — and this
     * schema is not `.strict()`, so an unmentioned key is stripped in
     * silence rather than rejected.
     *
     * The `superRefine` below turns the presence of any of them into a
     * `400`. The **parsed output never contains them**: they are
     * refused before the transform runs, so a body that carries no card
     * keys produces a result with no card keys, and a body that does
     * carry them produces an error rather than an order.
     *
     * No card value is ever validated, transformed or passed on. It is
     * not merely ignored — it is refused.
     */
    cardNumber: z.unknown().optional(),
    cardExpiry: z.unknown().optional(),
    cardCvc: z.unknown().optional(),
    cardHolderName: z.unknown().optional(),
  })
  /**
   * ── The conditional rule ─────────────────────────────────────────────────
   *
   * A mobile-banking order **cannot be settled without a transaction
   * reference**, and it cannot be reconciled without a sender number. So
   * both are required when — and only when — the method is `BKASH` or
   * `NAGAD`.
   *
   * `superRefine` rather than a discriminated union, because the two
   * payment fields are **optional on the base schema** and the
   * conditional requirement has to be expressed across the whole object.
   * A union would have to repeat the address schema four times.
   *
   * And the converse is enforced too: a `COD` or `CARD` order may not
   * carry a transaction reference. A stray TrxID on a cash order is
   * either a client bug or a customer who changed their mind about the
   * method — and in both cases the shop must not record a transfer that
   * does not exist.
   */
  .superRefine((value, ctx) => {
    /*
     * ── The card details are refused outright ────────────────────────────
     *
     * A card number, an expiry, a CVC or a card holder name must never
     * reach this server. The checkout renders a card form in the
     * browser so the page reads like a real gateway — and the values
     * stay in the browser. They are not part of the request body, and
     * they are never stored.
     *
     * This branch is what makes that a **property of the schema** rather
     * than a property of the client's discipline.
     *
     * The reason it has to be here at all: this schema is **not
     * `.strict()`**, so Zod **strips** unknown keys rather than
     * rejecting them. Without this rule, a card field that leaked into
     * the body would be discarded in silence — no error, no warning, and
     * no failing test. The requirement would be enforced only by
     * whoever wrote the `JSON.stringify`, and a future edit could break
     * it invisibly.
     *
     * So the leak becomes a **loud 400**. The boundary refuses it, where
     * it cannot be forgotten.
     *
     * Note that the check fires only when a key is **present**. A body
     * that carries no card keys — which is every legitimate body — is
     * unaffected, and the keys are still absent from the parsed output.
     */
    for (const key of CARD_DETAIL_KEYS) {
      if (value[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Card details are never sent to the server.",
        });
      }
    }

    const isMobileBanking = isMobileBankingMethod(value.paymentMethod);

    /**
     * ── The transfer reference ─────────────────────────────────────────────
     *
     * **The requirement has moved.** The reference is no longer required
     * *here*, at order-placement time — it is required at **settlement**,
     * in `settleGatewayPayment`, which is where the customer is actually
     * looking at the amount they are about to send.
     *
     * The reason is the checkout page's shape. The page holds **only**
     * the payment selection: the customer picks bKash, presses "Place
     * order", and the gateway window opens. It is in the gateway window
     * that the TrxID is quoted — where the merchant, the order and the
     * exact total are on screen together, which is the moment a
     * customer actually has the confirmation screen in their hand.
     *
     * The order row still ends up carrying a complete, reconcilable
     * reference: the settle writes the sender number and the TrxID onto
     * the order as it marks it `PAID`. Only the *moment* at which the
     * customer is asked has moved.
     *
     * What is still enforced here is the **converse** — a cash or card
     * order may not carry a transfer reference. A stray TrxID on a cash
     * order is either a client bug or a customer who changed their mind
     * about the method, and in both cases the shop must not record a
     * transfer that does not exist.
     */
    if (!isMobileBanking) {
      if (
        value.paymentSenderNumber !== undefined &&
        value.paymentSenderNumber.trim() !== ""
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paymentSenderNumber"],
          message:
            "A sender number only applies to mobile banking payments.",
        });
      }

      if (
        value.paymentTransactionId !== undefined &&
        value.paymentTransactionId.trim() !== ""
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["paymentTransactionId"],
          message:
            "A transaction ID only applies to mobile banking payments.",
        });
      }
    }
  })
  /**
   * ── Normalising the two payment fields ──────────────────────────────────
   *
   * This runs **after** the `superRefine`, so the sender number is
   * validated before it is transformed.
   *
   * The `paymentSenderNumber` was already normalised to the local
   * `01XXXXXXXXX` form by `senderNumberSchema`, and the transaction ID
   * was upper-cased by `transactionIdSchema` — so that `abc123` and
   * `ABC123`, the same TrxID typed two different ways, are one value in
   * the database and match on one reconciliation query.
   *
   * What is left for the transform is the **absent** case: a body that
   * mentions neither field must produce a result that carries neither.
   */
  .transform((value) => {
    /*
     * The two payment fields are **spread conditionally**, so that a body
     * which does not mention them produces a result that does not carry
     * them either.
     *
     * Writing them unconditionally would make them *required* in the
     * inferred output type — `paymentSenderNumber: undefined` is not the
     * same as the key being absent — and that would force every existing
     * caller that builds a checkout body to name them. A payment detail
     * that is absent is genuinely absent; a payment detail that is
     * present-and-undefined is a bug waiting to happen.
     */
    const senderNumber =
      value.paymentSenderNumber !== undefined ? value.paymentSenderNumber : undefined;

    const transactionId =
      value.paymentTransactionId !== undefined
        ? value.paymentTransactionId
        : undefined;

    /*
     * The card fields are **removed**, not merely left alone.
     *
     * `...value` would carry them into the output, because they are
     * declared on the schema. The `superRefine` has already refused any
     * body that carried them, so in practice they are always absent
     * here — but "always absent because an earlier check refused it" is
     * a weaker guarantee than "not present in the result", and the
     * second is free.
     *
     * The result of this transform is the object the order service
     * reads. It must not contain a card number, under any
     * circumstances, and this is where that is made certain.
     */
    const { cardNumber, cardExpiry, cardCvc, cardHolderName, ...rest } = value;

    // The four are destructured out purely to be discarded. Their names
    // are referenced here so the intent is legible and the linter does
    // not read the omission as an accident.
    void cardNumber;
    void cardExpiry;
    void cardCvc;
    void cardHolderName;

    return {
      ...rest,
      ...(senderNumber === undefined
        ? {}
        : { paymentSenderNumber: senderNumber }),
      ...(transactionId === undefined
        ? {}
        : { paymentTransactionId: transactionId }),
    };
  });

export type CheckoutInput = z.infer<typeof checkoutSchema>;

/**
 * The body for submitting a product review.
 *
 * ── What is deliberately absent ───────────────────────────────────────────
 *
 * No `isApproved`, no `isHidden`, no `authorName`. A review that a
 * customer submits is *pending* by definition — the moderation state is
 * the shop's decision, never the customer's. Accepting an approval flag
 * from the client would let anyone publish their own review.
 *
 * The author's name comes from the session, not from the body. A review
 * that says "Dr. Fatima Ahmed" when the account says "Fatima" is a
 * customer impersonating someone else.
 */
export const submitReviewSchema = z.object({
  /**
   * The star rating, 1 to 5.
   *
   * A review without a rating is not a review — the rating is what the
   * distribution chart and the average are built from.
   */
  rating: z
    .number()
    .int("Choose a rating from 1 to 5 stars.")
    .min(1, "Choose a rating from 1 to 5 stars.")
    .max(5, "Choose a rating from 1 to 5 stars."),

  /**
   * The review body.
   *
   * Bounded at 2,000 characters — long enough for a considered review,
   * short enough that it cannot be used as a noticeboard.
   */
  comment: z
    .string()
    .trim()
    .min(10, "Tell us a little more — at least 10 characters.")
    .max(2000, "That review is too long. Keep it under 2000 characters."),

  /**
   * Whether the reviewer confirms they bought the product.
   *
   * This is the reviewer's *claim*, and it is stored as such. The
   * "Verified purchase" badge shown on the page is computed by the
   * server from the order history — a customer's word alone never earns
   * the badge. The claim is kept because it is what the admin uses to
   * prioritise the moderation queue.
   */
  purchased: z.boolean().default(false),
});

export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;
