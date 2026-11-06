/**
 * Pricing and order total calculation.
 *
 * ── The one rule that governs this file ──────────────────────────────────
 *
 * **Money is integer poisha. Never a float. Never a client-supplied
 * number.**
 *
 * 1 BDT = 100 poisha. `Decimal` is reserved for currencies that need more
 * precision than the currency has, and `Float` is excluded outright because
 * binary floating point cannot represent decimal amounts exactly — sums
 * drift, and a customer who is charged 0.01 BDT too much is a support
 * ticket.
 *
 * Every figure that ends up in an order is computed here, from prices read
 * from the database. The client never states what anything costs.
 */

/**
 * The flat delivery charge in poisha.
 *
 * A fixed charge keeps the arithmetic auditable. Free delivery above a
 * threshold would be a natural extension, but it must be implemented here
 * — not in the route handler — so the rule is applied identically
 * everywhere an order is created.
 */
export const FLAT_SHIPPING_PAISA = 8000;

/**
 * The order subtotal above which delivery is free, in poisha.
 */
export const FREE_SHIPPING_THRESHOLD_PAISA = 300000;

/**
 * The product fields pricing needs.
 */
export type PricedProduct = {
  readonly id: string;
  readonly pricePaisa: number;
  readonly discountPricePaisa: number | null;
};

/**
 * The effective price of a product, in poisha.
 *
 * The discounted price applies when it exists. A discounted price of zero
 * is a legitimate value (a free item), so the check is `!== null` rather
 * than a truthiness test.
 */
export function effectivePricePaisa(product: PricedProduct): number {
  return product.discountPricePaisa ?? product.pricePaisa;
}

/**
 * A single line of an order or a cart.
 */
export type PricedLine = {
  readonly product: PricedProduct;
  readonly quantity: number;
};

/**
 * The computed totals for a set of lines.
 */
export type OrderTotals = {
  /** The sum of the line totals, before shipping. */
  readonly subtotalPaisa: number;
  /** The shipping charge, after any free-shipping discount. */
  readonly shippingPaisa: number;
  /** The amount discounted by free shipping. */
  readonly shippingDiscountPaisa: number;
  /**
   * The amount discounted by a coupon, in poisha.
   *
   * Zero when no coupon was redeemed. It is kept apart from
   * `shippingDiscountPaisa` because the two are different facts: one is
   * a promotion, the other is a property of the order's value.
   */
  readonly couponDiscountPaisa: number;
  /**
   * The **total** discount, in poisha — the free-shipping discount plus
   * the coupon discount.
   *
   * This is what lands in `Order.discountAmountPaisa`, and it is the
   * single number every screen shows. Two separate columns would mean
   * every reader had to remember to add them, and one of them would
   * eventually forget.
   *
   * It is a **saving**, not a deduction from the total — see
   * `totalAmountPaisa` for why the two are not the same.
   */
  readonly discountAmountPaisa: number;
  /** What the customer pays: subtotal + shipping - coupon. */
  readonly totalAmountPaisa: number;
};

/**
 * Computes the totals for a set of order lines.
 *
 * @param lines        - The lines, each with a product and a quantity.
 * @param shippingPaisa - The shipping charge to apply. Defaults to the flat
 *                       rate. Pass `0` to waive shipping.
 * @param couponDiscountPaisa - The discount a coupon is worth against
 *                       this subtotal. Defaults to `0` — no coupon.
 *
 * ── The order the discounts are applied in ───────────────────────────────
 *
 * The **coupon comes off the goods first**, and the free-shipping
 * threshold is then judged against the *undiscounted* subtotal.
 *
 * That ordering is deliberate. The free-shipping threshold is a
 * statement about the order's **value** — "spend ৳3,000 and delivery is
 * free" — and it is judged on what the goods are worth, not on what
 * the customer paid after a promotion. If the threshold were judged on
 * the discounted subtotal, a coupon could push an order *below* the
 * threshold and **add** delivery to it, so applying a 20% coupon to a
 * ৳3,100 order would make the customer pay ৳80 for delivery. That is
 * the opposite of what a promotion is for.
 *
 * So the threshold is read from the pre-discount subtotal, the coupon
 * comes off the goods, and the two discounts are then added together
 * into the single `discountAmountPaisa` the order records.
 *
 * ── Why the shipping discount is not deducted from the total ─────────────
 *
 * The free-shipping discount is **already** reflected in the shipping
 * figure: `shippingPaisa` is the charge the customer actually pays for
 * delivery, and it is `0` when the order qualified for free delivery.
 *
 * So subtracting `discountAmountPaisa` — which contains the shipping
 * discount — from `subtotal + shippingPaisa` would count the same
 * saving **twice**. On a ৳3,000 order with free delivery that made the
 * total ৳2,920 instead of ৳3,000: the customer was charged ৳80 for
 * delivery that had been waived.
 *
 * The invariant is therefore:
 *
 * ```text
 * totalAmountPaisa = subtotalPaisa + shippingPaisa - couponDiscountPaisa
 * ```
 *
 * and `discountAmountPaisa` — the *total* saving, free delivery plus
 * coupon — is what the screens show as "you saved", not a second
 * deduction from the total.
 *
 * The total can never go below zero: the coupon's discount is capped
 * at the subtotal by `couponDiscountPaisa`.
 */
export function calculateOrderTotals(
  lines: readonly PricedLine[],
  shippingPaisa: number = FLAT_SHIPPING_PAISA,
  couponDiscountPaisa: number = 0,
): OrderTotals {
  const subtotalPaisa = lines.reduce((total, line) => {
    return total + effectivePricePaisa(line.product) * line.quantity;
  }, 0);

  const qualifiesForFreeShipping =
    subtotalPaisa > 0 && subtotalPaisa >= FREE_SHIPPING_THRESHOLD_PAISA;

  const shippingDiscountPaisa = qualifiesForFreeShipping
    ? Math.max(0, shippingPaisa)
    : 0;

  const appliedShippingPaisa = shippingPaisa - shippingDiscountPaisa;

  /*
   * The coupon's discount, capped at the subtotal.
   *
   * The cap is applied here as well as in the coupon rule, because this
   * function is the **last** thing that decides what the customer
   * pays. A caller that computed a discount of ৳500 against a ৳300
   * subtotal would produce a negative total — and a negative total is
   * an order the shop owes money on.
   */
  const appliedCouponPaisa = Math.min(
    Math.max(0, subtotalPaisa),
    Math.max(0, couponDiscountPaisa),
  );

  const discountAmountPaisa = shippingDiscountPaisa + appliedCouponPaisa;

  return {
    subtotalPaisa,
    shippingPaisa: appliedShippingPaisa,
    shippingDiscountPaisa,
    couponDiscountPaisa: appliedCouponPaisa,
    discountAmountPaisa,
    /*
     * The total.
     *
     * Only the **coupon** is deducted, because the free-shipping
     * discount is already baked into `appliedShippingPaisa` — which is
     * the charge the customer actually pays for delivery. Deducting the
     * total discount here would count the free delivery twice and
     * charge the customer for a waiver they were given.
     */
    totalAmountPaisa: Math.max(
      0,
      subtotalPaisa + appliedShippingPaisa - appliedCouponPaisa,
    ),
  };
}

/**
 * Formats a poisha amount as Bangladeshi Taka for display.
 *
 * Used in log lines and in the order summary returned to the client. The
 * persisted values are always integer poisha — this is presentation only.
 */
export function formatPaisa(pricePaisa: number): string {
  const negative = pricePaisa < 0;
  const absolute = Math.abs(pricePaisa);

  const taka = Math.floor(absolute / 100);
  const paisa = absolute % 100;

  const takaFormatted = taka.toLocaleString("en-BD");

  const body = paisa === 0 ? `৳${takaFormatted}` : `৳${takaFormatted}.${paisa.toString().padStart(2, "0")}`;

  return negative ? `-${body}` : body;
}
