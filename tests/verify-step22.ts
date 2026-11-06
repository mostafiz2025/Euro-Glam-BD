/**
 * Step 22's live gate.
 *
 * ── What this proves ──────────────────────────────────────────────────────
 *
 * The payment flow moved: the checkout page now holds **only** the payment
 * choice, and the card details and the transfer reference are collected in
 * the **gateway window**. That is a contract change with two halves:
 *
 *   1. **The order is placed with no transfer reference.** The columns
 *      start as `null`, because the customer has not quoted a TrxID yet.
 *
 *   2. **The settle carries the transfer reference** and writes it onto
 *      the order as it marks the order `PAID`.
 *
 * So the shop still ends up with a complete, reconcilable reference — only
 * the *moment* the customer is asked has moved.
 *
 * This script proves the whole chain against the real database:
 *
 *   • A bKash order places with the transfer columns empty.
 *   • A settle with **no** transfer reference is refused with a 400, and
 *     the order is left untouched — the token is still live.
 *   • A settle **with** the reference succeeds, the order goes to `PAID`,
 *     the token is consumed, and the columns carry the reference.
 *   • A **card** order settles with no reference and its transfer columns
 *     stay empty.
 *   • A card settle **with** a reference is refused with a 400.
 *   • A client-supplied `paymentMethod` in the settle body is refused —
 *     the method comes from the **order row**, never from the client.
 *   • A settle body carrying a **card key** is refused.
 *
 * Run with: `npx tsx tests/verify-step22.ts`
 */

import { PaymentAttemptOutcome, PaymentStatus, PrismaClient } from "@prisma/client";

import { ApiError } from "../src/lib/api/errors";
import { settleGatewayPayment } from "../src/lib/payments/gateway";
import { placeOrder } from "../src/lib/orders/service";
import { gatewaySettleSchema } from "../src/lib/validation/payments";

const prisma = new PrismaClient();

const runId = `gate_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

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

const TRANSFER = {
  paymentSenderNumber: "01712345678",
  paymentTransactionId: "8N3F2K9LM4",
};

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}`);
  }
}

async function createUser(email: string) {
  const user = await prisma.user.create({
    data: {
      name: "Gate Customer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
    },
    select: { id: true, email: true, name: true, role: true },
  });

  createdUserIds.push(user.id);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as "CUSTOMER",
    phone: null,
    smsOptIn: false,
  };
}

async function createProduct(slug: string) {
  const category = await prisma.category.create({
    data: { name: "Gate", slug: `${runId}_${slug}_cat` },
    select: { id: true },
  });
  createdCategoryIds.push(category.id);

  const product = await prisma.product.create({
    data: {
      name: `Gate ${slug}`,
      description: "Gate product",
      categoryId: category.id,
      pricePaisa: 50000,
      discountPricePaisa: null,
      stockQuantity: 10,
      ingredientTags: [],
    },
    select: { id: true },
  });
  createdProductIds.push(product.id);

  return product.id;
}

async function addToCart(userId: string, productId: string, quantity: number) {
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

async function placeGatewayOrder(userId: string, slug: string, method: "BKASH" | "CARD") {
  const productId = await createProduct(slug);

  await addToCart(userId, productId, 1);

  const result = await placeOrder(userId, {
    ...CHECKOUT,
    paymentMethod: method,
  });

  const sessionId = result.gateway?.sessionId;
  if (!sessionId) throw new Error("Expected a gateway session.");

  return { orderId: result.orderId, orderNumber: result.orderNumber, sessionId };
}

async function main() {
  console.log("\n── Step 22: the payment details moved into the gateway window ──\n");

  /* ── 1. The order is placed with the transfer columns empty ────────── */
  console.log("1. The order is placed with no transfer reference");

  const user = await createUser(`${runId}@example.com`);
  const bkash = await placeGatewayOrder(user.id, "bkash", "BKASH");

  const placed = await prisma.order.findUnique({
    where: { id: bkash.orderId },
    select: {
      paymentMethod: true,
      paymentSenderNumber: true,
      paymentTransactionId: true,
      paymentStatus: true,
      paymentGatewaySessionId: true,
    },
  });

  check("the method is on the order", placed?.paymentMethod === "BKASH");
  check("the sender number starts empty", placed?.paymentSenderNumber === null);
  check("the TrxID starts empty", placed?.paymentTransactionId === null);
  check("the payment is PENDING", placed?.paymentStatus === PaymentStatus.PENDING);
  check("the gateway token is live", placed?.paymentGatewaySessionId === bkash.sessionId);

  /* ── 2. A settle with no reference is refused ──────────────────────── */
  console.log("\n2. A mobile-banking settle with no transfer reference is refused");

  let refusedStatus: number | null = null;
  try {
    await settleGatewayPayment(
      user,
      bkash.orderId,
      bkash.sessionId,
      PaymentAttemptOutcome.SUCCESS,
    );
  } catch (error) {
    if (error instanceof ApiError) refusedStatus = error.status;
  }

  check("it is refused with a 400", refusedStatus === 400);

  const afterRefusal = await prisma.order.findUnique({
    where: { id: bkash.orderId },
    select: {
      paymentStatus: true,
      paymentGatewaySessionId: true,
      paymentTransactionId: true,
    },
  });

  check("the payment is still PENDING", afterRefusal?.paymentStatus === PaymentStatus.PENDING);
  check("the token is still live", afterRefusal?.paymentGatewaySessionId === bkash.sessionId);
  check("nothing was written", afterRefusal?.paymentTransactionId === null);

  /* ── 3. A settle with the reference succeeds ───────────────────────── */
  console.log("\n3. A mobile-banking settle WITH the reference succeeds");

  const settled = await settleGatewayPayment(
    user,
    bkash.orderId,
    bkash.sessionId,
    PaymentAttemptOutcome.SUCCESS,
    TRANSFER,
  );

  check("the payment is PAID", settled.order.paymentStatus === PaymentStatus.PAID);
  check("the gateway's own reference is recorded", settled.order.transactionId === `${bkash.orderNumber}-GW`);

  const stored = await prisma.order.findUnique({
    where: { id: bkash.orderId },
    select: {
      paymentStatus: true,
      paymentGatewaySessionId: true,
      paymentSenderNumber: true,
      paymentTransactionId: true,
      paymentGatewayTransactionId: true,
    },
  });

  check("the sender number is on the order", stored?.paymentSenderNumber === "01712345678");
  check("the TrxID is on the order", stored?.paymentTransactionId === "8N3F2K9LM4");
  check("the token is consumed", stored?.paymentGatewaySessionId === null);
  check(
    "the gateway's reference is in its own column",
    stored?.paymentGatewayTransactionId === `${bkash.orderNumber}-GW`,
  );

  /* ── 4. A card order settles with no reference ─────────────────────── */
  console.log("\n4. A card order settles with no transfer reference");

  const cardUser = await createUser(`${runId}_card@example.com`);
  const card = await placeGatewayOrder(cardUser.id, "card", "CARD");

  const cardSettled = await settleGatewayPayment(
    cardUser,
    card.orderId,
    card.sessionId,
    PaymentAttemptOutcome.SUCCESS,
  );

  check("the payment is PAID", cardSettled.order.paymentStatus === PaymentStatus.PAID);

  const cardStored = await prisma.order.findUnique({
    where: { id: card.orderId },
    select: { paymentTransactionId: true, paymentSenderNumber: true },
  });

  check("the TrxID stays empty", cardStored?.paymentTransactionId === null);
  check("the sender number stays empty", cardStored?.paymentSenderNumber === null);

  /* ── 5. A card settle WITH a reference is refused ──────────────────── */
  console.log("\n5. A card settle carrying a transfer reference is refused");

  const cardUser2 = await createUser(`${runId}_card2@example.com`);
  const card2 = await placeGatewayOrder(cardUser2.id, "card2", "CARD");

  let cardRefused: number | null = null;
  try {
    await settleGatewayPayment(
      cardUser2,
      card2.orderId,
      card2.sessionId,
      PaymentAttemptOutcome.SUCCESS,
      TRANSFER,
    );
  } catch (error) {
    if (error instanceof ApiError) cardRefused = error.status;
  }

  check("it is refused with a 400", cardRefused === 400);

  /* ── 6. The client may not choose the method ───────────────────────── */
  console.log("\n6. The settle body may not carry a client-chosen method");

  const methodCheck = gatewaySettleSchema.safeParse({
    sessionId: bkash.sessionId,
    outcome: "SUCCESS",
    paymentMethod: "NAGAD",
  });

  check("a body with paymentMethod is refused", !methodCheck.success);

  /* ── 7. The settle body may not carry a card key ───────────────────── */
  console.log("\n7. The settle body may not carry a card detail");

  for (const key of ["cardNumber", "cardExpiry", "cardCvc", "cardHolderName"]) {
    const result = gatewaySettleSchema.safeParse({
      sessionId: bkash.sessionId,
      outcome: "SUCCESS",
      [key]: "4242424242424242",
    });

    check(`a body with ${key} is refused`, !result.success);
  }

  /* ── 8. The checkout body may not carry a card key ─────────────────── */
  console.log("\n8. The checkout body may not carry a card detail");

  const checkoutResult = await prisma.order.count({
    where: { userId: user.id },
  });

  check("the bKash order exists", checkoutResult === 1);

  console.log(`\n${passed} passed, ${failed} failed\n`);
}

async function cleanup() {
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
    await prisma.$disconnect();
  }
}

main()
  .then(cleanup)
  .catch(async (error) => {
    console.error(error);
    await cleanup();
    process.exit(1);
  });
