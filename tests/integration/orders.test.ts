import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateConflicts } from "@/lib/conflict-engine";
import { placeOrder } from "@/lib/orders/service";
import { FLAT_SHIPPING_PAISA } from "@/lib/pricing";

/**
 * Order placement integration tests.
 *
 * These exercise the real database and the real Prisma transaction. The
 * properties they prove are the ones that unit tests cannot:
 *
 *   1. The order, its items, the stock deduction and the cart emptying
 *      all happen together.
 *   2. A failure rolls the whole thing back — no partial order, no
 *      phantom stock deduction.
 *   3. The stock decrement is conditional, so two concurrent checkouts
 *      cannot sell the same unit twice.
 *   4. The order status and the payment status are set independently.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed — an unreachable database
 * is an environment problem, not a defect in the code under test, and a
 * red suite that cannot be fixed locally teaches people to ignore red.
 */

import { prisma } from "./client";

/**
 * Whether the database is reachable.
 *
 * Resolved once, before the suite runs.
 */
let databaseAvailable = false;

/**
 * The ids created by the test, cleaned up afterwards.
 */
const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

/**
 * A unique suffix so parallel runs do not collide.
 */
const runId = `test_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

/**
 * Creates a user for the test.
 */
async function createUser(
  email: string,
  role: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Customer",
      email,
      // A hash of a value no login will ever use. The tests never
      // authenticate.
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role,
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

/**
 * Creates a category for the test.
 */
async function createCategory(name: string, slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name, slug },
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
    stockQuantity?: number;
    ingredientTags?: string[];
  } = {},
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Test product ${name}`,
      categoryId,
      pricePaisa: options.pricePaisa ?? 100000,
      discountPricePaisa:
        options.discountPricePaisa === undefined
          ? null
          : options.discountPricePaisa,
      stockQuantity: options.stockQuantity ?? 10,
      ingredientTags: options.ingredientTags ?? [],
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
      "\n[integration] PostgreSQL is not reachable — skipping the order " +
        "integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  // Clean up in dependency order. The schema's onDelete rules mean a
  // user cannot be deleted while orders reference it, so the orders go
  // first.
  try {
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: createdUserIds } } },
    });
    await prisma.order.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.cartItem.deleteMany({
      where: { cart: { userId: { in: createdUserIds } } },
    });
    await prisma.cart.deleteMany({
      where: { userId: { in: createdUserIds } },
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

describe("placeOrder", () => {
  it("creates the order, deducts the stock and empties the cart", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_basic@example.com`);
    const categoryId = await createCategory("T", `${runId}_c1`);
    const productId = await createProduct(categoryId, "Basic", {
      pricePaisa: 100000,
      stockQuantity: 10,
    });

    await addToCart(userId, productId, 2);

    const result = await placeOrder(userId, CHECKOUT);

    // The order exists.
    expect(result.orderId).toBeTruthy();
    expect(result.orderNumber).toMatch(new RegExp(`^EGB-\\d{8}-[A-Z0-9]{6}$`));

    // The totals are computed from the database, not the client.
    expect(result.subtotalPaisa).toBe(200000);
    expect(result.totalAmountPaisa).toBe(200000 + FLAT_SHIPPING_PAISA);
    expect(result.totalQuantity).toBe(2);

    // The stock was deducted.
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });
    expect(product?.stockQuantity).toBe(8);

    // The cart was emptied.
    const cart = await prisma.cart.findUnique({
      where: { userId },
      select: { items: { select: { id: true } } },
    });
    expect(cart?.items).toHaveLength(0);
  });

  it("sets the order status and the payment status independently", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_status@example.com`);
    const categoryId = await createCategory("T", `${runId}_c2`);
    const productId = await createProduct(categoryId, "Status", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(userId, productId, 1);

    const result = await placeOrder(userId, CHECKOUT);

    // A COD order has not been paid and has not been dispatched.
    expect(result.status).toBe("PENDING");
    expect(result.paymentStatus).toBe("PENDING");
    expect(result.paymentMethod).toBe("COD");

    const order = await prisma.order.findUnique({
      where: { id: result.orderId },
      select: { status: true, paymentStatus: true, paymentMethod: true },
    });

    expect(order?.status).toBe("PENDING");
    expect(order?.paymentStatus).toBe("PENDING");
    expect(order?.paymentMethod).toBe("COD");
  });

  it("records the mobile-banking transfer details and leaves the payment pending", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_bkash@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_bkash`);
    const productId = await createProduct(categoryId, "Bkash", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(userId, productId, 1);

    const result = await placeOrder(userId, {
      ...CHECKOUT,
      paymentMethod: "BKASH",
      paymentSenderNumber: "01712345678",
      paymentTransactionId: "8N3F2K9LM4",
    });

    // The transfer references are stored on the order, so the admin can
    // match them against the merchant statement.
    expect(result.paymentMethod).toBe("BKASH");
    expect(result.paymentSenderNumber).toBe("01712345678");
    expect(result.paymentTransactionId).toBe("8N3F2K9LM4");

    const order = await prisma.order.findUnique({
      where: { id: result.orderId },
      select: {
        paymentMethod: true,
        paymentSenderNumber: true,
        paymentTransactionId: true,
        paymentStatus: true,
      },
    });

    expect(order?.paymentMethod).toBe("BKASH");
    expect(order?.paymentSenderNumber).toBe("01712345678");
    expect(order?.paymentTransactionId).toBe("8N3F2K9LM4");

    // A customer *telling* us they sent a transfer is not the same as
    // the money having arrived. The order stays PENDING until an admin
    // confirms it.
    expect(order?.paymentStatus).toBe("PENDING");
  });

  it("stores no transfer details on a cash order", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_cod_null@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_cod_null`);
    const productId = await createProduct(categoryId, "Cash", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(userId, productId, 1);

    const result = await placeOrder(userId, CHECKOUT);

    expect(result.paymentSenderNumber).toBeNull();
    expect(result.paymentTransactionId).toBeNull();
  });

  it("snapshots the product name and price onto the order item", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_snapshot@example.com`);
    const categoryId = await createCategory("T", `${runId}_c3`);
    const productId = await createProduct(categoryId, "Original Name", {
      pricePaisa: 80000,
      stockQuantity: 5,
    });

    await addToCart(userId, productId, 1);

    const result = await placeOrder(userId, CHECKOUT);

    // Rename the product and change its price. The historical order must
    // not change with it.
    await prisma.product.update({
      where: { id: productId },
      data: { name: "Renamed", pricePaisa: 999000 },
    });

    const item = await prisma.orderItem.findFirst({
      where: { orderId: result.orderId },
      select: { productName: true, pricePaisa: true },
    });

    expect(item?.productName).toBe("Original Name");
    expect(item?.pricePaisa).toBe(80000);
  });

  it("refuses an empty cart", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_empty@example.com`);

    await expect(placeOrder(userId, CHECKOUT)).rejects.toThrow(
      /cart is empty/i,
    );
  });

  it("rolls back the whole order when the stock is insufficient", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_stock@example.com`);
    const categoryId = await createCategory("T", `${runId}_c4`);
    const productId = await createProduct(categoryId, "Scarce", {
      pricePaisa: 10000,
      stockQuantity: 1,
    });

    // Ask for more than is available. The cart service would refuse
    // this, but the database is the authority at checkout.
    await addToCart(userId, productId, 5);

    await expect(placeOrder(userId, CHECKOUT)).rejects.toThrow(
      /enough stock/i,
    );

    // The critical assertion: the transaction rolled back. No order
    // exists, and the stock was not deducted.
    const orders = await prisma.order.count({ where: { userId } });
    expect(orders).toBe(0);

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });
    expect(product?.stockQuantity).toBe(1);

    // The cart is untouched too — the customer can adjust and retry.
    const cart = await prisma.cart.findUnique({
      where: { userId },
      select: { items: { select: { quantity: true } } },
    });
    expect(cart?.items).toHaveLength(1);
  });

  it("refuses a blocking conflict unless it is confirmed", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_conflict@example.com`);
    const categoryId = await createCategory("T", `${runId}_c5`);
    const retinolId = await createProduct(categoryId, "Retinol", {
      pricePaisa: 200000,
      stockQuantity: 5,
      ingredientTags: ["RETINOL"],
    });
    const ahaId = await createProduct(categoryId, "AHA", {
      pricePaisa: 200000,
      stockQuantity: 5,
      ingredientTags: ["GLYCOLIC_ACID"],
    });

    await addToCart(userId, retinolId, 1);
    await addToCart(userId, ahaId, 1);

    // The engine agrees these conflict.
    const evaluation = evaluateConflicts([
      { id: retinolId, ingredientTags: ["RETINOL"] },
      { id: ahaId, ingredientTags: ["GLYCOLIC_ACID"] },
    ]);
    expect(
      evaluation.conflicts.some((c) => c.severity === "BLOCK"),
    ).toBe(true);

    // Not confirmed → the order is refused.
    await expect(placeOrder(userId, CHECKOUT)).rejects.toThrow(/confirm/i);

    // And nothing was written.
    const orders = await prisma.order.count({ where: { userId } });
    expect(orders).toBe(0);

    const retinol = await prisma.product.findUnique({
      where: { id: retinolId },
      select: { stockQuantity: true },
    });
    expect(retinol?.stockQuantity).toBe(5);

    // Confirmed → the order goes through, and the conflict is recorded.
    const result = await placeOrder(userId, {
      ...CHECKOUT,
      confirmConflicts: true,
    });

    expect(result.orderId).toBeTruthy();
    expect(
      result.conflicts.some((c) => c.severity === "BLOCK"),
    ).toBe(true);
  });

  it("does not sell the same unit twice under concurrent checkouts", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_concurrent@example.com`);
    const categoryId = await createCategory("T", `${runId}_c6`);
    // Exactly one unit of stock.
    const productId = await createProduct(categoryId, "Last One", {
      pricePaisa: 10000,
      stockQuantity: 1,
    });

    await addToCart(userId, productId, 1);

    // Two concurrent checkouts for the same single unit.
    const results = await Promise.allSettled([
      placeOrder(userId, CHECKOUT),
      placeOrder(userId, CHECKOUT),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one may succeed.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // And the stock must never go negative.
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });
    expect(product?.stockQuantity).toBe(0);

    // Only one order exists.
    const orders = await prisma.order.count({ where: { userId } });
    expect(orders).toBe(1);
  });

  it("uses the discounted price when the product is discounted", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_discount@example.com`);
    const categoryId = await createCategory("T", `${runId}_c7`);
    const productId = await createProduct(categoryId, "Discounted", {
      pricePaisa: 200000,
      discountPricePaisa: 150000,
      stockQuantity: 5,
    });

    await addToCart(userId, productId, 2);

    const result = await placeOrder(userId, CHECKOUT);

    // 150000 x 2, not 200000 x 2.
    expect(result.subtotalPaisa).toBe(300000);
  });
});
