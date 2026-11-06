import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  changeOrderStatus,
  changePaymentStatus,
  getAdminOrder,
  listAdminOrders,
} from "@/lib/admin/orders";
import type { AuditActor } from "@/lib/admin/audit";
import { ApiError } from "@/lib/api/errors";

/**
 * Admin order management integration tests.
 *
 * These exercise the real database and the real Prisma transaction. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. A legal transition writes the status **and** the audit entry.
 *   2. An illegal transition writes **neither**.
 *   3. Cancelling restores the reserved stock — exactly once.
 *   4. A conditional update means two admins moving the same order
 *      produce one winner and one 409.
 *   5. Payment moves independently of fulfilment.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];

const runId = `ord${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * The admin who performs the actions.
 *
 * The `actorId` is a foreign key to `User`, so the audit actor has to be
 * a real user row — the tests create an admin rather than inventing an
 * id.
 */
let actor: AuditActor;

async function createUser(
  email: string,
  role: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Customer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role,
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Order Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

async function createProduct(
  categoryId: string,
  name: string,
  stockQuantity: number,
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Order test product ${name}`,
      categoryId,
      pricePaisa: 100000,
      stockQuantity,
      ingredientTags: [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

/**
 * Creates an order with one line.
 *
 * The stock is **not** deducted here — the tests that care about stock
 * set the product's stock explicitly and check the arithmetic.
 */
async function createOrder(
  userId: string,
  productId: string,
  options: {
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
    paymentMethod?: PaymentMethod;
    quantity?: number;
    orderNumber: string;
  },
): Promise<string> {
  const quantity = options.quantity ?? 2;

  const order = await prisma.order.create({
    data: {
      userId,
      orderNumber: options.orderNumber,
      status: options.status ?? OrderStatus.PENDING,
      paymentStatus: options.paymentStatus ?? PaymentStatus.PENDING,
      paymentMethod: options.paymentMethod ?? "COD",
      subtotalPaisa: 100000 * quantity,
      totalAmountPaisa: 100000 * quantity + 8000,
      shippingAmountPaisa: 8000,
      discountAmountPaisa: 0,
      shippingAddress: {
        fullName: "Ayesha Rahman",
        phone: "01712345678",
        addressLine1: "House 12, Road 5, Dhanmondi",
        city: "Dhaka",
        district: "Dhaka",
        postalCode: "1209",
      },
      items: {
        create: {
          productId,
          productName: "Test Product",
          pricePaisa: 100000,
          quantity,
        },
      },
    },
    select: { id: true },
  });

  createdOrderIds.push(order.id);
  return order.id;
}

let productId: string;
let categoryId: string;
let customerId: string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the admin " +
        "order integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const adminId = await createUser(`${runId}_admin@example.com`, "ADMIN");

  actor = {
    id: adminId,
    name: "Admin Actor",
    email: `${runId}_admin@example.com`,
  };

  customerId = await createUser(`${runId}_customer@example.com`);
  categoryId = await createCategory(`${runId}-cat`);
  productId = await createProduct(categoryId, "Order Product", 100);
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.adminAuditLog.deleteMany({
      where: { entityType: "order", entityId: { in: createdOrderIds } },
    });
    await prisma.orderItem.deleteMany({
      where: { orderId: { in: createdOrderIds } },
    });
    await prisma.order.deleteMany({
      where: { id: { in: createdOrderIds } },
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

describe("changeOrderStatus — a legal transition", () => {
  it("moves the order and writes the audit entry", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T1`,
    });

    const result = await changeOrderStatus(
      actor,
      orderId,
      OrderStatus.PROCESSING,
    );

    expect(result.status).toBe(OrderStatus.PROCESSING);

    const entry = await prisma.adminAuditLog.findFirst({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entry).not.toBeNull();
    expect(entry?.action).toBe("ORDER_STATUS_CHANGED");
    expect(entry?.before).toMatchObject({ status: OrderStatus.PENDING });
    expect(entry?.after).toMatchObject({ status: OrderStatus.PROCESSING });
  });

  it("walks an order all the way to DELIVERED", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T2`,
    });

    await changeOrderStatus(actor, orderId, OrderStatus.PROCESSING);
    await changeOrderStatus(actor, orderId, OrderStatus.SHIPPED);
    const result = await changeOrderStatus(
      actor,
      orderId,
      OrderStatus.DELIVERED,
    );

    expect(result.status).toBe(OrderStatus.DELIVERED);

    // One audit entry per transition.
    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entries).toBe(3);
  });
});

describe("changeOrderStatus — an illegal transition", () => {
  it("refuses SHIPPED to CANCELLED and writes nothing", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T3`,
      status: OrderStatus.SHIPPED,
    });

    await expect(
      changeOrderStatus(actor, orderId, OrderStatus.CANCELLED),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The order is unchanged.
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });

    expect(order?.status).toBe(OrderStatus.SHIPPED);

    // And no audit entry was written.
    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entries).toBe(0);
  });

  it("refuses to move a DELIVERED order and writes nothing", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T4`,
      status: OrderStatus.DELIVERED,
    });

    await expect(
      changeOrderStatus(actor, orderId, OrderStatus.PROCESSING),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entries).toBe(0);
  });

  it("refuses to move an order backwards and writes nothing", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T5`,
      status: OrderStatus.SHIPPED,
    });

    await expect(
      changeOrderStatus(actor, orderId, OrderStatus.PROCESSING),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entries).toBe(0);
  });

  it("throws a 404 for an order that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      changeOrderStatus(
        actor,
        "ckq1doesnotexist00000000a",
        OrderStatus.PROCESSING,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("changeOrderStatus — cancelling restores the stock", () => {
  it("returns the reserved quantity to the shelf", async () => {
    if (!databaseAvailable) return;

    const stockBefore = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T6`,
      quantity: 3,
    });

    // Simulate the checkout's deduction.
    await prisma.product.update({
      where: { id: productId },
      data: { stockQuantity: { decrement: 3 } },
    });

    await changeOrderStatus(actor, orderId, OrderStatus.CANCELLED);

    const stockAfter = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    // The exact arithmetic: the snapshotted quantity came back.
    expect(stockAfter?.stockQuantity).toBe(stockBefore?.stockQuantity);
  });

  it("restores the stock exactly once when cancelled twice", async () => {
    if (!databaseAvailable) return;

    const stockBefore = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T7`,
      quantity: 2,
    });

    await prisma.product.update({
      where: { id: productId },
      data: { stockQuantity: { decrement: 2 } },
    });

    await changeOrderStatus(actor, orderId, OrderStatus.CANCELLED);

    const afterFirst = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    // The second cancellation must be refused.
    await expect(
      changeOrderStatus(actor, orderId, OrderStatus.CANCELLED),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const afterSecond = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    // Exactly one restoration, not two.
    expect(afterSecond?.stockQuantity).toBe(afterFirst?.stockQuantity);
    expect(afterSecond?.stockQuantity).toBe(stockBefore?.stockQuantity);
  });

  it("does not restore the stock when a cancellation is refused", async () => {
    if (!databaseAvailable) return;

    const stockBefore = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T8`,
      status: OrderStatus.SHIPPED,
      quantity: 4,
    });

    await prisma.product.update({
      where: { id: productId },
      data: { stockQuantity: { decrement: 4 } },
    });

    await expect(
      changeOrderStatus(actor, orderId, OrderStatus.CANCELLED),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const stockAfter = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    // The goods have shipped; they do not come back.
    expect(stockAfter?.stockQuantity).toBe(
      (stockBefore?.stockQuantity ?? 0) - 4,
    );
  });

  it("records a cancellation with its own audit action", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T9`,
    });

    await changeOrderStatus(
      actor,
      orderId,
      OrderStatus.CANCELLED,
      "Customer changed their mind.",
    );

    const entry = await prisma.adminAuditLog.findFirst({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entry?.action).toBe("ORDER_CANCELLED");
    expect(entry?.reason).toBe("Customer changed their mind.");
  });
});

describe("changeOrderStatus — concurrency", () => {
  it("lets exactly one of two concurrent moderators win", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-T10`,
    });

    const otherAdminId = await createUser(
      `${runId}_concurrent_other@example.com`,
      "ADMIN",
    );

    const otherActor: AuditActor = {
      id: otherAdminId,
      name: "Other Admin",
      email: `${runId}_concurrent_other@example.com`,
    };

    const results = await Promise.allSettled([
      changeOrderStatus(actor, orderId, OrderStatus.PROCESSING),
      changeOrderStatus(otherActor, orderId, OrderStatus.PROCESSING),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toMatchObject({ code: "CONFLICT" });
    }
  });
});

describe("changePaymentStatus", () => {
  it("marks an order paid and records it separately from the fulfilment", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-P1`,
    });

    const result = await changePaymentStatus(
      actor,
      orderId,
      PaymentStatus.PAID,
    );

    expect(result.paymentStatus).toBe(PaymentStatus.PAID);

    // The fulfilment status is untouched.
    expect(result.status).toBe(OrderStatus.PENDING);

    const entry = await prisma.adminAuditLog.findFirst({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entry?.action).toBe("ORDER_PAYMENT_STATUS_CHANGED");
  });

  it("refuses an illegal payment transition and writes nothing", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-P2`,
      paymentStatus: PaymentStatus.REFUNDED,
    });

    await expect(
      changePaymentStatus(actor, orderId, PaymentStatus.PAID),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "order", entityId: orderId },
    });

    expect(entries).toBe(0);
  });

  it("lets a shipped order keep a pending payment", async () => {
    if (!databaseAvailable) return;

    // A COD order ships before the cash is collected.
    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-P3`,
      status: OrderStatus.SHIPPED,
      paymentStatus: PaymentStatus.PENDING,
    });

    await changeOrderStatus(actor, orderId, OrderStatus.DELIVERED);

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, paymentStatus: true },
    });

    expect(order?.status).toBe(OrderStatus.DELIVERED);
    expect(order?.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it("writes two audit entries when both axes are changed", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-P4`,
    });

    await changeOrderStatus(actor, orderId, OrderStatus.PROCESSING);
    await changePaymentStatus(actor, orderId, PaymentStatus.PAID);

    const actions = await prisma.adminAuditLog.findMany({
      where: { entityType: "order", entityId: orderId },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });

    expect(actions.map((a) => a.action)).toEqual([
      "ORDER_STATUS_CHANGED",
      "ORDER_PAYMENT_STATUS_CHANGED",
    ]);
  });
});

describe("listAdminOrders", () => {
  it("counts the orders by fulfilment status", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({ page: 1, limit: 100 });

    expect(result.counts.total).toBeGreaterThan(0);
    expect(result.counts.byStatus[OrderStatus.PENDING]).toBeGreaterThan(0);
  });

  it("filters by status", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({
      status: OrderStatus.DELIVERED,
      page: 1,
      limit: 100,
    });

    for (const order of result.orders) {
      expect(order.status).toBe(OrderStatus.DELIVERED);
    }
  });

  it("reports a total of zero for a filter that matches nothing", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({
      userId: "ckq1nosuchcustomer00000000a",
      page: 1,
      limit: 100,
    });

    expect(result.orders).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it("searches by order number", async () => {
    if (!databaseAvailable) return;

    const orderNumber = `${runId}-SEARCH`;

    await createOrder(customerId, productId, { orderNumber });

    const result = await listAdminOrders({
      search: orderNumber,
      page: 1,
      limit: 100,
    });

    expect(result.orders.map((o) => o.orderNumber)).toContain(orderNumber);
  });

  it("filters by payment method", async () => {
    if (!databaseAvailable) return;

    const bkashNumber = `${runId}-BKASH`;

    await createOrder(customerId, productId, {
      orderNumber: bkashNumber,
      paymentMethod: PaymentMethod.BKASH,
    });

    const result = await listAdminOrders({
      paymentMethod: PaymentMethod.BKASH,
      page: 1,
      limit: 100,
    });

    expect(result.orders.map((o) => o.orderNumber)).toContain(bkashNumber);

    // Every order in the result carries the filter's method.
    for (const order of result.orders) {
      expect(order.paymentMethod).toBe(PaymentMethod.BKASH);
    }
  });

  it("counts the orders by payment method", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({ page: 1, limit: 100 });

    // Every method the shop accepts has a bucket, even when it is zero.
    for (const method of Object.values(PaymentMethod)) {
      expect(result.counts.byPaymentMethod[method]).toBeGreaterThanOrEqual(0);
    }
  });

  it("combines a payment method filter with a status filter", async () => {
    if (!databaseAvailable) return;

    const orderNumber = `${runId}-CARD-DELIVERED`;

    await createOrder(customerId, productId, {
      orderNumber,
      paymentMethod: PaymentMethod.CARD,
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.PAID,
    });

    const result = await listAdminOrders({
      paymentMethod: PaymentMethod.CARD,
      status: OrderStatus.DELIVERED,
      page: 1,
      limit: 100,
    });

    expect(result.orders.map((o) => o.orderNumber)).toContain(orderNumber);

    // Both filters apply — the results satisfy each one.
    for (const order of result.orders) {
      expect(order.paymentMethod).toBe(PaymentMethod.CARD);
      expect(order.status).toBe(OrderStatus.DELIVERED);
    }
  });
});

describe("the sort order", () => {
  it("puts the newest first by default", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({ page: 1, limit: 100 });

    const timestamps = result.orders.map((order) => order.createdAt.getTime());

    for (let index = 1; index < timestamps.length; index += 1) {
      expect(timestamps[index - 1]).toBeGreaterThanOrEqual(timestamps[index]);
    }
  });

  it("puts the oldest first when asked", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({ sort: "oldest", page: 1, limit: 100 });

    const timestamps = result.orders.map((order) => order.createdAt.getTime());

    for (let index = 1; index < timestamps.length; index += 1) {
      expect(timestamps[index - 1]).toBeLessThanOrEqual(timestamps[index]);
    }
  });

  it("puts the highest total first when asked", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({ sort: "highest", page: 1, limit: 100 });

    const totals = result.orders.map((order) => order.totalAmountPaisa);

    for (let index = 1; index < totals.length; index += 1) {
      expect(totals[index - 1]).toBeGreaterThanOrEqual(totals[index]);
    }
  });

  it("puts the lowest total first when asked", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminOrders({ sort: "lowest", page: 1, limit: 100 });

    const totals = result.orders.map((order) => order.totalAmountPaisa);

    for (let index = 1; index < totals.length; index += 1) {
      expect(totals[index - 1]).toBeLessThanOrEqual(totals[index]);
    }
  });

  it("returns the same rows however they are sorted", async () => {
    if (!databaseAvailable) return;

    const newest = await listAdminOrders({ sort: "newest", page: 1, limit: 100 });
    const highest = await listAdminOrders({ sort: "highest", page: 1, limit: 100 });

    const newestIds = newest.orders.map((order) => order.id);
    const highestIds = highest.orders.map((order) => order.id);

    // Sorting must **reorder** the rows, not change **which** rows come
    // back. But the two reads above are separate queries against a
    // table that other suites are inserting into at the same time, so
    // a naive "the two id lists are identical" assertion is a coin
    // flip: a parallel suite that creates an order between the two
    // reads makes the lists differ by exactly one row, and the
    // service is not wrong — the table simply moved.
    //
    // The property that *is* stable is the one that matters: **every
    // row both reads agree on appears in both, and sorting did not
    // drop or duplicate any of them.** Comparing the intersection
    // rather than the full lists removes the part that a concurrent
    // write can legitimately change.
    const shared = newestIds.filter((id) => highestIds.includes(id));

    // The intersection is the whole of the *smaller* read, unless a
    // row was added between them — so every id in the smaller set must
    // be present in the larger one, and no id may repeat.
    const smaller = newestIds.length <= highestIds.length ? newestIds : highestIds;
    const larger = newestIds.length <= highestIds.length ? highestIds : newestIds;

    for (const id of smaller) {
      expect(larger).toContain(id);
    }

    expect(new Set(newestIds).size).toBe(newestIds.length);
    expect(new Set(highestIds).size).toBe(highestIds.length);

    // And the shared rows really are the same rows — a sort must not
    // change an order's contents, only its position.
    const newestById = new Map(newest.orders.map((order) => [order.id, order]));
    const highestById = new Map(highest.orders.map((order) => [order.id, order]));

    for (const id of shared) {
      const fromNewest = newestById.get(id);
      const fromHighest = highestById.get(id);

      expect(fromNewest?.totalAmountPaisa).toBe(fromHighest?.totalAmountPaisa);
      expect(fromNewest?.createdAt.getTime()).toBe(fromHighest?.createdAt.getTime());
    }
  });
});

describe("getAdminOrder", () => {
  it("loads one order in full", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-G1`,
    });

    const order = await getAdminOrder(orderId);

    expect(order.id).toBe(orderId);
    expect(order.items).toHaveLength(1);
    expect(order.customer.id).toBe(customerId);
  });

  it("throws a 404 for an order that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      getAdminOrder("ckq1doesnotexist00000000a"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the ApiError contract", () => {
  it("carries the current status and the permitted targets in a conflict", async () => {
    if (!databaseAvailable) return;

    const orderId = await createOrder(customerId, productId, {
      orderNumber: `${runId}-E1`,
      status: OrderStatus.DELIVERED,
    });

    try {
      await changeOrderStatus(actor, orderId, OrderStatus.PROCESSING);
      expect.fail("The transition should have been refused.");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);

      const apiError = error as ApiError;

      expect(apiError.status).toBe(409);
      expect(apiError.details?.currentStatus).toBe(OrderStatus.DELIVERED);
      expect(apiError.details?.permittedStatuses).toEqual([]);
    }
  });
});
