/**
 * The coupon rules — pure, and shared by the admin desk and the shop.
 *
 * ── Why this module exists ───────────────────────────────────────────────
 *
 * A coupon is a **price reduction**, and there are two places that need
 * to agree about what one is worth: the admin panel (which creates it)
 * and the shopfront (which redeems it).
 *
 * If those two implement the rules separately, they drift. The admin
 * panel says "20% off" and the shop charges 15%, and nobody notices
 * until a customer complains. So the rules live **here**, in one pure
 * module, and both sides import them.
 *
 * ── Why it is pure ───────────────────────────────────────────────────────
 *
 * No database, no Prisma, no browser API. That means the rules can be
 * unit-tested without a server, and — more importantly — the same
 * function runs in the admin panel, in the shop's checkout, and in the
 * test suite, and cannot answer differently in any of them.
 *
 * The Prisma `CouponDiscountType` enum is deliberately **not** imported
 * here. A pure module that reaches for the generated client would drag
 * the database's type definitions into anything that imports it, and
 * the rules do not need them — the two enum values are two strings.
 */

/**
 * How a coupon's discount is calculated.
 *
 * Mirrors the Prisma `CouponDiscountType` enum. It is spelled out here
 * as a string union so this module stays free of the generated client.
 */
export type CouponDiscountKind = "PERCENTAGE" | "FIXED";

/**
 * The coupon fields the status rules need.
 *
 * Deliberately narrow — four fields, and nothing else. A rule that
 * needs more than this is a rule that is really about something else.
 */
export type CouponTerms = {
  readonly isActive: boolean;
  readonly expiresAt: Date;
  /** `null` means "no limit". */
  readonly usageLimit: number | null;
  readonly usageCount: number;
};

/**
 * Whether a coupon is currently redeemable.
 *
 * Three reasons a coupon cannot be used, and they are **different
 * facts** that need to be told apart:
 *
 *   • **Inactive** — an admin switched it off.
 *   • **Expired** — the clock ran out.
 *   • **Exhausted** — the usage limit was reached.
 *
 * Collapsing them into "not valid" would leave an admin unable to
 * answer "why is this code being rejected?" — which is the only
 * question they are looking at the page to answer. The shopfront has
 * the same need: a customer whose code stopped working deserves to be
 * told *which* of the three happened.
 *
 * The precedence is **inactive → expired → exhausted**. It is fixed,
 * because "the admin switched it off" is the strongest explanation and
 * it is the one an admin can act on.
 */
export type CouponStatus = "ACTIVE" | "INACTIVE" | "EXPIRED" | "EXHAUSTED";

/**
 * Whether a coupon is currently redeemable.
 *
 * @param coupon - The coupon's terms.
 * @param now    - The moment to judge against. Injectable so the rule
 *                 can be tested without waiting for a clock to tick.
 */
export function couponStatus(
  coupon: CouponTerms,
  now: Date = new Date(),
): CouponStatus {
  if (!coupon.isActive) return "INACTIVE";
  if (coupon.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  if (
    coupon.usageLimit !== null &&
    coupon.usageCount >= coupon.usageLimit
  ) {
    return "EXHAUSTED";
  }

  return "ACTIVE";
}

/**
 * Normalises a coupon code.
 *
 * Uppercase, and with the whitespace stripped from the ends. A customer
 * who types a trailing space should not be told the code is invalid.
 *
 * The code is stored uppercase, and the `Coupon.code` unique constraint
 * is what makes that safe: "eid2026" and "EID2026" cannot become two
 * coupons.
 */
export function normaliseCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The coupon's value, as the two columns that carry it.
 */
export type CouponValue = {
  readonly discountType: CouponDiscountKind;
  /** Set only for a `PERCENTAGE` coupon. */
  readonly percentOff: number | null;
  /** Set only for a `FIXED` coupon. */
  readonly amountOffPaisa: number | null;
};

/**
 * What a coupon is worth, in poisha, against a given subtotal.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 *   • A **percentage** coupon takes a percentage of the subtotal. The
 *     result is rounded to the nearest whole poisha, because money is
 *     integer poisha everywhere in this codebase and a discount of
 *     "৳99.999" cannot be charged to anybody.
 *
 *   • A **fixed** coupon takes its amount off, whatever the subtotal.
 *
 *   • **Neither may exceed the subtotal.** A ৳500 coupon on a ৳300
 *     order is worth ৳300, not ৳500 — otherwise the order total would
 *     go negative and the shop would owe the customer money.
 *
 *   • An **empty** subtotal is worth nothing. There is no order to
 *     discount.
 *
 * The subtotal here is the **pre-shipping** subtotal. Shipping is not
 * discounted by a coupon — a coupon is a discount on the goods.
 */
export function couponDiscountPaisa(
  coupon: CouponValue,
  subtotalPaisa: number,
): number {
  if (subtotalPaisa <= 0) return 0;

  if (coupon.discountType === "PERCENTAGE") {
    const percent = coupon.percentOff ?? 0;

    if (percent <= 0) return 0;

    return Math.min(subtotalPaisa, Math.round((subtotalPaisa * percent) / 100));
  }

  const amount = coupon.amountOffPaisa ?? 0;

  if (amount <= 0) return 0;

  return Math.min(subtotalPaisa, amount);
}

/**
 * The plain-language reason a coupon cannot be used.
 *
 * `null` for an active coupon — the absence of a problem, stated as
 * the absence of a problem rather than as an empty string.
 *
 * The wording is the **server's**, because the server is the one that
 * decides. A client that re-implemented this map would eventually
 * disagree with it, and the customer would be told "this code has
 * expired" by one and "this code is no longer active" by the other.
 */
export function couponProblemMessage(
  status: CouponStatus,
): string | null {
  switch (status) {
    case "INACTIVE":
      return "This code is no longer active.";
    case "EXPIRED":
      return "This code has expired.";
    case "EXHAUSTED":
      return "This code has been fully used.";
    case "ACTIVE":
      return null;
  }
}

/**
 * A coupon, as the shop floor shows it.
 */
export type PublicCoupon = {
  /** The uppercase code the customer types. */
  readonly code: string;
  /** The admin's description, shown as the offer's wording. */
  readonly description: string | null;
  /** "20% off" or "৳200 off" — how the offer is described. */
  readonly label: string;
  /** The expiry, as an ISO timestamp. */
  readonly expiresAt: string;
};

/**
 * A coupon, as applied to a particular cart.
 *
 * It lives here, in the pure module, because the **cart's** type needs
 * to name it — and the cart's type must not import the service that
 * resolves it, or the two would import each other in a cycle.
 */
export type AppliedCoupon = {
  /** The uppercase code. */
  readonly code: string;
  /** The admin's description. */
  readonly description: string | null;
  /** How the offer is described — "20% off". */
  readonly label: string;
  /** What it takes off, in poisha. */
  readonly discountPaisa: number;
  /** The subtotal it was applied to, in poisha. */
  readonly subtotalPaisa: number;
};
