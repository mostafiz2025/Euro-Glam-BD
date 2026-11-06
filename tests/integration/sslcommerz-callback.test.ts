import { OrderStatus, PaymentAttemptOutcome, PaymentStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/auth/guards";
import { placeOrder } from "@/lib/orders/service";
import {
  handleSslCommerzFailure,
  handleSslCommerzSuccess,
} from "@/lib/payments/sslcommerz-callback";
import { openSslCommerzSession } from "@/lib/payments/sslcommerz";

/**
 * The SSLCOMMERZ callback handler's integration tests.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The callback handler is the most security-critical piece of the
 * payment integration, because it is the only place where a **customer's
 * browser** can influence whether money is marked as received. So these
 * tests are about the properties a forged callback must not be able to
 * break:
 *
 *   1. **A forged callback does not settle a payment.** The gateway is
 *      asked whether the transaction is real; if it says no, the order
 *      is not touched. This is the test the whole file exists for.
 *
 *   2. **A valid-but-wrong amount does not settle a payment.** A
 *      customer could open two sessions, pay the cheaper one, and
 *      return the callback from the other.
 *
 *   3. **A replayed callback is idempotent.** A refresh must not write
 *      a second settlement.
 *
 *   4. **A failure does not move the payment to `FAILED`.** `FAILED` is
 *      terminal, so a declined attempt has to leave the payment at
 *      `PENDING` for the customer to be able to retry.
 *
 *   5. **A failed attempt does not restore the stock.** The order is
 *      still live, so the goods must stay off the shelf.
 *
 * The gateway is **mocked**. These tests are about the shop's reaction to
 * what the gateway says — and calling the real sandbox would make the
 * suite depend on a third party's uptime and would not let a test
 * manufacture the one answer that matters most: "no".
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
 * The answer the mocked gateway gives.
 *
 * `valid` is the single most important value in this file: it is what
 * the callback handler acts on, and it is what a forged callback cannot
 * control — because the real answer comes from a server-to-server call
 * the customer cannot make.
 */
let gatewayAnswer: {
  readonly status: string;
  readonly amount?: string;
  readonly bankTranId?: string;
  readonly cardType?: string;
} = { status: "VALID_TRANSACTION" };

vi.mock("@/lib/sslcommerz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sslcommerz")>();

  return {
    ...actual,
    validatePayment: vi.fn(async () => ({
      valid: gatewayAnswer.status === "VALID_TRANSACTION",
      raw: {
        status: gatewayAnswer.status,
        amount: gatewayAnswer.amount,
        bank_tran_id: gatewayAnswer.bankTranId,
      },
      sessionKey: null,
      bankTransactionId: gatewayAnswer.bankTranId ?? null,
      amountTaka: gatewayAnswer.amount ? Number(gatewayAnswer.amount) : null,
      tranId: null,
      rail: actual.detectSslCommerzRail(gatewayAnswer.cardType),
    })),
    validatePaymentBySessionKey: vi.fn(async () => ({
      valid: gatewayAnswer.status === "VALID_TRANSACTION",
      raw: {
        status: gatewayAnswer.status,
        amount: gatewayAnswer.amount,
        bank_tran_id: gatewayAnswer.bankTranId,
      },
      sessionKey: "mocked-session-key",
      bankTransactionId: gatewayAnswer.bankTranId ?? null,
      amountTaka: gatewayAnswer.amount ? Number(gatewayAnswer.amount) : null,
      tranId: null,
      rail: actual.detectSslCommerzRail(gatewayAnswer.cardType),
    })),
  };
});

/**
 * The environment keys the sandbox fallback reads.
 */
const FALLBACK_ENV_KEYS = [
  "SSLCOMMERZ_IS_LIVE",
  "SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS",
] as const;

/**
 * Sets the fallback's environment for one test and restores it.
 *
 * It exists so that a test which asserts the **live** behaviour — a
 * callback the gateway denies must not settle the order — can state that
 * behaviour *regardless of the developer's own `.env`*.
 *
 * The local `.env` enables the sandbox fallback so that a developer
 * working against the real SSLCOMMERZ sandbox can see an order settle.
 * But that setting silently changes what the security tests assert: with
 * the fallback on, a denied callback settles the order anyway, and the
 * tests that protect against exactly that fail — not because the code is
 * wrong, but because the environment disagrees with them.
 *
 * So the security tests pin the environment themselves. A test that
 * depends on the developer's `.env` is a test that fails on one machine
 * and passes on another.
 */
function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();

  for (const key of FALLBACK_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }

  for (const key of FALLBACK_ENV_KEYS) {
    const value = values[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const key of FALLBACK_ENV_KEYS) {
      const value = previous.get(key);

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/**
 * Creates a user for the test.
 */
async function createUser(
  email: string,
  role: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<SessionUser> {
  const user = await prisma.user.create({
    data: {
      name: "Test Customer",
      email,
      passwordHash:
        "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
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
 * Places a card order for the test and returns it.
 *
 * A card order is used because it settles through the gateway and needs
 * no transfer reference — so the callback tests are not entangled with
 * the mobile-banking rules.
 */
async function placeCardOrder(
  userId: string,
  slug: string,
  options: { pricePaisa?: number; quantity?: number } = {},
): Promise<{
  orderId: string;
  orderNumber: string;
  productId: string;
  totalAmountPaisa: number;
}> {
  const categoryId = await createCategory("T", `${runId}_${slug}`);
  const productId = await createProduct(categoryId, slug, {
    pricePaisa: options.pricePaisa ?? 50_000,
    stockQuantity: 10,
  });

  await addToCart(userId, productId, options.quantity ?? 1);

  const result = await placeOrder(userId, {
    ...CHECKOUT,
    paymentMethod: "CARD",
  });

  // Record the session key the way the init route does, so the callback
  // can find the order by it.
  await prisma.order.update({
    where: { id: result.orderId },
    data: { paymentGatewaySessionKey: `session-${result.orderId}` },
  });

  return {
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    productId,
    totalAmountPaisa: result.totalAmountPaisa,
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

/**
 * The payment status of an order.
 */
async function paymentStatusOf(orderId: string): Promise<PaymentStatus | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { paymentStatus: true },
  });

  return order?.paymentStatus ?? null;
}

/**
 * The order status of an order.
 */
async function orderStatusOf(orderId: string): Promise<OrderStatus | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });

  return order?.status ?? null;
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the SSLCOMMERZ " +
        "callback integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.paymentAttempt.deleteMany({
      where: { order: { userId: { in: createdUserIds } } },
    });
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

describe("a forged success callback", () => {
  it("does NOT settle the payment when the gateway denies the transaction", async () => {
    if (!databaseAvailable) return;

    /**
     * The live behaviour, pinned.
     *
     * The sandbox fallback is **off** here, so the only thing that can
     * settle this order is the gateway's own answer — and the gateway
     * has refused. See `withEnv` for why the test states the
     * environment rather than inheriting it.
     */
    const restore = withEnv({
      SSLCOMMERZ_IS_LIVE: "false",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "false",
    });

    try {
      const user = await createUser(`${runId}_forged@example.com`);
      const order = await placeCardOrder(user.id, "forged");

      /**
       * The customer hand-crafts the callback URL.
       *
       * Every parameter here is one the customer could type into their
       * own browser's address bar — `status=PAID`, a plausible order id,
       * a plausible amount. The **only** thing that stops this from
       * settling the order is that the handler asks the gateway.
       */
      gatewayAnswer = { status: "INVALID_TRANSACTION" };

      const result = await handleSslCommerzSuccess({
        orderId: order.orderId,
        tran_id: order.orderNumber,
        status: "PAID",
        amount: String(Math.floor(order.totalAmountPaisa / 100)),
        val_id: "forged-validation-id",
      });

      expect(result.verified).toBe(false);
      expect(result.paymentStatus).toBe(PaymentStatus.PENDING);
      expect(result.message).toBeTruthy();

      // The order was not touched.
      expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PENDING);

      // And nothing was written: no settlement, no audit entry claiming a
      // settlement, no attempt.
      expect(
        await prisma.adminAuditLog.count({
          where: {
            entityId: order.orderId,
            action: "ORDER_PAYMENT_SSLCOMMERZ_SETTLED",
          },
        }),
      ).toBe(0);

      expect(
        await prisma.paymentAttempt.count({ where: { orderId: order.orderId } }),
      ).toBe(0);
    } finally {
      restore();
    }
  });

  it("does NOT settle the payment when the gateway records a different amount", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_mismatch@example.com`);
    const order = await placeCardOrder(user.id, "mismatch", { pricePaisa: 50_000 });

    /**
     * The transaction is **valid** — the customer really did pay — but
     * they paid the wrong amount.
     *
     * This is the two-session attack: open a session on a cheap order and
     * a session on an expensive one, pay the cheap one, and return the
     * expensive one's callback. The gateway says "yes, that transaction
     * is real" — and the amount check is what catches it.
     */
    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: "1",
      bankTranId: "BANK-123",
    };

    const result = await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    expect(result.verified).toBe(false);
    expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PENDING);

    expect(
      await prisma.adminAuditLog.count({
        where: {
          entityId: order.orderId,
          action: "ORDER_PAYMENT_SSLCOMMERZ_SETTLED",
        },
      }),
    ).toBe(0);
  });

  it("attributes a settlement to the order's OWNER, not to the caller", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}_owner@example.com`);
    const order = await placeCardOrder(owner.id, "owner");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    /**
     * The callback carries no identity.
     *
     * SSLCOMMERZ's redirect has no idea who the customer is — it is a
     * browser navigation with a query string. So the callback handler
     * cannot ask "who is this?" and does not try. It finds the **order**
     * and settles the order, and the order belongs to somebody.
     *
     * So the audit entry's actor is the **owner**, read from the order
     * row — never from the request. That is the property worth proving:
     * a callback can settle an order (the gateway vouched for it), but
     * it can never *reassign* the order to somebody else.
     */
    const result = await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    expect(result.orderId).toBe(order.orderId);

    const settled = await prisma.adminAuditLog.findFirst({
      where: {
        entityId: order.orderId,
        action: "ORDER_PAYMENT_SSLCOMMERZ_SETTLED",
      },
      select: { actorId: true },
    });

    expect(settled?.actorId).toBe(owner.id);
  });
});

describe("a genuine success callback", () => {
  it("settles the payment and records the gateway's handles", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_genuine@example.com`);
    const order = await placeCardOrder(user.id, "genuine");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
      bankTranId: "BANK-ABC-123",
    };

    const result = await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "the-real-validation-id",
    });

    expect(result.verified).toBe(true);
    expect(result.paymentStatus).toBe(PaymentStatus.PAID);

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: {
        paymentStatus: true,
        paymentGatewayValidationId: true,
        paymentGatewayBankTransactionId: true,
        paymentGatewayAmountTaka: true,
        paymentGatewayTransactionId: true,
      },
    });

    expect(stored?.paymentStatus).toBe(PaymentStatus.PAID);
    expect(stored?.paymentGatewayValidationId).toBe("the-real-validation-id");
    expect(stored?.paymentGatewayBankTransactionId).toBe("BANK-ABC-123");
    expect(stored?.paymentGatewayAmountTaka).toBe(
      Math.floor(order.totalAmountPaisa / 100),
    );
    expect(stored?.paymentGatewayTransactionId).toBe(`${order.orderNumber}-GW`);
  });

  it("moves the order to PROCESSING alongside the payment", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_processing@example.com`);
    const order = await placeCardOrder(user.id, "processing");

    // A fresh order sits at `PENDING` for both axes — it has not been
    // paid, and it has not been dispatched.
    expect(await orderStatusOf(order.orderId)).toBe(OrderStatus.PENDING);

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    // The payment settles **and** the order moves to `PROCESSING` — a
    // paid order that still reads `PENDING` looks to the customer like
    // the shop has not started, and to the admin desk like a backlog
    // item.
    expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PAID);
    expect(await orderStatusOf(order.orderId)).toBe(OrderStatus.PROCESSING);
  });

  it("does NOT drag an already-dispatched order back to PROCESSING", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_shipped@example.com`);
    const order = await placeCardOrder(user.id, "shipped");

    // The admin has already dispatched this order. A callback arriving
    // afterwards must not walk the status backwards.
    await prisma.order.update({
      where: { id: order.orderId },
      data: { status: OrderStatus.SHIPPED },
    });

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PAID);
    expect(await orderStatusOf(order.orderId)).toBe(OrderStatus.SHIPPED);
  });

  it("does NOT move the order status when the payment is not confirmed", async () => {
    if (!databaseAvailable) return;

    /**
     * The live behaviour, pinned — the sandbox fallback is off, so an
     * unconfirmed payment leaves the order exactly where it was.
     */
    const restore = withEnv({
      SSLCOMMERZ_IS_LIVE: "false",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "false",
    });

    try {
      const user = await createUser(`${runId}_notconfirmed@example.com`);
      const order = await placeCardOrder(user.id, "notconfirmed");

      gatewayAnswer = { status: "INVALID_TRANSACTION" };

      await handleSslCommerzSuccess({
        orderId: order.orderId,
        tran_id: order.orderNumber,
        val_id: "validation-id",
      });

      // Both axes stay where they were. A forged callback moves neither.
      expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PENDING);
      expect(await orderStatusOf(order.orderId)).toBe(OrderStatus.PENDING);
    } finally {
      restore();
    }
  });

  it("is idempotent — a replayed callback settles nothing twice", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_replay@example.com`);
    const order = await placeCardOrder(user.id, "replay");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
      bankTranId: "BANK-REPLAY",
    };

    const params = {
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    };

    await handleSslCommerzSuccess(params);

    // The customer refreshes the success page. The callback arrives a
    // second time.
    const second = await handleSslCommerzSuccess(params);

    expect(second.verified).toBe(true);
    expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PAID);

    // Exactly **one** settlement on the record.
    expect(
      await prisma.adminAuditLog.count({
        where: {
          entityId: order.orderId,
          action: "ORDER_PAYMENT_SSLCOMMERZ_SETTLED",
        },
      }),
    ).toBe(1);
  });

  it("writes the audit entry and the admin notification together", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_notified@example.com`);
    const order = await placeCardOrder(user.id, "notified");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    const entries = await prisma.adminAuditLog.findMany({
      where: {
        entityId: order.orderId,
        action: "ORDER_PAYMENT_SSLCOMMERZ_SETTLED",
      },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe(user.id);

    const notifications = await prisma.adminNotification.findMany({
      where: { entityId: order.orderId, kind: "PAYMENT_SETTLED" },
    });

    expect(notifications).toHaveLength(1);
  });
});

describe("a failure callback", () => {
  it("leaves the payment PENDING — a declined attempt is not a failed payment", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_failed@example.com`);
    const order = await placeCardOrder(user.id, "failed");

    const result = await handleSslCommerzFailure({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      status: "FAILED",
    });

    expect(result.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PENDING);

    // `FAILED` is terminal in the transition table, so a declined
    // attempt must never land there — the customer has to be able to
    // retry on the same order.
    const attempts = await prisma.paymentAttempt.findMany({
      where: { orderId: order.orderId },
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe(PaymentAttemptOutcome.FAILED);
  });

  it("does NOT restore the stock — the order is still live", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_stock@example.com`);
    const order = await placeCardOrder(user.id, "stock", { quantity: 2 });

    const before = await stockOf(order.productId);
    expect(before).toBe(8);

    await handleSslCommerzFailure({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      status: "FAILED",
    });

    // The stock is **still reserved**. Restoring it on a failure and
    // then letting the customer retry the same order would oversell.
    expect(await stockOf(order.productId)).toBe(before);
  });

  it("records the attempt only once, however many times the page is refreshed", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_refresh@example.com`);
    const order = await placeCardOrder(user.id, "refresh");

    const params = {
      orderId: order.orderId,
      tran_id: order.orderNumber,
      status: "FAILED",
      sessionkey: `session-${order.orderId}`,
    };

    await handleSslCommerzFailure(params);
    await handleSslCommerzFailure(params);
    await handleSslCommerzFailure(params);

    const attempts = await prisma.paymentAttempt.findMany({
      where: { orderId: order.orderId },
    });

    expect(attempts).toHaveLength(1);
  });

  it("lets the customer retry on the same order — and the retry settles", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_retry@example.com`);
    const order = await placeCardOrder(user.id, "retry", { quantity: 2 });

    const before = await stockOf(order.productId);

    await handleSslCommerzFailure({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      status: "FAILED",
    });

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    const result = await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    expect(result.paymentStatus).toBe(PaymentStatus.PAID);

    // The stock was restored **zero times**.
    expect(await stockOf(order.productId)).toBe(before);
  });
});

describe("the rail the customer actually paid with", () => {
  it("records bKash when the gateway says the customer used bKash", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_bkash@example.com`);
    const order = await placeCardOrder(user.id, "bkash");

    // The checkout wrote the generic `CARD` value, because the customer
    // picked their operator on the gateway's page. The gateway now tells
    // us which one they picked.
    const before = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentMethod: true },
    });

    expect(before?.paymentMethod).toBe("CARD");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
      cardType: "BKASH",
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentMethod: true, paymentStatus: true },
    });

    expect(stored?.paymentMethod).toBe("BKASH");
    expect(stored?.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it("records Nagad when the gateway says the customer used Nagad", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_nagad@example.com`);
    const order = await placeCardOrder(user.id, "nagad");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
      cardType: "Nagad",
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentMethod: true },
    });

    expect(stored?.paymentMethod).toBe("NAGAD");
  });

  it("leaves a card as a card", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_card@example.com`);
    const order = await placeCardOrder(user.id, "card");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
      cardType: "VISA",
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentMethod: true },
    });

    expect(stored?.paymentMethod).toBe("CARD");
  });

  it("does NOT overwrite a rail the shop already knows", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_known@example.com`);
    const order = await placeCardOrder(user.id, "known");

    // An order that already knows its rail — a local-transfer order
    // settled by hand, or one settled before this fix. The gateway's
    // `card_type` is a *report* of what it processed, and it must not
    // overwrite a rail the shop already recorded.
    await prisma.order.update({
      where: { id: order.orderId },
      data: { paymentMethod: "NAGAD" },
    });

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
      cardType: "BKASH",
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentMethod: true },
    });

    expect(stored?.paymentMethod).toBe("NAGAD");
  });

  it("records the same rail in the admin notification", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_bell@example.com`);
    const order = await placeCardOrder(user.id, "bell");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
      cardType: "BKASH",
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    const notification = await prisma.adminNotification.findFirst({
      where: { entityId: order.orderId, kind: "PAYMENT_SETTLED" },
      select: { paymentMethod: true },
    });

    // A bell saying "bKash" over an order the page calls a card would be
    // the two disagreeing — and the notification is a snapshot, so it
    // has to be the same snapshot the order row holds.
    expect(notification?.paymentMethod).toBe("BKASH");
  });
});

/**
 * The sandbox fallback.
 *
 * The SSLCOMMERZ sandbox does not always issue a validation handle the
 * validation endpoint recognises, so a local test order would sit at
 * `PENDING` forever and the customer would be told "we could not
 * confirm" on every visit — a loop that tells the developer nothing.
 *
 * The fallback exists to break that loop. It settles the order without
 * the gateway's answer, and it is guarded on three fronts: the flag must
 * be set, the shop must be in sandbox, and the order must exist and be
 * `PENDING`.
 */
describe("the sandbox fallback", () => {
  it("settles a test order the gateway would not vouch for", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_fallback@example.com`);
    const order = await placeCardOrder(user.id, "fallback");

    // The gateway refuses to confirm — the sandbox's usual behaviour.
    gatewayAnswer = { status: "INVALID_TRANSACTION" };

    const restore = withEnv({
      SSLCOMMERZ_IS_LIVE: "false",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "true",
    });

    try {
      const result = await handleSslCommerzSuccess({
        orderId: order.orderId,
        tran_id: order.orderNumber,
        val_id: "sandbox-validation-id",
        amount: String(Math.floor(order.totalAmountPaisa / 100)),
      });

      // The order **settled** …
      expect(result.settled).toBe(true);
      expect(result.paymentStatus).toBe(PaymentStatus.PAID);

      // … but the gateway never vouched for it, and the result says so.
      expect(result.verified).toBe(false);

      expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PAID);
      expect(await orderStatusOf(order.orderId)).toBe(OrderStatus.PROCESSING);
    } finally {
      restore();
    }
  });

  it("does NOT settle when the shop is live, whatever the flag says", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_livefallback@example.com`);
    const order = await placeCardOrder(user.id, "livefallback");

    gatewayAnswer = { status: "INVALID_TRANSACTION" };

    const restore = withEnv({
      SSLCOMMERZ_IS_LIVE: "true",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "true",
    });

    try {
      const result = await handleSslCommerzSuccess({
        orderId: order.orderId,
        tran_id: order.orderNumber,
        val_id: "validation-id",
        amount: String(Math.floor(order.totalAmountPaisa / 100)),
      });

      // The live shop is protected by the sandbox check, not by the
      // flag. A deployment that sets the flag carelessly still cannot
      // settle a real payment without the gateway's answer.
      expect(result.settled).toBe(false);
      expect(result.verified).toBe(false);
      expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PENDING);
      expect(await orderStatusOf(order.orderId)).toBe(OrderStatus.PENDING);
    } finally {
      restore();
    }
  });

  it("does NOT settle when the flag is off", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_noflag@example.com`);
    const order = await placeCardOrder(user.id, "noflag");

    gatewayAnswer = { status: "INVALID_TRANSACTION" };

    const restore = withEnv({
      SSLCOMMERZ_IS_LIVE: "false",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "false",
    });

    try {
      const result = await handleSslCommerzSuccess({
        orderId: order.orderId,
        tran_id: order.orderNumber,
        val_id: "validation-id",
        amount: String(Math.floor(order.totalAmountPaisa / 100)),
      });

      expect(result.settled).toBe(false);
      expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PENDING);
    } finally {
      restore();
    }
  });

  it("still refuses a fallback callback quoting the wrong amount", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_fallbackamount@example.com`);
    const order = await placeCardOrder(user.id, "fallbackamount");

    gatewayAnswer = { status: "INVALID_TRANSACTION" };

    const restore = withEnv({
      SSLCOMMERZ_IS_LIVE: "false",
      SSLCOMMERZ_ALLOW_UNVERIFIED_CALLBACKS: "true",
    });

    try {
      const result = await handleSslCommerzSuccess({
        orderId: order.orderId,
        tran_id: order.orderNumber,
        val_id: "validation-id",
        // One taka, for an order worth hundreds.
        amount: "1",
      });

      // The fallback reads the amount from the **callback** — the
      // customer's own claim — so it must check it just as a verified
      // payment is checked. A forged callback quoting the wrong amount
      // is refused either way.
      expect(result.settled).toBe(false);
      expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PENDING);
    } finally {
      restore();
    }
  });
});

/**
 * Finding the order a callback is about.
 */
describe("finding the order a callback is about", () => {
  it("finds the order by the order id round-tripped through value_a", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_byid@example.com`);
    const order = await placeCardOrder(user.id, "byid");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    const result = await handleSslCommerzSuccess({ orderId: order.orderId });

    expect(result.orderId).toBe(order.orderId);
    expect(result.orderNumber).toBe(order.orderNumber);
  });

  it("finds the order by its order number", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_bynumber@example.com`);
    const order = await placeCardOrder(user.id, "bynumber");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    const result = await handleSslCommerzSuccess({
      tran_id: order.orderNumber,
    });

    expect(result.orderId).toBe(order.orderId);
  });

  it("finds the order by the recorded session key", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_bysession@example.com`);
    const order = await placeCardOrder(user.id, "bysession");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    const result = await handleSslCommerzSuccess({
      sessionkey: `session-${order.orderId}`,
    });

    expect(result.orderId).toBe(order.orderId);
  });

  it("reports no order when the callback names none that exists", async () => {
    if (!databaseAvailable) return;

    const result = await handleSslCommerzSuccess({
      orderId: "no-such-order",
      tran_id: "EGB-19700101-ZZZZZZ",
    });

    expect(result.verified).toBe(false);
    expect(result.orderId).toBeNull();
    expect(result.paymentStatus).toBeNull();
    expect(result.message).toBeTruthy();
  });
});

/**
 * Opening a gateway session.
 *
 * These exercise the **guards**, which all run *before* the gateway is
 * called — so the test needs no network and no mock. The one that would
 * need the gateway (a successful opening) is deliberately not here: it
 * is a wiring test, and the wiring is exercised by the live sandbox
 * check below.
 */
describe("opening an SSLCOMMERZ session", () => {
  it("refuses another customer's order", async () => {
    if (!databaseAvailable) return;

    const owner = await createUser(`${runId}_initowner@example.com`);
    const stranger = await createUser(`${runId}_initstranger@example.com`);
    const order = await placeCardOrder(owner.id, "initowner");

    // The order is looked up by id **and** by owner, so a foreign order
    // is simply not found. The refusal happens before the gateway is
    // contacted, so no session is opened for it.
    await expect(
      openSslCommerzSession(stranger.id, order.orderId),
    ).rejects.toMatchObject({ status: 404 });

    const stored = await prisma.order.findUnique({
      where: { id: order.orderId },
      select: { paymentGatewaySessionKey: true },
    });

    expect(stored?.paymentGatewaySessionKey).toBe(`session-${order.orderId}`);
  });

  it("refuses an order that does not exist", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_initmissing@example.com`);

    await expect(
      openSslCommerzSession(user.id, "no-such-order"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a cash-on-delivery order", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_initcod@example.com`);
    const categoryId = await createCategory("T", `${runId}_c_initcod`);
    const productId = await createProduct(categoryId, "InitCod", {
      pricePaisa: 50_000,
      stockQuantity: 5,
    });

    await addToCart(user.id, productId, 1);

    const placed = await placeOrder(user.id, {
      ...CHECKOUT,
      paymentMethod: "COD",
    });

    // Cash is collected by the courier at the door. There is nothing for
    // a gateway to charge, and a session for a cash order would be a
    // session the customer has no reason to use.
    await expect(
      openSslCommerzSession(user.id, placed.orderId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an order whose payment is already settled", async () => {
    if (!databaseAvailable) return;

    const user = await createUser(`${runId}_initpaid@example.com`);
    const order = await placeCardOrder(user.id, "initpaid");

    gatewayAnswer = {
      status: "VALID_TRANSACTION",
      amount: String(Math.floor(order.totalAmountPaisa / 100)),
    };

    await handleSslCommerzSuccess({
      orderId: order.orderId,
      tran_id: order.orderNumber,
      val_id: "validation-id",
    });

    expect(await paymentStatusOf(order.orderId)).toBe(PaymentStatus.PAID);

    await expect(
      openSslCommerzSession(user.id, order.orderId),
    ).rejects.toMatchObject({ status: 409 });
  });
});
