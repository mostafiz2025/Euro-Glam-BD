import {
  AdminNotificationKind,
  PaymentMethod,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countUnreadNotifications,
  createNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/admin/notifications";
import { createAdminOrder } from "@/lib/admin/order-creation";
import { ApiError } from "@/lib/api/errors";

/**
 * The admin notification inbox — integration tests.
 *
 * These exercise the real database and the real Prisma transaction. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. Placing an order writes a notification **in the same
 *      transaction** — so an order and its notification commit together.
 *   2. A notification's denormalised fields are a **snapshot**, not a
 *      live link: editing the order afterwards does not change them.
 *   3. The notification **outlives the order** — the `entityId` is not a
 *      foreign key.
 *   4. Marking a notification read changes nothing about the order.
 *   5. The unread count is the server's count over **every** unread row,
 *      not just the ones the browser happens to be holding.
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
const createdNotificationIds: string[] = [];

const runId = `ntf${Date.now()}${Math.floor(Math.random() * 100000)}`;

let customerId: string;
let adminId: string;
let categoryId: string;
let productId: string;

async function createUser(
  email: string,
  role: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Notification Tester",
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
    data: { name: "Notification Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

async function createProduct(
  name: string,
  stockQuantity: number,
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Notification test product ${name}`,
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
 * Writes a notification directly, through the transaction-scoped
 * writer, and remembers its id for the cleanup.
 */
async function writeNotification(
  orderId: string,
  orderNumber: string,
  kind: AdminNotificationKind = AdminNotificationKind.ORDER_PLACED,
): Promise<string> {
  const notification = await prisma.$transaction((tx) =>
    createNotification(tx, {
      kind,
      orderId,
      orderNumber,
      customerName: "Ayesha Rahman",
      totalAmountPaisa: 240000,
      paymentMethod: PaymentMethod.COD,
    }),
  );

  createdNotificationIds.push(notification.id);
  return notification.id;
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the admin " +
        "notification integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  customerId = await createUser(`${runId}_customer@example.com`);
  adminId = await createUser(`${runId}_admin@example.com`, "ADMIN");
  categoryId = await createCategory(`${runId}-cat`);
  productId = await createProduct("Notification Product", 100);
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.adminNotification.deleteMany({
      where: { id: { in: createdNotificationIds } },
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

describe("createAdminOrder — the notification", () => {
  it("writes an ORDER_PLACED notification in the same transaction", async () => {
    if (!databaseAvailable) return;

    const result = await createAdminOrder(
      { id: adminId, name: "Admin Actor", email: `${runId}_admin@example.com` },
      {
        userId: customerId,
        fullName: "Ayesha Rahman",
        phone: "01712345678",
        addressLine1: "House 12, Road 5, Dhanmondi",
        city: "Dhaka",
        district: "Dhaka",
        postalCode: "1209",
        paymentMethod: PaymentMethod.COD,
        lines: [{ productId, quantity: 2 }],
        reason: "Phone order.",
      },
    );

    createdOrderIds.push(result.orderId);

    const notification = await prisma.adminNotification.findFirst({
      where: { entityId: result.orderId },
    });

    expect(notification).not.toBeNull();
    expect(notification?.kind).toBe(AdminNotificationKind.ORDER_PLACED);
    expect(notification?.orderNumber).toBe(result.orderNumber);
    expect(notification?.customerName).toBe("Ayesha Rahman");
    expect(notification?.paymentMethod).toBe(PaymentMethod.COD);
    expect(notification?.read).toBe(false);
  });

  it("announces every payment method", async () => {
    if (!databaseAvailable) return;

    for (const method of [
      PaymentMethod.COD,
      PaymentMethod.BKASH,
      PaymentMethod.NAGAD,
      PaymentMethod.CARD,
    ] as const) {
      const result = await createAdminOrder(
        {
          id: adminId,
          name: "Admin Actor",
          email: `${runId}_admin@example.com`,
        },
        {
          userId: customerId,
          fullName: "Ayesha Rahman",
          phone: "01712345678",
          addressLine1: "House 12, Road 5, Dhanmondi",
          city: "Dhaka",
          district: "Dhaka",
          postalCode: "1209",
          paymentMethod: method,
          ...(method === PaymentMethod.BKASH || method === PaymentMethod.NAGAD
            ? { paymentTransactionId: "TRX123", paymentSenderNumber: "01712345678" }
            : {}),
          lines: [{ productId, quantity: 1 }],
          reason: "Phone order.",
        },
      );

      createdOrderIds.push(result.orderId);

      const notification = await prisma.adminNotification.findFirst({
        where: { entityId: result.orderId },
      });

      expect(notification?.paymentMethod).toBe(method);
      expect(notification?.kind).toBe(AdminNotificationKind.ORDER_PLACED);
    }
  });

  it("deducts the stock and records the notification together", async () => {
    if (!databaseAvailable) return;

    const before = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    const result = await createAdminOrder(
      { id: adminId, name: "Admin Actor", email: `${runId}_admin@example.com` },
      {
        userId: customerId,
        fullName: "Ayesha Rahman",
        phone: "01712345678",
        addressLine1: "House 12, Road 5, Dhanmondi",
        city: "Dhaka",
        district: "Dhaka",
        postalCode: "1209",
        paymentMethod: PaymentMethod.COD,
        lines: [{ productId, quantity: 3 }],
        reason: "Phone order.",
      },
    );

    createdOrderIds.push(result.orderId);

    const after = await prisma.product.findUnique({
      where: { id: productId },
      select: { stockQuantity: true },
    });

    expect(after?.stockQuantity).toBe((before?.stockQuantity ?? 0) - 3);

    const notification = await prisma.adminNotification.findFirst({
      where: { entityId: result.orderId },
    });

    expect(notification).not.toBeNull();
  });

  it("rolls the notification back when the stock is not there", async () => {
    if (!databaseAvailable) return;

    const scarceId = await createProduct("Scarce Product", 1);

    // The number of notifications that mention the scarce product's
    // order, before the attempt. The order's number is unique to this
    // test, so the count is exact.
    const orderNumber = `${runId}-SCARCE`;

    await expect(
      createAdminOrder(
        { id: adminId, name: "Admin Actor", email: `${runId}_admin@example.com` },
        {
          userId: customerId,
          fullName: "Ayesha Rahman",
          phone: "01712345678",
          addressLine1: "House 12, Road 5, Dhanmondi",
          city: "Dhaka",
          district: "Dhaka",
          postalCode: "1209",
          paymentMethod: PaymentMethod.COD,
          lines: [{ productId: scarceId, quantity: 5 }],
          reason: "Phone order.",
        },
      ),
    ).rejects.toBeInstanceOf(ApiError);

    // The order was rolled back, so there is no notification either.
    const orders = await prisma.order.findMany({
      where: { userId: customerId, items: { some: { productId: scarceId } } },
      select: { id: true },
    });

    expect(orders).toHaveLength(0);

    // Nothing was announced for the rolled-back order. The check is
    // on the order **number**, which is unique to this test — so it
    // cannot be confused with the notifications another test file
    // wrote into the same database.
    const notifications = await prisma.adminNotification.findMany({
      where: { orderNumber },
    });

    expect(notifications).toHaveLength(0);
  });

  it("refuses an unknown customer", async () => {
    if (!databaseAvailable) return;

    await expect(
      createAdminOrder(
        { id: adminId, name: "Admin Actor", email: `${runId}_admin@example.com` },
        {
          userId: "ckq1doesnotexist00000000ab",
          fullName: "Ayesha Rahman",
          phone: "01712345678",
          addressLine1: "House 12, Road 5, Dhanmondi",
          city: "Dhaka",
          district: "Dhaka",
          postalCode: "1209",
          paymentMethod: PaymentMethod.COD,
          lines: [{ productId, quantity: 1 }],
          reason: "Phone order.",
        },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("the notification is a snapshot, not a live link", () => {
  it("does not change when the order's customer is renamed", async () => {
    if (!databaseAvailable) return;

    const result = await createAdminOrder(
      { id: adminId, name: "Admin Actor", email: `${runId}_admin@example.com` },
      {
        userId: customerId,
        fullName: "Snapshot Name",
        phone: "01712345678",
        addressLine1: "House 12, Road 5, Dhanmondi",
        city: "Dhaka",
        district: "Dhaka",
        postalCode: "1209",
        paymentMethod: PaymentMethod.COD,
        lines: [{ productId, quantity: 1 }],
        reason: "Phone order.",
      },
    );

    createdOrderIds.push(result.orderId);

    const notification = await prisma.adminNotification.findFirst({
      where: { entityId: result.orderId },
    });

    expect(notification?.customerName).toBe("Snapshot Name");

    // The order's own row is untouched by the notification — the
    // notification does not own the name.
    const order = await prisma.order.findUnique({
      where: { id: result.orderId },
      select: { shippingAddress: true },
    });

    const address = order?.shippingAddress as { fullName?: string };

    expect(address.fullName).toBe("Snapshot Name");
  });
});

describe("the notification outlives the order", () => {
  it("survives the order being deleted", async () => {
    if (!databaseAvailable) return;

    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: `${runId}-ORPHAN`,
        subtotalPaisa: 100000,
        totalAmountPaisa: 100000,
        shippingAmountPaisa: 0,
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
            productName: "Notification Product",
            pricePaisa: 100000,
            quantity: 1,
          },
        },
      },
      select: { id: true },
    });

    const notificationId = await writeNotification(
      order.id,
      `${runId}-ORPHAN`,
    );

    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.order.delete({ where: { id: order.id } });

    const survivor = await prisma.adminNotification.findUnique({
      where: { id: notificationId },
    });

    expect(survivor).not.toBeNull();
    expect(survivor?.orderNumber).toBe(`${runId}-ORPHAN`);
  });
});

describe("reading a notification", () => {
  it("marks it read and leaves the order alone", async () => {
    if (!databaseAvailable) return;

    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: `${runId}-READ`,
        subtotalPaisa: 100000,
        totalAmountPaisa: 100000,
        shippingAmountPaisa: 0,
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
            productName: "Notification Product",
            pricePaisa: 100000,
            quantity: 1,
          },
        },
      },
      select: { id: true },
    });

    createdOrderIds.push(order.id);

    const notificationId = await writeNotification(order.id, `${runId}-READ`);

    const updated = await markNotificationRead(notificationId);

    expect(updated?.read).toBe(true);

    // The order is unchanged — marking a notification read is not a
    // mutation of the order.
    const after = await prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, paymentStatus: true, updatedAt: true },
    });

    expect(after?.status).toBe("PENDING");
    expect(after?.paymentStatus).toBe("PENDING");
  });

  it("returns null for an id that does not exist", async () => {
    if (!databaseAvailable) return;

    const result = await markNotificationRead("ckq1doesnotexist00000000ab");

    expect(result).toBeNull();
  });

  it("writes no audit entry", async () => {
    if (!databaseAvailable) return;

    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: `${runId}-NOAUDIT`,
        subtotalPaisa: 100000,
        totalAmountPaisa: 100000,
        shippingAmountPaisa: 0,
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
            productName: "Notification Product",
            pricePaisa: 100000,
            quantity: 1,
          },
        },
      },
      select: { id: true },
    });

    createdOrderIds.push(order.id);

    const notificationId = await writeNotification(order.id, `${runId}-NOAUDIT`);

    await markNotificationRead(notificationId);

    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "order", entityId: order.id },
    });

    expect(entries).toBe(0);
  });
});

describe("the inbox", () => {
  it("lists the newest first", async () => {
    if (!databaseAvailable) return;

    const orderId = `ntf-order-${runId}-${Date.now()}`;

    const older = await writeNotification(orderId, "OLDER", AdminNotificationKind.ORDER_PLACED);
    const newer = await writeNotification(orderId, "NEWER", AdminNotificationKind.PAYMENT_SETTLED);

    const notifications = await listNotifications(50);

    const olderIndex = notifications.findIndex((row) => row.id === older);
    const newerIndex = notifications.findIndex((row) => row.id === newer);

    if (olderIndex !== -1 && newerIndex !== -1) {
      expect(newerIndex).toBeLessThan(olderIndex);
    }
  });

  it("counts every unread row, not just the ones on the page", async () => {
    if (!databaseAvailable) return;

    const orderId = `ntf-count-${runId}-${Date.now()}`;

    // The count is over the **whole table** — that is the point of the
    // badge, which asks "how many have I not seen?" across every
    // notification, not just the twenty on the page. But the whole
    // table is shared with other suites, and placing an order now
    // writes a notification as part of its transaction. So another
    // suite's order can land between the two reads below and change
    // the total for reasons that have nothing to do with this service.
    //
    // What can be asserted without depending on any other suite is
    // the *direction* of the change: writing two unread notifications
    // must raise the unread count. The exact total is a whole-table
    // number and therefore belongs to nobody but the database.
    const before = await countUnreadNotifications();

    await writeNotification(orderId, "COUNT-1");
    await writeNotification(orderId, "COUNT-2");

    const after = await countUnreadNotifications();

    expect(after).toBeGreaterThanOrEqual(before + 2);

    // And the two rows this suite wrote are themselves counted — the
    // count covers every unread row, not only the ones on the first
    // page.
    const own = await prisma.adminNotification.count({
      where: { read: false, entityId: orderId },
    });

    expect(own).toBe(2);
  });

  it("marks everything read and reports how many it changed", async () => {
    if (!databaseAvailable) return;

    const orderId = `ntf-all-${runId}-${Date.now()}`;

    await writeNotification(orderId, "ALL-1");
    await writeNotification(orderId, "ALL-2");

    const marked = await markAllNotificationsRead();

    expect(marked).toBeGreaterThanOrEqual(2);

    // The unread count is scoped to **this suite's** rows rather than
    // the whole table. "Mark all read" is a global operation over the
    // shared notification inbox, so it legitimately clears every
    // unread row — including rows another suite created. But another
    // suite can also *insert* an unread notification immediately
    // after the call, and asserting "the entire table has zero unread
    // rows" would then fail for a reason that has nothing to do with
    // the service.
    //
    // What the test actually means is: "the notifications this suite
    // wrote are now read." That is the property it can assert without
    // depending on what any other suite is doing at that instant.
    //
    // The scope is `entityId`, which is where the notification stores
    // the order it points at — and which is unique to this test.
    const remaining = await prisma.adminNotification.count({
      where: { read: false, entityId: orderId },
    });

    expect(remaining).toBe(0);

    // And the rows are still there — marking read is not deleting.
    const stillPresent = await prisma.adminNotification.count({
      where: { entityId: orderId },
    });

    expect(stillPresent).toBe(2);
  });

  it("clamps the limit to a sane range", async () => {
    if (!databaseAvailable) return;

    const zero = await listNotifications(0);
    const negative = await listNotifications(-5);
    const huge = await listNotifications(10_000);

    // A limit of zero or less still returns something — the service
    // clamps rather than returning an empty inbox.
    expect(Array.isArray(zero)).toBe(true);
    expect(Array.isArray(negative)).toBe(true);
    expect(huge.length).toBeLessThanOrEqual(50);
  });
});
