/**
 * Step 10 verification script.
 *
 * Proves the four Step 10 deliverables behave correctly against a real
 * database, outside the unit tests:
 *
 *   1. The review moderation state machine: pending → approved → hidden →
 *      approved, with the full history preserved in the audit log.
 *   2. The order transition table: forward-only, `SHIPPED → CANCELLED`
 *      absent, and cancelling restores the stock exactly once.
 *   3. The SMS consent gate: a message reaches a customer who opted in,
 *      and reaches nobody else.
 *   4. The SMS idempotency keys: a re-run sends one message, and the
 *      automated and manual keys are distinct.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step10.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import {
  AdminAction,
  OrderStatus,
  PaymentStatus,
  PrismaClient,
} from "@prisma/client";

import {
  changeOrderStatus,
  changePaymentStatus,
  listAdminOrders,
} from "@/lib/admin/orders";
import {
  isPublicReview,
  listAdminReviews,
  moderateReview,
  reviewState,
} from "@/lib/admin/reviews";
import type { AuditActor } from "@/lib/admin/audit";
import { MockSmsGateway } from "@/lib/sms/mock-gateway";
import {
  REMINDER_LEAD_TIME_DAYS,
  manualResendIdempotencyKey,
  resendReminder,
  reminderIdempotencyKey,
  triggerDepletionReminders,
} from "@/lib/sms/service";
import { buildDepletionReminderBody } from "@/lib/sms/templates";

const prisma = new PrismaClient();

let failures = 0;

/**
 * Prints a check result.
 */
function check(label: string, passed: boolean, detail = ""): void {
  if (passed) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Section heading.
 */
function section(title: string): void {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
}

/**
 * A unique suffix so repeated runs never collide.
 */
const runId = `v10${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdReviewIds: string[] = [];

/**
 * Creates a user.
 */
async function createUser(
  email: string,
  options: {
    role?: "CUSTOMER" | "ADMIN";
    phone?: string | null;
    smsOptIn?: boolean;
  } = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Verify User",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: options.role ?? "CUSTOMER",
      phone: options.phone === undefined ? "+8801700000000" : options.phone,
      smsOptIn: options.smsOptIn ?? false,
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Verify Step 10", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

async function createProduct(
  categoryId: string,
  name: string,
  stockQuantity = 50,
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Verify product ${name}`,
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

async function createReview(
  productId: string,
  userId: string,
  comment: string,
): Promise<string> {
  const review = await prisma.review.create({
    data: {
      productId,
      userId,
      rating: 5,
      comment,
      isApproved: false,
      isHidden: false,
    },
    select: { id: true },
  });

  createdReviewIds.push(review.id);
  return review.id;
}

/**
 * Creates an order with one line.
 */
async function createOrder(
  userId: string,
  productId: string,
  options: {
    orderNumber: string;
    status?: OrderStatus;
    paymentStatus?: PaymentStatus;
    quantity?: number;
    estimatedEmptyAt?: Date | null;
  },
): Promise<{ orderId: string; itemId: string }> {
  const quantity = options.quantity ?? 2;

  const order = await prisma.order.create({
    data: {
      userId,
      orderNumber: options.orderNumber,
      status: options.status ?? OrderStatus.PENDING,
      paymentStatus: options.paymentStatus ?? PaymentStatus.PENDING,
      paymentMethod: "COD",
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
          productName: "Verify Product",
          pricePaisa: 100000,
          quantity,
          estimatedEmptyAt: options.estimatedEmptyAt ?? null,
        },
      },
    },
    select: { id: true, items: { select: { id: true } } },
  });

  createdOrderIds.push(order.id);

  const itemId = order.items[0]?.id;

  if (!itemId) {
    throw new Error("The order item was not created.");
  }

  return { orderId: order.id, itemId };
}

/**
 * Removes everything the script created, in dependency order.
 */
async function cleanup(): Promise<void> {
  await prisma.adminAuditLog.deleteMany({
    where: {
      OR: [
        { entityType: "review", entityId: { in: createdReviewIds } },
        { entityType: "order", entityId: { in: createdOrderIds } },
        { entityType: "order_item", entityId: { in: createdOrderIds } },
      ],
    },
  });
  await prisma.smsLog.deleteMany({});
  await prisma.orderItem.deleteMany({
    where: { orderId: { in: createdOrderIds } },
  });
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.review.deleteMany({ where: { id: { in: createdReviewIds } } });
  await prisma.product.deleteMany({
    where: { id: { in: createdProductIds } },
  });
  await prisma.category.deleteMany({
    where: { id: { in: createdCategoryIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

async function main(): Promise<number> {
  const adminId = await createUser(`${runId}_admin@example.com`, {
    role: "ADMIN",
  });

  const actor: AuditActor = {
    id: adminId,
    name: "Verify Admin",
    email: `${runId}_admin@example.com`,
  };

  const customerId = await createUser(`${runId}_customer@example.com`);
  const categoryId = await createCategory(`${runId}-cat`);
  const productId = await createProduct(categoryId, "Verify Product", 50);

  // ── 1. The review state machine ──────────────────────────────────────
  section("1. Reviews — the moderation state machine");

  const reviewId = await createReview(productId, customerId, "Verify review");

  check(
    "a new review is PENDING",
    reviewState({ isApproved: false, isHidden: false }) === "PENDING",
  );

  check(
    "a pending review is not public",
    !isPublicReview({ isApproved: false, isHidden: false }),
  );

  const approved = await moderateReview(actor, reviewId, "APPROVE");

  check(
    "approving publishes the review",
    approved.isApproved && !approved.isHidden,
  );

  check(
    "an approved review is public",
    isPublicReview(approved),
  );

  const hidden = await moderateReview(
    actor,
    reviewId,
    "HIDE",
    "Contains personal information.",
  );

  check(
    "hiding withdraws the review from the public view",
    hidden.isHidden && !isPublicReview(hidden),
  );

  check(
    "hiding keeps the review approved — the history is not destroyed",
    hidden.isApproved,
  );

  const restored = await moderateReview(actor, reviewId, "UNHIDE");

  check(
    "unhiding restores the review",
    restored.isApproved && !restored.isHidden,
  );

  const entries = await prisma.adminAuditLog.findMany({
    where: { entityType: "review", entityId: reviewId },
    orderBy: { createdAt: "asc" },
  });

  check(
    "all three decisions are in the audit log",
    entries.length === 3,
    `${entries.length} entries`,
  );

  check(
    "the audit log records the actions in order",
    entries.map((e) => e.action).join(",") ===
      [
        AdminAction.REVIEW_APPROVED,
        AdminAction.REVIEW_HIDDEN,
        AdminAction.REVIEW_UNHIDDEN,
      ].join(","),
  );

  check(
    "the audit entry records who acted",
    entries[0]?.actorEmail === actor.email,
  );

  // A pending review cannot be hidden.
  const pendingReviewId = await createReview(
    productId,
    customerId,
    "Verify pending",
  );

  let hideRefused = false;

  try {
    await moderateReview(actor, pendingReviewId, "HIDE");
  } catch {
    hideRefused = true;
  }

  check("hiding a pending review is refused", hideRefused);

  const stillPending = await prisma.review.findUnique({
    where: { id: pendingReviewId },
    select: { isApproved: true, isHidden: true },
  });

  check(
    "the refused moderation wrote nothing",
    stillPending?.isApproved === false && stillPending?.isHidden === false,
  );

  const pendingAudit = await prisma.adminAuditLog.count({
    where: { entityType: "review", entityId: pendingReviewId },
  });

  check("the refused moderation wrote no audit entry", pendingAudit === 0);

  const queue = await listAdminReviews({
    status: "PENDING",
    page: 1,
    limit: 100,
  });

  check(
    "the queue's counts agree with its list",
    queue.counts.pending === queue.pagination.total,
  );

  // ── 2. The order transition table ────────────────────────────────────
  section("2. Orders — the transition table and the stock restoration");

  const { orderId: orderId1 } = await createOrder(customerId, productId, {
    orderNumber: `${runId}-O1`,
  });

  const processing = await changeOrderStatus(
    actor,
    orderId1,
    OrderStatus.PROCESSING,
  );

  check(
    "PENDING moves to PROCESSING",
    processing.status === OrderStatus.PROCESSING,
  );

  const shipped = await changeOrderStatus(
    actor,
    orderId1,
    OrderStatus.SHIPPED,
  );

  check("PROCESSING moves to SHIPPED", shipped.status === OrderStatus.SHIPPED);

  const delivered = await changeOrderStatus(
    actor,
    orderId1,
    OrderStatus.DELIVERED,
  );

  check("SHIPPED moves to DELIVERED", delivered.status === OrderStatus.DELIVERED);

  // SHIPPED → CANCELLED is not permitted.
  const { orderId: orderId2 } = await createOrder(customerId, productId, {
    orderNumber: `${runId}-O2`,
    status: OrderStatus.SHIPPED,
  });

  let shippedCancelRefused = false;

  try {
    await changeOrderStatus(actor, orderId2, OrderStatus.CANCELLED);
  } catch {
    shippedCancelRefused = true;
  }

  check("SHIPPED cannot be cancelled", shippedCancelRefused);

  const shippedOrder = await prisma.order.findUnique({
    where: { id: orderId2 },
    select: { status: true },
  });

  check(
    "the refused cancellation wrote nothing",
    shippedOrder?.status === OrderStatus.SHIPPED,
  );

  // Cancelling restores the stock, exactly once.
  const stockBefore = await prisma.product.findUnique({
    where: { id: productId },
    select: { stockQuantity: true },
  });

  const { orderId: orderId3 } = await createOrder(customerId, productId, {
    orderNumber: `${runId}-O3`,
    quantity: 3,
  });

  await prisma.product.update({
    where: { id: productId },
    data: { stockQuantity: { decrement: 3 } },
  });

  await changeOrderStatus(actor, orderId3, OrderStatus.CANCELLED);

  const stockAfterCancel = await prisma.product.findUnique({
    where: { id: productId },
    select: { stockQuantity: true },
  });

  check(
    "cancelling restores the reserved stock",
    stockAfterCancel?.stockQuantity === stockBefore?.stockQuantity,
    `${stockBefore?.stockQuantity} → ${stockAfterCancel?.stockQuantity}`,
  );

  let secondCancelRefused = false;

  try {
    await changeOrderStatus(actor, orderId3, OrderStatus.CANCELLED);
  } catch {
    secondCancelRefused = true;
  }

  check("cancelling twice is refused", secondCancelRefused);

  const stockAfterSecond = await prisma.product.findUnique({
    where: { id: productId },
    select: { stockQuantity: true },
  });

  check(
    "cancelling twice restores the stock once",
    stockAfterSecond?.stockQuantity === stockBefore?.stockQuantity,
    `${stockAfterSecond?.stockQuantity}`,
  );

  // The payment axis is independent.
  const { orderId: orderId4 } = await createOrder(customerId, productId, {
    orderNumber: `${runId}-O4`,
    status: OrderStatus.SHIPPED,
    paymentStatus: PaymentStatus.PENDING,
  });

  await changeOrderStatus(actor, orderId4, OrderStatus.DELIVERED);

  const codOrder = await prisma.order.findUnique({
    where: { id: orderId4 },
    select: { status: true, paymentStatus: true },
  });

  check(
    "a delivered COD order can still have a pending payment",
    codOrder?.status === OrderStatus.DELIVERED &&
      codOrder?.paymentStatus === PaymentStatus.PENDING,
  );

  const paid = await changePaymentStatus(
    actor,
    orderId4,
    PaymentStatus.PAID,
  );

  check("the payment moves independently", paid.paymentStatus === PaymentStatus.PAID);

  const orderAudit = await prisma.adminAuditLog.findMany({
    where: { entityType: "order", entityId: orderId4 },
    orderBy: { createdAt: "asc" },
  });

  check(
    "the two axes get separate audit actions",
    orderAudit.map((e) => e.action).join(",") ===
      [
        AdminAction.ORDER_STATUS_CHANGED,
        AdminAction.ORDER_PAYMENT_STATUS_CHANGED,
      ].join(","),
  );

  const orderList = await listAdminOrders({ page: 1, limit: 100 });

  check(
    "the order counts cover every fulfilment status",
    Object.keys(orderList.counts.byStatus).length ===
      Object.values(OrderStatus).length,
  );

  // ── 3. The SMS consent gate ──────────────────────────────────────────
  section("3. SMS — the consent gate");

  const optedInId = await createUser(`${runId}_opted_in@example.com`, {
    smsOptIn: true,
  });

  const notOptedInId = await createUser(`${runId}_not_opted_in@example.com`, {
    smsOptIn: false,
  });

  const noPhoneId = await createUser(`${runId}_no_phone@example.com`, {
    phone: null,
    smsOptIn: true,
  });

  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const { itemId: optedInItem } = await createOrder(
    optedInId,
    productId,
    { orderNumber: `${runId}-M1`, estimatedEmptyAt: dueAt },
  );

  const { itemId: notOptedInItem } = await createOrder(
    notOptedInId,
    productId,
    { orderNumber: `${runId}-M2`, estimatedEmptyAt: dueAt },
  );

  const { itemId: noPhoneItem } = await createOrder(noPhoneId, productId, {
    orderNumber: `${runId}-M3`,
    estimatedEmptyAt: dueAt,
  });

  const gateway = new MockSmsGateway();

  const sweep = await triggerDepletionReminders(actor, { gateway });

  const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

  check(
    "a customer who opted in receives the reminder",
    sentKeys.includes(reminderIdempotencyKey(optedInItem)),
  );

  check(
    "a customer who did not opt in receives nothing",
    !sentKeys.includes(reminderIdempotencyKey(notOptedInItem)),
  );

  check(
    "a customer with no phone number receives nothing",
    !sentKeys.includes(reminderIdempotencyKey(noPhoneItem)),
  );

  check(
    "the sweep reports examined, sent, skipped and failed separately",
    typeof sweep.examined === "number" &&
      typeof sweep.sent === "number" &&
      typeof sweep.skipped === "number" &&
      typeof sweep.failed === "number",
    `examined ${sweep.examined}, sent ${sweep.sent}, skipped ${sweep.skipped}, failed ${sweep.failed}`,
  );

  check(
    "the sweep recorded no failures",
    sweep.failed === 0,
  );

  const notOptedInRow = await prisma.orderItem.findUnique({
    where: { id: notOptedInItem },
    select: { reminderSentAt: true },
  });

  check(
    "the item of a customer who did not opt in is not even claimed",
    notOptedInRow?.reminderSentAt === null,
  );

  const noConsentLog = await prisma.smsLog.count({
    where: { orderItemId: notOptedInItem },
  });

  check("no log row is written for a customer who did not opt in", noConsentLog === 0);

  // ── 4. The idempotency keys ──────────────────────────────────────────
  section("4. SMS — the idempotency keys");

  check(
    "the automated key is derived from the order item",
    reminderIdempotencyKey("item-1") === "reminder:item-1",
  );

  check(
    "the manual key is derived from the order item",
    manualResendIdempotencyKey("item-1") === "reminder:item-1:manual",
  );

  check(
    "the manual key differs from the automated one",
    manualResendIdempotencyKey("item-1") !== reminderIdempotencyKey("item-1"),
  );

  // A second sweep sends nothing.
  const secondGateway = new MockSmsGateway();

  const secondSweep = await triggerDepletionReminders(actor, {
    gateway: secondGateway,
  });

  const secondKeys = secondGateway.sent.map((m) => m.idempotencyKey);

  check(
    "a second sweep does not re-send the same reminder",
    !secondKeys.includes(reminderIdempotencyKey(optedInItem)),
  );

  check(
    "the second sweep skipped the already-reminded item",
    secondSweep.skipped >= 1,
    `skipped ${secondSweep.skipped}`,
  );

  const logsForItem = await prisma.smsLog.count({
    where: { idempotencyKey: reminderIdempotencyKey(optedInItem) },
  });

  check("exactly one log row exists for the reminder", logsForItem === 1);

  // A manual resend uses its own key.
  const resendGateway = new MockSmsGateway();

  const resend = await resendReminder(actor, optedInItem, {
    gateway: resendGateway,
  });

  check("a manual resend is sent", resend.sent === true);

  check(
    "the manual resend used the manual key",
    resendGateway.sent[0]?.idempotencyKey ===
      manualResendIdempotencyKey(optedInItem),
  );

  // A manual resend still requires consent.
  const resendNoConsentGateway = new MockSmsGateway();

  let resendRefused = false;

  try {
    await resendReminder(actor, notOptedInItem, {
      gateway: resendNoConsentGateway,
    });
  } catch {
    resendRefused = true;
  }

  check("a manual resend to a customer who did not opt in is refused", resendRefused);

  check(
    "the refused resend sent nothing",
    resendNoConsentGateway.sent.length === 0,
  );

  // A repeated manual resend is refused.
  let repeatRefused = false;

  try {
    await resendReminder(actor, optedInItem, { gateway: resendGateway });
  } catch {
    repeatRefused = true;
  }

  check("a repeated manual resend is refused", repeatRefused);

  // ── 5. The message body ──────────────────────────────────────────────
  section("5. SMS — the message body");

  const body = buildDepletionReminderBody({
    orderNumber: "EGB-20261027-A1B2C3",
    productName: "Niacinamide 10% Serum",
    orderId: "order-1",
  });

  check("the body names the product", body.includes("Niacinamide 10% Serum"));

  check("the body names the order number", body.includes("EGB-20261027-A1B2C3"));

  check(
    "the body contains no shipping address",
    !/house|road|street|flat|block|dhanmondi|Dhaka/i.test(body),
  );

  check("the body contains no phone number", !body.includes("+880"));

  check(
    "the body contains no opt-out instruction",
    !/STOP|opt out|unsubscribe/i.test(body),
  );

  check(
    "the lead time is a constant of three days",
    REMINDER_LEAD_TIME_DAYS === 3,
  );

  await cleanup();

  if (failures > 0) {
    console.error(`\n${failures} Step 10 check(s) failed.\n`);
    return 1;
  }

  console.log("\nAll Step 10 checks passed.\n");
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });
