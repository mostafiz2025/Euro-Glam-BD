import { CouponDiscountType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addToCart, clearCart } from "@/lib/cart/service";
import {
  applyCouponToCart,
  getCartWithCoupon,
  listPublicCoupons,
  listPublicCouponsWithClock,
  removeCouponFromCart,
  validateCoupon,
} from "@/lib/coupons/service";
import { ApiError } from "@/lib/api/errors";

/**
 * The customer-facing coupon path, against a real database.
 *
 * ── The properties these tests prove ─────────────────────────────────────
 *
 *   1. A code is **normalised** on the way in, so "eid2026" and
 *      "EID2026" are one code.
 *   2. An **unknown** code and an **unusable** code are different
 *      answers — a not-found and a conflict. A customer whose code
 *      stopped working deserves to be told *which* happened.
 *   3. The cart stores the **code**, never the amount. The discount is
 *      computed from the cart's contents at the moment it is shown, so
 *      it is always worth what it is worth *right now*.
 *   4. A coupon that has become unusable since it was applied resolves
 *      to **no coupon**, rather than to a discount the customer cannot
 *      actually get.
 *   5. The public list shows the **active, unexpired** codes — the
 *      ones the announcement bar advertises.
 *   6. A coupon never discounts more than the cart is worth.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdCouponIds: string[] = [];

const runId = `CCN${Date.now()}${Math.floor(Math.random() * 100000)}`;

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);

let customerId: string;

async function createProduct(pricePaisa: number): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Coupon Test", slug: `${runId}_cat_${Math.floor(Math.random() * 100000)}` },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);

  const product = await prisma.product.create({
    data: {
      name: `${runId}_product_${Math.floor(Math.random() * 100000)}`,
      description: "A product for coupon testing.",
      categoryId: category.id,
      pricePaisa,
      stockQuantity: 20,
      ingredientTags: [],
      images: [],
      badges: [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

async function createCoupon(
  code: string,
  data: {
    discountType: CouponDiscountType;
    percentOff?: number | null;
    amountOffPaisa?: number | null;
    expiresAt?: Date;
    usageLimit?: number | null;
    usageCount?: number;
    isActive?: boolean;
    description?: string | null;
  },
): Promise<string> {
  const coupon = await prisma.coupon.create({
    data: {
      // The code is stored uppercase — the same normalisation the admin
      // desk applies — so the row is written the way the shop will
      // look it up.
      code: code.toUpperCase(),
      description: data.description ?? null,
      discountType: data.discountType,
      percentOff: data.percentOff ?? null,
      amountOffPaisa: data.amountOffPaisa ?? null,
      expiresAt: data.expiresAt ?? FUTURE,
      usageLimit: data.usageLimit ?? null,
      usageCount: data.usageCount ?? 0,
      isActive: data.isActive ?? true,
    },
    select: { id: true },
  });

  createdCouponIds.push(coupon.id);
  return coupon.id;
}

/**
 * Empties the customer's cart.
 *
 * Each test starts from an empty cart, because the cart is the thing
 * under test — a leftover line from the previous test would change the
 * subtotal and quietly invalidate the arithmetic.
 */
async function emptyCart(): Promise<void> {
  await clearCart(customerId);
  await removeCouponFromCart(customerId);
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the customer " +
        "coupon integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const customer = await prisma.user.create({
    data: {
      name: "Test Coupon Customer",
      email: `${runId}_customer@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
    },
    select: { id: true },
  });

  createdUserIds.push(customer.id);
  customerId = customer.id;
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  await prisma.cartItem.deleteMany({
    where: { cart: { userId: { in: createdUserIds } } },
  });
  await prisma.cart.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await prisma.coupon.deleteMany({
    where: { id: { in: createdCouponIds } },
  });
  await prisma.product.deleteMany({
    where: { id: { in: createdProductIds } },
  });
  await prisma.category.deleteMany({
    where: { id: { in: createdCategoryIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: createdUserIds } },
  });
});

describe("validateCoupon", () => {
  it("accepts a live coupon", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_LIVE`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 20,
    });

    const coupon = await validateCoupon(`${runId}_LIVE`);

    expect(coupon.code).toBe(`${runId}_LIVE`);
  });

  it("finds a coupon whose code was typed in lowercase", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_CASE`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    const coupon = await validateCoupon(`${runId}_CASE`.toLowerCase());

    expect(coupon.code).toBe(`${runId}_CASE`);
  });

  it("refuses an unknown code with a not-found", async () => {
    if (!databaseAvailable) return;

    await expect(
      validateCoupon(`${runId}_NOSUCHCODE`),
    ).rejects.toBeInstanceOf(ApiError);

    await expect(validateCoupon(`${runId}_NOSUCHCODE`)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses an expired coupon with a conflict", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_EXPIRED`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      expiresAt: PAST,
    });

    await expect(validateCoupon(`${runId}_EXPIRED`)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses an inactive coupon with a conflict", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_INACTIVE`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      isActive: false,
    });

    await expect(validateCoupon(`${runId}_INACTIVE`)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses an exhausted coupon with a conflict", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_EXHAUSTED`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      usageLimit: 5,
      usageCount: 5,
    });

    await expect(validateCoupon(`${runId}_EXHAUSTED`)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("listPublicCoupons", () => {
  it("lists the active, unexpired codes and hides the rest", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_SHOWN`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 15,
      description: "The Eid collection",
    });
    await createCoupon(`${runId}_HIDDEN_EXPIRED`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 15,
      expiresAt: PAST,
    });
    await createCoupon(`${runId}_HIDDEN_INACTIVE`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 15,
      isActive: false,
    });

    const coupons = await listPublicCoupons(100);
    const codes = coupons.map((coupon) => coupon.code);

    expect(codes).toContain(`${runId}_SHOWN`);
    expect(codes).not.toContain(`${runId}_HIDDEN_EXPIRED`);
    expect(codes).not.toContain(`${runId}_HIDDEN_INACTIVE`);
  });

  it("describes the offer in words", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_DESCRIBED`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 20,
      description: "The Eid collection",
    });

    const coupons = await listPublicCoupons(100);
    const coupon = coupons.find((entry) => entry.code === `${runId}_DESCRIBED`);

    expect(coupon?.label).toBe("20% off");
    expect(coupon?.description).toBe("The Eid collection");
  });

  it("hands back the moment the list was taken", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_CLOCKED`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    const before = Date.now();
    const { coupons, now } = await listPublicCouponsWithClock(100);
    const after = Date.now();

    // The clock is read **once**, at request time, and the banner uses
    // the very same moment that decided which codes were live — so the
    // countdown and the contents cannot disagree.
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
    expect(coupons.map((coupon) => coupon.code)).toContain(`${runId}_CLOCKED`);
  });

  it("lists the same codes whether or not the clock is asked for", async () => {
    if (!databaseAvailable) return;

    await createCoupon(`${runId}_SAME`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    const plain = (await listPublicCoupons(100)).map((coupon) => coupon.code);
    const withClock = (await listPublicCouponsWithClock(100)).coupons.map(
      (coupon) => coupon.code,
    );

    expect(withClock).toEqual(plain);
  });
});

describe("applyCouponToCart", () => {
  it("stores the code on the cart and reports what it is worth", async () => {
    if (!databaseAvailable) return;

    await emptyCart();

    const productId = await createProduct(100_000);
    await addToCart(customerId, productId, 2);

    await createCoupon(`${runId}_APPLY`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    const result = await applyCouponToCart(customerId, `${runId}_APPLY`);

    expect(result.coupon.code).toBe(`${runId}_APPLY`);
    expect(result.coupon.discountPaisa).toBe(20_000);
    expect(result.cart.coupon?.discountPaisa).toBe(20_000);

    // The cart stores the **code**, never the amount.
    const row = await prisma.cart.findUnique({
      where: { userId: customerId },
      select: { couponCode: true },
    });

    expect(row?.couponCode).toBe(`${runId}_APPLY`);

    await removeCouponFromCart(customerId);
  });

  it("recomputes the discount when the cart changes", async () => {
    if (!databaseAvailable) return;

    await emptyCart();

    const productId = await createProduct(100_000);
    await addToCart(customerId, productId, 1);

    await createCoupon(`${runId}_RECOMPUTE`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    await applyCouponToCart(customerId, `${runId}_RECOMPUTE`);

    const before = await getCartWithCoupon(customerId);
    expect(before.coupon?.discountPaisa).toBe(10_000);

    // The customer doubles the quantity. The discount must double with
    // it — the stored value is the code, not the amount.
    await addToCart(customerId, productId, 1);

    const after = await getCartWithCoupon(customerId);
    expect(after.coupon?.discountPaisa).toBe(20_000);

    await removeCouponFromCart(customerId);
  });

  it("never discounts more than the cart is worth", async () => {
    if (!databaseAvailable) return;

    await emptyCart();

    const productId = await createProduct(10_000);
    await addToCart(customerId, productId, 1);

    await createCoupon(`${runId}_BIG`, {
      discountType: CouponDiscountType.FIXED,
      amountOffPaisa: 500_000,
    });

    const result = await applyCouponToCart(customerId, `${runId}_BIG`);

    expect(result.coupon.discountPaisa).toBe(10_000);
    expect(result.cart.subtotalPaisa - result.coupon.discountPaisa).toBe(0);

    await removeCouponFromCart(customerId);
  });

  it("refuses to apply an unknown code", async () => {
    if (!databaseAvailable) return;

    await emptyCart();

    await expect(
      applyCouponToCart(customerId, `${runId}_NOSUCHCODE`),
    ).rejects.toBeInstanceOf(ApiError);

    const row = await prisma.cart.findUnique({
      where: { userId: customerId },
      select: { couponCode: true },
    });

    expect(row?.couponCode).toBeNull();
  });
});

describe("getCartWithCoupon", () => {
  it("reports no coupon when the code has expired since it was applied", async () => {
    if (!databaseAvailable) return;

    await emptyCart();

    const productId = await createProduct(100_000);
    await addToCart(customerId, productId, 1);

    await createCoupon(`${runId}_LAPSED`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    await applyCouponToCart(customerId, `${runId}_LAPSED`);

    // The campaign ends while the customer is still deciding.
    await prisma.coupon.updateMany({
      where: { code: `${runId}_LAPSED` },
      data: { expiresAt: PAST },
    });

    const cart = await getCartWithCoupon(customerId);

    // The customer is not shown a discount they cannot get.
    expect(cart.coupon).toBeNull();

    await removeCouponFromCart(customerId);
  });

  it("reports no coupon when the code has been switched off", async () => {
    if (!databaseAvailable) return;

    await emptyCart();

    const productId = await createProduct(100_000);
    await addToCart(customerId, productId, 1);

    await createCoupon(`${runId}_SWITCHED`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    await applyCouponToCart(customerId, `${runId}_SWITCHED`);

    await prisma.coupon.updateMany({
      where: { code: `${runId}_SWITCHED` },
      data: { isActive: false },
    });

    const cart = await getCartWithCoupon(customerId);

    expect(cart.coupon).toBeNull();

    await removeCouponFromCart(customerId);
  });

  it("removes the coupon on request", async () => {
    if (!databaseAvailable) return;

    await emptyCart();

    const productId = await createProduct(100_000);
    await addToCart(customerId, productId, 1);

    await createCoupon(`${runId}_REMOVABLE`, {
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
    });

    await applyCouponToCart(customerId, `${runId}_REMOVABLE`);

    const cart = await removeCouponFromCart(customerId);

    expect(cart.coupon).toBeNull();

    const row = await prisma.cart.findUnique({
      where: { userId: customerId },
      select: { couponCode: true },
    });

    expect(row?.couponCode).toBeNull();
  });
});
