import { PaymentAttemptOutcome, PaymentStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import type { SessionUser } from "@/lib/auth/guards";
import { openGatewaySession, settleGatewayPayment } from "@/lib/payments/gateway";
import { placeOrder } from "@/lib/orders/service";

/**
 * The payment gateway's integration tests.
 *
 * These exercise the real database and the real Prisma transaction. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. A settlement moves the payment to `PAID`, consumes the one-time
 *      token, records the gateway's own reference, and writes the audit
 *      entry — all together, or not at all.
 *
 *   2. **A failed attempt leaves the reservation intact.** The payment
 *      stays `PENDING`, the stock stays deducted, and the failure is
 *      recorded as a `PaymentAttempt` row.
 *
 *   3. **A failed attempt can be retried on the same order, and the
 *      retry succeeds — with the stock restored exactly zero times.**
 *
 *      That last one is the test this whole file exists for. It is the
 *      difference between "the customer can retry" and "the customer can
 *      retry without the shop selling the same item twice".
 *
 *   4. The authorisation holds: another customer cannot settle somebody
 *      else's order, a wrong token is refused, and a settled order cannot
 *      be settled again.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed — an unreachable database
 * is an environment problem, not a defect in the code under test.
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

/**
 * A unique suffix so parallel runs do not collide.
 */
const runId = `test_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

/**
 * Creates a user for the test, and returns the session user the gateway
 * expects.
 *
 * The gateway takes a `SessionUser` rather than a bare id, because the
 * audit entry it writes needs the actor's **name** and **email** — the
 * trail should name a human even if the account is deleted later.
 */
async function createUser(
  email: string,
  role: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<SessionUser> {
  const user = await prisma.user.create({
    data: {
      name: "Test Customer",
      email,
      // A hash of a value no login will ever use. The tests never
      // authenticate.
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role,
    },
    select: { id: true, email: true, name: true, role: true },
  });

  createdUserIds.push(user.id);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: null,
    smsOptIn: false,
  };
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
    stockQuantity?: number;
  } = {},
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Test product ${name}`,
      categoryId,
      pricePaisa: options.pricePaisa ?? 100000,
      discountPricePaisa: null,
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
  confirmConflicts: false,
};

/**
 * A valid transfer reference.
 *
 * ── Why the settle carries it ─────────────────────────────────────────────
 *
 * The transfer reference is quoted in the **gateway window**, not at
 * checkout, and it arrives with the settle request rather than the
 * placement request. So a bKash order is placed with no TrxID — the
 * order row starts with `paymentSenderNumber` and
 * `paymentTransactionId` as `null` — and the settle writes them onto
 * the order as it marks it `PAID`.
 *
 * The requirement that a mobile-banking order **must** settle with a
 * transfer reference is therefore enforced at the settle, not at the
 * placement.
 */
const TRANSFER = {
  paymentSenderNumber: "01712345678",
  paymentTransactionId: "8N3F2K9LM4",
};

/**
 * Places a bKash order and returns its id, number, session token and the
 * product whose stock was reserved.
 */
async function placeGatewayOrder(
  userId: string,
  productId: string,
  slug: string,
  quantity = 1,
): Promise<{
  orderId: string;
  orderNumber: string;
  sessionId: string;
  productId: string;
}> {
  const categoryId = await createCategory("T", `${runId}_${slug}`);
  const createdProductId = await createProduct(categoryId, slug, {
    pricePaisa: 50000,
    stockQuantity: 10,
  });

  await addToCart(userId, createdProductId, quantity);

  const result = await placeOrder(userId, {
    ...CHECKOUT,
    paymentMethod: "BKASH",
  });

  const sessionId = result.gateway?.sessionId;
  if (!sessionId) {
    throw new Error("Expected a gateway session for a bKash order.");
  }

  return {
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    sessionId,
    productId: createdProductId,
  };
}

/**
 * The current stock of a product.
 */
async function stockOf(productId: string): Promise<number> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { stockQuantity: true },
  });

  return product?.stockQuantity ?? -1;
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the payment " +
        "gateway integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  // Clean up in dependency order. The `payment_attempts` table has an
  // `onDelete: Restrict` foreign key to `orders`, so the attempts must
  // go before the orders they belong to.
  try {
    await prisma.paymentAttempt.deleteMany({
      where: { order: { userId: { in: createdUserIds } } },
    });
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

describe("placing an order through the gateway", () => {
  it("gives a cash-on-delivery order no gateway session", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_cod@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_cod`);
    const productId = await createProduct(categoryId, "Cod", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(user.id, productId, 1);

    const result = await placeOrder(user.id, {
      ...CHECKOUT,
      paymentMethod: "COD",
    });

    // There is nothing for a gateway to settle, so no session is minted.
    expect(result.gateway).toBeNull();

    const order = await prisma.order.findUnique({
      where: { id: result.orderId },
      select: { paymentGatewaySessionId: true },
    });

    expect(order?.paymentGatewaySessionId).toBeNull();
  });

  it("gives a bKash order a gateway session carrying the server's total", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_bkash@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_bkash`);
    const productId = await createProduct(categoryId, "Bkash", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(user.id, productId, 2);

    const result = await placeOrder(user.id, {
      ...CHECKOUT,
      paymentMethod: "BKASH",
    });

    const gateway = result.gateway;
    expect(gateway).not.toBeNull();
    expect(gateway?.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(gateway?.merchantName).toBe("Euro Glam BD");
    expect(gateway?.orderId).toBe(result.orderId);
    expect(gateway?.orderNumber).toBe(result.orderNumber);
    expect(gateway?.paymentMethod).toBe("BKASH");

    // The amount is the server's, not the client's.
    expect(gateway?.amountPaisa).toBe(result.totalAmountPaisa);

    const order = await prisma.order.findUnique({
      where: { id: result.orderId },
      select: { paymentGatewaySessionId: true },
    });

    expect(order?.paymentGatewaySessionId).toBe(gateway?.sessionId);
  });

  it("gives a card order a gateway session and leaves the customer's transfer reference empty", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_card@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_card`);
    const productId = await createProduct(categoryId, "Card", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(user.id, productId, 1);

    const result = await placeOrder(user.id, {
      ...CHECKOUT,
      paymentMethod: "CARD",
    });

    expect(result.gateway).not.toBeNull();

    // A card order has no TrxID — the checkout schema refuses one, and
    // the database must agree.
    const order = await prisma.order.findUnique({
      where: { id: result.orderId },
      select: { paymentTransactionId: true, paymentSenderNumber: true },
    });

    expect(order?.paymentTransactionId).toBeNull();
    expect(order?.paymentSenderNumber).toBeNull();
  });
});

describe("settling a gateway payment", () => {
  it("moves the payment to PAID, consumes the token and records the reference", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_settle@example.com`);
    const order = await placeGatewayOrder(user.id, "", "settle");

    const result = await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    expect(result.order.paymentStatus).toBe(PaymentStatus.PAID);
    expect(result.order.transactionId).toBe(`${order.orderNumber}-GW`);
    expect(result.attempt.outcome).toBe(PaymentAttemptOutcome.SUCCESS);
    expect(result.attempt.failureMessage).toBeNull();

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: {
        paymentStatus: true,
        paymentGatewaySessionId: true,
        paymentGatewayTransactionId: true,
      },
    });

    expect(stored?.paymentStatus).toBe(PaymentStatus.PAID);

    // The token is **consumed** — that is what makes it one-shot in the
    // database, not merely in the application logic.
    expect(stored?.paymentGatewaySessionId).toBeNull();
    expect(stored?.paymentGatewayTransactionId).toBe(`${order.orderNumber}-GW`);
  });

  it("records the attempt and the audit entry together", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_audit@example.com`);
    const order = await placeGatewayOrder(user.id, "", "audit");

    await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    const attempts = await prisma.paymentAttempt.findMany({
      where: { orderId: order.orderId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe(PaymentAttemptOutcome.SUCCESS);

    const entries = await prisma.adminAuditLog.findMany({
      where: { entityId: order.orderId, entityType: "order" },
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const settled = entries.find(
      (entry) => entry.action === "ORDER_PAYMENT_GATEWAY_SETTLED",
    );
    expect(settled).toBeDefined();

    // The actor is the **customer**, not a staff member. The audit trail
    // must answer "who did this?" — and the answer is the customer.
    expect(settled?.actorId).toBe(user.id);
  });

  it("keeps both references on a bKash order — the customer's and the gateway's", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_both@example.com`);
    const order = await placeGatewayOrder(user.id, "", "both");

    await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: {
        paymentTransactionId: true,
        paymentGatewayTransactionId: true,
      },
    });

    // The customer's own TrxID, and the gateway's reference — two
    // different things, kept apart.
    expect(stored?.paymentTransactionId).toBe("8N3F2K9LM4");
    expect(stored?.paymentGatewayTransactionId).toBe(`${order.orderNumber}-GW`);
  });

  it("keeps a card order's transfer reference empty and puts the gateway's in its own column", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_cardsettle@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_cards`);
    const productId = await createProduct(categoryId, "CardS", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(user.id, productId, 1);

    const placed = await placeOrder(user.id, {
      ...CHECKOUT,
      paymentMethod: "CARD",
    });

    await settleGatewayPayment(
      user,
      placed.orderId,
      placed.gateway!.sessionId,
      PaymentAttemptOutcome.SUCCESS,
    );

    const stored = await prisma.order.findUnique({
      where: { id: placed.orderId },
      select: {
        paymentTransactionId: true,
        paymentGatewayTransactionId: true,
      },
    });

    // The gateway's reference must **not** land in the customer's
    // transfer column — the database has to keep the checkout schema's
    // rule true with no exceptions.
    expect(stored?.paymentTransactionId).toBeNull();
    expect(stored?.paymentGatewayTransactionId).toBe(
      `${placed.orderNumber}-GW`,
    );
  });

  it("writes the customer's transfer reference onto the order as it settles", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_transfer@example.com`);
    const order = await placeGatewayOrder(user.id, "", "transfer");

    // The order was placed with **no** transfer reference — the customer
    // quotes it in the gateway window, after the order exists.
    const before = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentSenderNumber: true, paymentTransactionId: true },
    });

    expect(before?.paymentSenderNumber).toBeNull();
    expect(before?.paymentTransactionId).toBeNull();

    await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    // The settle is what writes them. The order row ends up carrying a
    // complete, reconcilable reference — only the *moment* the customer
    // was asked has moved.
    const after = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentSenderNumber: true, paymentTransactionId: true },
    });

    expect(after?.paymentSenderNumber).toBe("01712345678");
    expect(after?.paymentTransactionId).toBe("8N3F2K9LM4");
  });

  it("refuses to settle a mobile-banking order without a transfer reference", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_notransfer@example.com`);
    const order = await placeGatewayOrder(user.id, "", "notransfer");

    // An order that settles with no TrxID is an order the shop cannot
    // reconcile against a merchant statement.
    await expect(
      settleGatewayPayment(
        user,
        order.orderId,
        order.sessionId,
        PaymentAttemptOutcome.SUCCESS,
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Nothing was written — the payment is untouched and the token is
    // still live, so the customer can quote the TrxID and try again.
    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: {
        paymentStatus: true,
        paymentGatewaySessionId: true,
        paymentTransactionId: true,
      },
    });

    expect(stored?.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(stored?.paymentGatewaySessionId).toBe(order.sessionId);
    expect(stored?.paymentTransactionId).toBeNull();
  });

  it("refuses to settle a card order WITH a transfer reference", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_cardtransfer@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_cardtransfer`);
    const productId = await createProduct(categoryId, "CardT", {
      pricePaisa: 50000,
      stockQuantity: 5,
    });

    await addToCart(user.id, productId, 1);

    const placed = await placeOrder(user.id, {
      ...CHECKOUT,
      paymentMethod: "CARD",
    });

    // A recorded transfer that does not exist is worse than a missing
    // one — the admin would look for a payment that was never made.
    await expect(
      settleGatewayPayment(
        user,
        placed.orderId,
        placed.gateway!.sessionId,
        PaymentAttemptOutcome.SUCCESS,
        TRANSFER,
      ),
    ).rejects.toMatchObject({ status: 400 });

    const stored = await prisma.order.findUnique({
      where: { id: placed.orderId },
      select: { paymentStatus: true, paymentTransactionId: true },
    });

    expect(stored?.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(stored?.paymentTransactionId).toBeNull();
  });
});

describe("a failed gateway attempt", () => {
  it("leaves the payment pending and does NOT restore the stock", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_fail@example.com`);
    const order = await placeGatewayOrder(user.id, "", "fail", 2);

    // The order reserved two units.
    expect(await stockOf(order.productId)).toBe(8);

    const result = await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.FAILED,
      TRANSFER,
    );

    // The payment is **still pending** — a failed attempt is not a
    // failed payment.
    expect(result.order.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(result.attempt.outcome).toBe(PaymentAttemptOutcome.FAILED);
    expect(result.attempt.failureMessage).toBeTruthy();

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: {
        paymentStatus: true,
        paymentGatewaySessionId: true,
        paymentGatewayTransactionId: true,
      },
    });

    expect(stored?.paymentStatus).toBe(PaymentStatus.PENDING);

    // The token is still live, so the customer can retry.
    expect(stored?.paymentGatewaySessionId).toBe(order.sessionId);
    expect(stored?.paymentGatewayTransactionId).toBeNull();

    // And the stock is **still reserved**. The order is still live, so
    // the goods must stay off the shelf.
    expect(await stockOf(order.productId)).toBe(8);
  });

  it("records the failed attempt and an audit entry that names the failure", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_failaudit@example.com`);
    const order = await placeGatewayOrder(user.id, "", "failaudit");

    await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.FAILED,
      TRANSFER,
    );

    const attempts = await prisma.paymentAttempt.findMany({
      where: { orderId: order.orderId },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe(PaymentAttemptOutcome.FAILED);
    expect(attempts[0]?.failureMessage).toBeTruthy();

    const entries = await prisma.adminAuditLog.findMany({
      where: {
        entityId: order.orderId,
        action: "ORDER_PAYMENT_GATEWAY_SETTLED",
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(user.id);
  });

  it("can be retried on the SAME order — and the stock is restored exactly zero times", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_retry@example.com`);
    const order = await placeGatewayOrder(user.id, "", "retry", 2);

    const before = await stockOf(order.productId);
    expect(before).toBe(8);

    // The customer tries once, and the gateway declines.
    await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.FAILED,
      TRANSFER,
    );

    // They try again on the same order, and it goes through.
    const result = await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    expect(result.order.paymentStatus).toBe(PaymentStatus.PAID);
    expect(result.attempt.outcome).toBe(PaymentAttemptOutcome.SUCCESS);

    // **The proof that the design does not oversell.** The stock was
    // restored zero times: it was never released, because the order
    // never ended. Had the failure restored the stock, the retry would
    // be collecting money for goods that had already gone back on the
    // shelf — and may have been sold to somebody else.
    expect(await stockOf(order.productId)).toBe(before);

    // Both attempts are on the record.
    const attempts = await prisma.paymentAttempt.findMany({
      where: { orderId: order.orderId },
      orderBy: { createdAt: "asc" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.outcome)).toEqual([
      PaymentAttemptOutcome.FAILED,
      PaymentAttemptOutcome.SUCCESS,
    ]);
  });
});

describe("the gateway's authorisation", () => {
  it("refuses to settle another customer's order", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}_owner@example.com`);
    const stranger = await createUser(`${runId}_stranger@example.com`);
    const order = await placeGatewayOrder(owner.id, "", "owner");

    await expect(
      settleGatewayPayment(
        stranger,
        order.orderId,
        order.sessionId,
        PaymentAttemptOutcome.SUCCESS,
        TRANSFER,
      ),
    ).rejects.toMatchObject({ status: 404 });

    // The order is untouched.
    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentStatus: true, paymentGatewaySessionId: true },
    });

    expect(stored?.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(stored?.paymentGatewaySessionId).toBe(order.sessionId);
  });

  it("refuses a wrong session token and changes nothing", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_wrongtoken@example.com`);
    const order = await placeGatewayOrder(user.id, "", "wrongtoken");

    await expect(
      settleGatewayPayment(
        user,
        order.orderId,
        "f".repeat(32),
        PaymentAttemptOutcome.SUCCESS,
        TRANSFER,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentStatus: true, paymentGatewaySessionId: true },
    });

    expect(stored?.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(stored?.paymentGatewaySessionId).toBe(order.sessionId);

    // No attempt was recorded, and no audit entry was written — a
    // refused request leaves no trace of itself.
    expect(
      await prisma.paymentAttempt.count({ where: { orderId: order.orderId } }),
    ).toBe(0);
    expect(
      await prisma.adminAuditLog.count({
        where: {
          entityId: order.orderId,
          action: "ORDER_PAYMENT_GATEWAY_SETTLED",
        },
      }),
    ).toBe(0);
  });

  it("refuses to settle an order that has already been settled", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_replay@example.com`);
    const order = await placeGatewayOrder(user.id, "", "replay");

    await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    // The replay is refused.
    await expect(
      settleGatewayPayment(
        user,
        order.orderId,
        order.sessionId,
        PaymentAttemptOutcome.SUCCESS,
        TRANSFER,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // And there is exactly **one** successful settlement on the record.
    expect(
      await prisma.adminAuditLog.count({
        where: {
          entityId: order.orderId,
          action: "ORDER_PAYMENT_GATEWAY_SETTLED",
        },
      }),
    ).toBe(1);
  });

  it("lets exactly one of two concurrent settles win", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_race@example.com`);
    const order = await placeGatewayOrder(user.id, "", "race");

    const outcomes = await Promise.allSettled([
      settleGatewayPayment(
        user,
        order.orderId,
        order.sessionId,
        PaymentAttemptOutcome.SUCCESS,
        TRANSFER,
      ),
      settleGatewayPayment(
        user,
        order.orderId,
        order.sessionId,
        PaymentAttemptOutcome.SUCCESS,
        TRANSFER,
      ),
    ]);

    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);

    // The loser's failure is a conflict, not a crash.
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(ApiError);
    expect((rejected?.reason as ApiError).status).toBe(409);

    // Exactly one settlement was recorded.
    expect(
      await prisma.adminAuditLog.count({
        where: {
          entityId: order.orderId,
          action: "ORDER_PAYMENT_GATEWAY_SETTLED",
        },
      }),
    ).toBe(1);
  });
});

describe("re-arming a gateway session", () => {
  it("rotates the token for an order whose payment is still pending", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_rearm@example.com`);
    const order = await placeGatewayOrder(user.id, "", "rearm");

    const session = await openGatewaySession(user, order.orderId);

    expect(session.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(session.sessionId).not.toBe(order.sessionId);
    expect(session.merchantName).toBe("Euro Glam BD");
    expect(session.orderId).toBe(order.orderId);

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentGatewaySessionId: true },
    });

    expect(stored?.paymentGatewaySessionId).toBe(session.sessionId);

    // The **old** token no longer works.
    await expect(
      settleGatewayPayment(
        user,
        order.orderId,
        order.sessionId,
        PaymentAttemptOutcome.SUCCESS,
        TRANSFER,
      ),
    ).rejects.toMatchObject({ status: 409 });

    // The new one does.
    const result = await settleGatewayPayment(
      user,
      order.orderId,
      session.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    expect(result.order.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it("refuses to re-arm a settled order", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_rearmpaid@example.com`);
    const order = await placeGatewayOrder(user.id, "", "rearmpaid");

    await settleGatewayPayment(
      user,
      order.orderId,
      order.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );

    await expect(openGatewaySession(user, order.orderId)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("refuses to re-arm another customer's order", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}_rearmowner@example.com`);
    const stranger = await createUser(`${runId}_rearmstranger@example.com`);
    const order = await placeGatewayOrder(owner.id, "", "rearmowner");

    await expect(
      openGatewaySession(stranger, order.orderId),
    ).rejects.toMatchObject({ status: 404 });
  });
});
