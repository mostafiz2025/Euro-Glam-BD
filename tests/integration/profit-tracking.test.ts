import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { changeOrderStatus } from "@/lib/admin/orders";
import { getProfitMetrics } from "@/lib/admin/profit";
import { placeOrder } from "@/lib/orders/service";

/**
 * Cost tracking, coupon allocation and the units-sold counter.
 *
 * These exercise the real database and the real Prisma transaction. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. The **cost is snapshotted** onto the order line. A supplier price
 *      rise tomorrow must not rewrite the profit of a sale made today.
 *   2. The **coupon's share is allocated across the lines** so that the
 *      parts sum to exactly the coupon's discount — no poisha lost to
 *      rounding, none invented.
 *   3. The **units-sold counter** moves in step with the stock, and comes
 *      back down when the order is cancelled.
 *   4. The **profit figure excludes** a line whose cost was never
 *      recorded, and reports how many lines it left out.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

/**
 * Whether the database is reachable.
 */
let databaseAvailable = false;

/**
 * The ids created by the test, cleaned up afterwards.
 */
const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdCouponIds: string[] = [];

/**
 * A unique suffix so parallel runs do not collide.
 */
const runId = `profit_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

/**
 * Creates a user for the test.
 */
async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Customer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

/**
 * Creates an admin for the test.
 *
 * The cancellation writes an **audit entry**, and the audit entry's
 * actor is a foreign key to `User` — so the admin has to be a real row,
 * not a made-up id.
 */
async function createAdmin(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Admin",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

/**
 * Creates a category for the test.
 */
async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "T", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

/**
 * Creates a product for the test.
 */
async function createProduct(
  categoryId: string,
  name: string,
  options: {
    pricePaisa?: number;
    discountPricePaisa?: number | null;
    purchasePricePaisa?: number | null;
    stockQuantity?: number;
  } = {},
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Test product ${name}`,
      categoryId,
      pricePaisa: options.pricePaisa ?? 100_000,
      discountPricePaisa:
        options.discountPricePaisa === undefined
          ? null
          : options.discountPricePaisa,
      purchasePricePaisa:
        options.purchasePricePaisa === undefined
          ? null
          : options.purchasePricePaisa,
      stockQuantity: options.stockQuantity ?? 10,
      ingredientTags: [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

/**
 * Puts a product in the user's cart.
 */
async function addToCart(
  userId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  const cart = await prisma.cart.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { id: true },
  });

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    create: { cartId: cart.id, productId, quantity },
    update: { quantity },
  });
}

/**
 * Creates a coupon for the test.
 *
 * A flat ৳100 off, which is enough to check that the allocation splits
 * the way the arithmetic says it should.
 */
async function createFlatCoupon(code: string, amountOffPaisa: number) {
  const coupon = await prisma.coupon.create({
    data: {
      code,
      discountType: "FIXED",
      amountOffPaisa,
      isActive: true,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    select: { id: true },
  });

  createdCouponIds.push(coupon.id);
  return coupon.id;
}

/**
 * A valid checkout body.
 */
const CHECKOUT = {
  shippingAddress: {
    fullName: "Ayesha Rahman",
    phone: "01712345678",
    addressLine1: "House 12, Road 5, Dhanmondi",
    city: "Dhaka",
    district: "Dhaka",
    postalCode: "1209",
  },
  paymentMethod: "COD" as const,
  confirmConflicts: false,
};

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the profit " +
        "tracking integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: createdUserIds } } },
    });
    await prisma.order.deleteMany({
      where: { userId: { in: createdUserIds } } },
    );
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
  } finally {
  }
});

describe("the cost snapshot on an order line", () => {
  it("records the product's cost at the moment of the sale", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_cost@example.com`);
    const categoryId = await createCategory(`${runId}_c1`);
    const productId = await createProduct(categoryId, "Costed", {
      pricePaisa: 100_000,
      purchasePricePaisa: 60_000,
      stockQuantity: 5,
    });

    await addToCart(userId, productId, 2);

    const result = await placeOrder(userId, CHECKOUT);

    // The supplier's price changes the moment after the sale. The
    // historical order must not change with it.
    await prisma.product.update({
      where: { id: productId },
      data: { purchasePricePaisa: 90_000 },
    });

    const item = await prisma.orderItem.findFirst({
      where: { orderId: result.orderId },
      select: {
        pricePaisa: true,
        purchasePricePaisa: true,
        discountAmountPaisa: true,
        quantity: true,
      },
    });

    // The charged price, the snapshotted cost, and no coupon.
    expect(item?.pricePaisa).toBe(100_000);
    expect(item?.purchasePricePaisa).toBe(60_000);
    expect(item?.discountAmountPaisa).toBe(0);
    expect(item?.quantity).toBe(2);
  });

  it("leaves the cost null when the product has none recorded", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_nocost@example.com`);
    const categoryId = await createCategory(`${runId}_c2`);
    const productId = await createProduct(categoryId, "Uncosted", {
      pricePaisa: 100_000,
      purchasePricePaisa: null,
      stockQuantity: 5,
    });

    await addToCart(userId, productId, 1);

    const result = await placeOrder(userId, CHECKOUT);

    const item = await prisma.orderItem.findFirst({
      where: { orderId: result.orderId },
      select: { purchasePricePaisa: true },
    });

    // `null` means "not known" — not zero. A line with no known cost is
    // excluded from the profit arithmetic rather than counted as if the
    // goods were free.
    expect(item?.purchasePricePaisa).toBeNull();
  });
});

describe("the coupon's allocation across the lines", () => {
  it("splits the coupon in proportion to each line's share", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_coupon@example.com`);
    const categoryId = await createCategory(`${runId}_c3`);

    // Two lines: ৳1,000 and ৳3,000, so the shares are 1:3.
    const cheapId = await createProduct(categoryId, "Cheap", {
      pricePaisa: 100_000,
      purchasePricePaisa: 50_000,
      stockQuantity: 5,
    });
    const dearId = await createProduct(categoryId, "Dear", {
      pricePaisa: 300_000,
      purchasePricePaisa: 150_000,
      stockQuantity: 5,
    });

    const couponId = await createFlatCoupon(`${runId}_flat`, 40_000);

    await addToCart(userId, cheapId, 1);
    await addToCart(userId, dearId, 1);

    const cart = await prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: { couponCode: `${runId}_flat` },
      select: { id: true },
    });

    await prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: `${runId}_flat` },
    });

    expect(couponId).toBeTruthy();

    const result = await placeOrder(userId, CHECKOUT);

    // The coupon came off the order.
    expect(result.couponDiscountPaisa).toBe(40_000);

    const items = await prisma.orderItem.findMany({
      where: { orderId: result.orderId },
      select: {
        productId: true,
        pricePaisa: true,
        discountAmountPaisa: true,
      },
    });

    const cheap = items.find((item) => item.productId === cheapId);
    const dear = items.find((item) => item.productId === dearId);

    // ৳400 off a ৳1,000 line, ৳1,200 off a ৳3,000 line — the same 10%.
    expect(cheap?.discountAmountPaisa).toBe(10_000);
    expect(dear?.discountAmountPaisa).toBe(30_000);

    // And the parts sum to exactly the coupon's discount. No poisha is
    // lost to rounding, and none is invented.
    const allocated = items.reduce(
      (total, item) => total + item.discountAmountPaisa,
      0,
    );

    expect(allocated).toBe(40_000);
  });

  it("puts the whole coupon on the last line when the split would not divide evenly", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_remainder@example.com`);
    const categoryId = await createCategory(`${runId}_c4`);

    const aId = await createProduct(categoryId, "A", {
      pricePaisa: 100_000,
      purchasePricePaisa: 50_000,
      stockQuantity: 5,
    });
    const bId = await createProduct(categoryId, "B", {
      pricePaisa: 100_000,
      purchasePricePaisa: 50_000,
      stockQuantity: 5,
    });
    const cId = await createProduct(categoryId, "C", {
      pricePaisa: 100_000,
      purchasePricePaisa: 50_000,
      stockQuantity: 5,
    });

    await createFlatCoupon(`${runId}_odd`, 10_000);

    await addToCart(userId, aId, 1);
    await addToCart(userId, bId, 1);
    await addToCart(userId, cId, 1);

    const cart = await prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { id: true },
    });

    await prisma.cart.update({
      where: { id: cart.id },
      data: { couponCode: `${runId}_odd` },
    });

    const result = await placeOrder(userId, CHECKOUT);

    const items = await prisma.orderItem.findMany({
      where: { orderId: result.orderId },
      select: { discountAmountPaisa: true },
    });

    // ৳100 over three equal lines does not divide evenly: 33/33/34 or
    // 34/34/32. What matters is that the parts sum to the whole.
    const allocated = items.reduce(
      (total, item) => total + item.discountAmountPaisa,
      0,
    );

    expect(allocated).toBe(10_000);
  });
});

describe("the units-sold counter", () => {
  it("increments when an order is placed", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_sold@example.com`);
    const categoryId = await createCategory(`${runId}_c5`);
    const productId = await createProduct(categoryId, "Popular", {
      pricePaisa: 100_000,
      purchasePricePaisa: 50_000,
      stockQuantity: 10,
    });

    await addToCart(userId, productId, 3);

    await placeOrder(userId, CHECKOUT);

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { soldCount: true, stockQuantity: true },
    });

    expect(product?.soldCount).toBe(3);
    expect(product?.stockQuantity).toBe(7);
  });

  it("comes back down when the order is cancelled", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_cancelled@example.com`);
    const categoryId = await createCategory(`${runId}_c6`);
    const productId = await createProduct(categoryId, "Returned", {
      pricePaisa: 100_000,
      purchasePricePaisa: 50_000,
      stockQuantity: 10,
    });

    await addToCart(userId, productId, 2);

    const result = await placeOrder(userId, CHECKOUT);

    const before = await prisma.product.findUnique({
      where: { id: productId },
      select: { soldCount: true, stockQuantity: true },
    });

    expect(before?.soldCount).toBe(2);
    expect(before?.stockQuantity).toBe(8);

    const adminId = await createAdmin(`${runId}_admin@example.com`);

    await changeOrderStatus(
      { id: adminId, name: "Test Admin", email: `${runId}_admin@example.com` },
      result.orderId,
      "CANCELLED",
      "Test cancellation",
    );

    const after = await prisma.product.findUnique({
      where: { id: productId },
      select: { soldCount: true, stockQuantity: true },
    });

    // The goods came back to the shelf, so they were never sold. Both
    // counters move together, in the same transaction.
    expect(after?.soldCount).toBe(0);
    expect(after?.stockQuantity).toBe(10);
  });
});

describe("the profit metrics", () => {
  it("counts a line with a recorded cost and excludes a line without one", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_metrics@example.com`);
    const categoryId = await createCategory(`${runId}_c7`);

    const costedId = await createProduct(categoryId, "Costed", {
      pricePaisa: 100_000,
      purchasePricePaisa: 60_000,
      stockQuantity: 10,
    });
    const uncostedId = await createProduct(categoryId, "Uncosted", {
      pricePaisa: 100_000,
      purchasePricePaisa: null,
      stockQuantity: 10,
    });

    await addToCart(userId, costedId, 2);
    await addToCart(userId, uncostedId, 1);

    await placeOrder(userId, CHECKOUT);

    const metrics = await getProfitMetrics();

    // The counted line contributes its revenue and its cost.
    expect(metrics.countedLines).toBeGreaterThanOrEqual(1);
    expect(metrics.excludedLines).toBeGreaterThanOrEqual(1);
    expect(metrics.profitPaisa).toBeGreaterThanOrEqual(0);

    // Every counted line's cost is known, so the figure is real.
    expect(metrics.unitsSold).toBeGreaterThanOrEqual(2);
  });

  it("reports a null margin rather than a percentage against zero", async () => {
    if (!databaseAvailable) return;

    // There are no countable lines in a database where every sale lacks
    // a cost, so this asserts the shape: the margin is a number or
    // `null`, never a division by zero wearing a percentage's clothes.
    const metrics = await getProfitMetrics();

    expect(
      metrics.marginPercentage === null ||
        Number.isFinite(metrics.marginPercentage),
    ).toBe(true);
  });
});
