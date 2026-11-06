import { CouponDiscountType, Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import {
  getCart,
  getOrCreateCartId,
  type CartView,
} from "@/lib/cart/service";
import { db } from "@/lib/db";

import {
  couponDiscountPaisa,
  couponProblemMessage,
  couponStatus,
  normaliseCouponCode,
  type AppliedCoupon,
  type CouponDiscountKind,
  type PublicCoupon,
} from "./rules";

/**
 * The customer-facing coupon service.
 *
 * ── Why this is a separate module from `src/lib/admin/coupons.ts` ────────
 *
 * The admin module is the **desk**: it creates coupons, edits their
 * terms, deactivates them, and writes an audit entry for every one of
 * those acts. It is allowed to do anything, because an admin is
 * trusted.
 *
 * This module is the **shop floor**: it lists the codes a customer may
 * try, validates one, applies one to a cart, and takes one off. It
 * cannot create a coupon, cannot change a coupon's terms, and cannot
 * extend a coupon's life. The rules about *what a coupon is worth* are
 * shared with the admin desk — they live in `@/lib/coupons/rules` — but
 * the authority to *change* one is not.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. The customer never states what a coupon is worth.**
 *
 * The client sends a **code**. The server reads the coupon's terms from
 * the database and computes the discount. A client that sent its own
 * discount amount would be sending a number it made up — which is the
 * same rule the checkout already follows for prices.
 *
 * **2. The discount is computed from the cart, every time.**
 *
 * The cart stores the **code**, not the amount. A percentage coupon is
 * worth a different amount as the cart changes, and a fixed coupon is
 * worth more than the cart is worth once the cart is small. So the
 * amount is derived from the lines at the moment it is displayed or
 * charged, and never persisted on the cart.
 *
 * **3. A coupon is checked again when the order is placed.**
 *
 * Between applying a code and pressing "Place order", the coupon can
 * expire, be deactivated, or run out of uses. The checkout re-validates
 * inside the transaction and **refuses** the order if the coupon is no
 * longer good — it does not quietly apply a smaller discount, because a
 * customer who was quoted a price deserves to have the order fail
 * loudly rather than succeed at a different price.
 *
 * **4. Usage is counted at the order, not at the apply.**
 *
 * `usageCount` is incremented in the same transaction that creates the
 * order. Counting it when the code is *applied* would let a customer
 * apply a limited coupon, abandon the cart, and exhaust the campaign
 * without buying anything.
 */

/**
 * The Prisma select for a publicly-visible coupon.
 */
const PUBLIC_COUPON_SELECT = {
  code: true,
  description: true,
  discountType: true,
  percentOff: true,
  amountOffPaisa: true,
  expiresAt: true,
  usageLimit: true,
  usageCount: true,
  isActive: true,
} satisfies Prisma.CouponSelect;

/**
 * The coupon row, as the redemption path reads it.
 */
type LoadedCoupon = Prisma.CouponGetPayload<{
  select: typeof PUBLIC_COUPON_SELECT;
}>;

/**
 * How the offer is described to a customer.
 *
 * `null` on the two discount columns is impossible for a coupon that
 * passed the admin's own validation, but the fallback is here so a
 * malformed row cannot produce a bare "off".
 */
export function couponLabel(coupon: {
  readonly discountType: CouponDiscountType | CouponDiscountKind;
  readonly percentOff: number | null;
  readonly amountOffPaisa: number | null;
}): string {
  if (coupon.discountType === CouponDiscountType.PERCENTAGE) {
    return coupon.percentOff === null
      ? "A special offer"
      : `${coupon.percentOff}% off`;
  }

  if (coupon.amountOffPaisa === null) return "A special offer";

  const taka = Math.floor(coupon.amountOffPaisa / 100);
  const paisa = coupon.amountOffPaisa % 100;

  if (paisa === 0) {
    return `৳${taka.toLocaleString("en-BD")} off`;
  }

  return `৳${taka.toLocaleString("en-BD")}.${paisa.toString().padStart(2, "0")} off`;
}

/**
 * Lists the coupons a customer may try.
 *
 * ── Which coupons are listed ────────────────────────────────────────────
 *
 * A coupon is listed when it is **active** and **not expired**. It is
 * *not* filtered on the usage limit, because an exhausted coupon is
 * still a real code — hiding it would make the announcement bar and the
 * cart helper disagree with the admin panel, which shows exhausted
 * coupons with the reason they cannot be used.
 *
 * The list is capped. A shop with a hundred live campaigns does not want
 * a hundred codes in a banner, and the newest campaigns are the ones
 * being advertised. So the newest come first and the cap keeps the
 * banner readable.
 */
export async function listPublicCoupons(
  limit = 6,
  now: Date = new Date(),
): Promise<PublicCoupon[]> {
  const rows = await db.coupon.findMany({
    where: {
      isActive: true,
      expiresAt: { gt: now },
    },
    select: PUBLIC_COUPON_SELECT,
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });

  return rows.map((coupon) => ({
    code: coupon.code,
    description: coupon.description,
    label: couponLabel(coupon),
    expiresAt: coupon.expiresAt.toISOString(),
  }));
}

/**
 * The live coupons, and the moment they were listed at.
 *
 * ── Why the moment comes back with them ───────────────────────────────────
 *
 * The announcement bar has to say how long a code has left, and that
 * needs a clock. But a clock read **during render** is a problem twice
 * over:
 *
 *   1. **Next.js cannot prerender it.** A build-time timestamp baked
 *      into a static page would tell a customer that an expired code
 *      still had four days left.
 *   2. **React forbids it.** Reading the clock during render is an
 *      impure operation — the same component rendered twice could
 *      produce two different answers.
 *
 * So the clock is read **here**, in the service, at request time — and
 * handed back alongside the codes. The renderer uses the same moment
 * that decided which codes were live, so the banner's countdown and the
 * banner's contents can never disagree about whether a code is still
 * good.
 *
 * The result is also **one** clock read per request, rather than two
 * that might straddle a millisecond.
 */
export type PublicCouponList = {
  readonly coupons: PublicCoupon[];
  /** The moment the list was taken, as a Unix timestamp in milliseconds. */
  readonly now: number;
};

export async function listPublicCouponsWithClock(
  limit = 6,
): Promise<PublicCouponList> {
  const now = new Date();

  const coupons = await listPublicCoupons(limit, now);

  return { coupons, now: now.getTime() };
}

/**
 * Loads a coupon by its code.
 *
 * The code is normalised first, so "eid2026" and "EID2026" find the same
 * row — the same normalisation the admin desk applies on the way in.
 */
async function loadCoupon(rawCode: string): Promise<LoadedCoupon | null> {
  const code = normaliseCouponCode(rawCode);

  if (code.length === 0) return null;

  return db.coupon.findUnique({
    where: { code },
    select: PUBLIC_COUPON_SELECT,
  });
}

/**
 * Validates a coupon code against the current time.
 *
 * ── Why an unknown code and an unusable code are different answers ──────
 *
 * "EID2026" that does not exist and "EID2026" that expired are different
 * facts, and the customer deserves to be told which one happened. A
 * generic "invalid code" for both would leave a shopper staring at a
 * banner that advertises a code the checkout refuses, with no
 * explanation.
 *
 * So an unknown code is refused with a not-found, and a known-but-
 * unusable code is refused with the specific reason.
 *
 * @param rawCode - The code the customer typed.
 * @param now    - The moment to judge against.
 *
 * @throws ApiError 404 when no coupon has that code.
 * @throws ApiError 409 when the coupon exists but cannot be used.
 */
export async function validateCoupon(
  rawCode: string,
  now: Date = new Date(),
): Promise<LoadedCoupon> {
  const coupon = await loadCoupon(rawCode);

  if (!coupon) {
    throw ApiError.notFound("That code is not one of ours.");
  }

  const status = couponStatus(coupon, now);

  if (status !== "ACTIVE") {
    const problem = couponProblemMessage(status);

    throw ApiError.conflict(problem ?? "That code cannot be used right now.", {
      code: coupon.code,
      status,
    });
  }

  return coupon;
}

/**
 * Applies a coupon to a subtotal and returns what it is worth.
 *
 * The caller supplies the subtotal because the cart owns it. This
 * function never reads the cart itself — it is a calculation over a
 * coupon's terms and a number.
 */
export function applyCouponToSubtotal(
  coupon: {
    readonly discountType: CouponDiscountKind;
    readonly percentOff: number | null;
    readonly amountOffPaisa: number | null;
    readonly code: string;
    readonly description: string | null;
  },
  subtotalPaisa: number,
): AppliedCoupon {
  return {
    code: coupon.code,
    description: coupon.description,
    label: couponLabel({
      discountType:
        coupon.discountType === "PERCENTAGE"
          ? CouponDiscountType.PERCENTAGE
          : CouponDiscountType.FIXED,
      percentOff: coupon.percentOff,
      amountOffPaisa: coupon.amountOffPaisa,
    }),
    discountPaisa: couponDiscountPaisa(coupon, subtotalPaisa),
    subtotalPaisa,
  };
}

/**
 * The result of applying a coupon to a cart.
 */
export type ApplyCouponResult = {
  /** The cart, with the coupon's discount applied to its totals. */
  readonly cart: CartView;
  /** What the coupon is worth against this cart. */
  readonly coupon: AppliedCoupon;
};

/**
 * Applies a coupon code to the user's cart.
 *
 * The coupon is **stored on the cart** as its code — never as an amount.
 * The discount is computed from the cart's current contents, so it is
 * always worth what it is worth *right now*.
 *
 * @param userId - The owner of the cart.
 * @param rawCode - The code the customer typed.
 *
 * @throws ApiError 404 when no coupon has that code.
 * @throws ApiError 409 when the coupon exists but cannot be used.
 */
export async function applyCouponToCart(
  userId: string,
  rawCode: string,
): Promise<ApplyCouponResult> {
  const coupon = await validateCoupon(rawCode);

  /*
   * The cart must exist before it can carry a coupon. A customer who
   * has never added anything has no cart row, and `update` would fail
   * on a row that is not there — so the row is created first.
   */
  await getOrCreateCartId(userId);

  const cart = await getCart(userId);

  /*
   * The subtotal the coupon is applied to.
   *
   * An empty cart gets no discount — there is nothing to discount, and
   * applying a code to an empty cart would leave the customer holding a
   * "discount" for a basket they have not filled yet. The code is still
   * stored, so it survives them adding something.
   */
  const applied = applyCouponToSubtotal(
    {
      discountType:
        coupon.discountType === CouponDiscountType.PERCENTAGE
          ? "PERCENTAGE"
          : "FIXED",
      percentOff: coupon.percentOff,
      amountOffPaisa: coupon.amountOffPaisa,
      code: coupon.code,
      description: coupon.description,
    },
    cart.subtotalPaisa,
  );

  await db.cart.update({
    where: { userId },
    data: { couponCode: coupon.code },
  });

  return {
    cart: { ...cart, coupon: applied },
    coupon: applied,
  };
}

/**
 * Removes the coupon from the user's cart.
 *
 * Removing a coupon is always allowed. A customer who applied a code by
 * mistake must be able to take it off without asking a shop assistant.
 */
export async function removeCouponFromCart(
  userId: string,
): Promise<CartView> {
  await db.cart.updateMany({
    where: { userId },
    data: { couponCode: null },
  });

  return getCartWithCoupon(userId);
}

/**
 * The cart, with its coupon applied.
 *
 * This is the **read** path — the one the cart page and the checkout
 * page use. It is the single place that decides what a cart's coupon is
 * worth, so the two screens cannot show different discounts for the
 * same cart.
 *
 * A coupon that has become unusable since it was applied is reported
 * as **no coupon**, rather than as a discount the customer cannot
 * actually get. The cart shows the reason, so the customer is not left
 * wondering where their discount went.
 */
export async function getCartWithCoupon(userId: string): Promise<CartView> {
  const cart = await getCart(userId);

  const row = await db.cart.findUnique({
    where: { userId },
    select: { couponCode: true },
  });

  const couponCode = row?.couponCode;

  if (!couponCode) return cart;

  const coupon = await loadCoupon(couponCode);

  if (!coupon || couponStatus(coupon) !== "ACTIVE") {
    return { ...cart, coupon: null };
  }

  const applied = applyCouponToSubtotal(
    {
      discountType:
        coupon.discountType === CouponDiscountType.PERCENTAGE
          ? "PERCENTAGE"
          : "FIXED",
      percentOff: coupon.percentOff,
      amountOffPaisa: coupon.amountOffPaisa,
      code: coupon.code,
      description: coupon.description,
    },
    cart.subtotalPaisa,
  );

  return { ...cart, coupon: applied };
}
