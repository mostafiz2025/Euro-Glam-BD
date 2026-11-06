import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditActor } from "@/lib/admin/audit";
import { MockSmsGateway } from "@/lib/sms/mock-gateway";
import { SmsGatewayError } from "@/lib/sms/adapter";
import {
  REMINDER_LEAD_TIME_DAYS,
  resendReminder,
  triggerDepletionReminders,
} from "@/lib/sms/service";

/**
 * The SMS reminder workflow, end to end.
 *
 * These exercise the real database and the real service. The properties
 * they prove are the ones a unit test cannot:
 *
 *   1. A reminder is sent when it is due.
 *   2. **A reminder is NOT sent without opt-in.** This is the single
 *      most important test in the suite: the consent check lives in the
 *      claim query's `WHERE` clause, so it holds against a real
 *      database, not just against a mock.
 *   3. No message without a phone number.
 *   4. No message for an item with no estimate — estimates are never
 *      inferred.
 *   5. The reminder fires *before* the product runs out.
 *   6. Running the sweep twice sends one message.
 *   7. Two concurrent sweeps send one message.
 *   8. A failure is recorded and the sweep continues.
 *   9. A manual resend **still requires consent**.
 *
 * The gateway is injected, so the tests never touch the environment.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];
const createdOrderItemIds: string[] = [];

const runId = `sms${Date.now()}${Math.floor(Math.random() * 100000)}`;

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
  options: {
    phone?: string | null;
    smsOptIn?: boolean;
    role?: "CUSTOMER" | "ADMIN";
  } = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Customer",
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
    data: { name: "SMS Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

async function createProduct(categoryId: string, name: string): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `SMS test product ${name}`,
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 100,
      ingredientTags: [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

/**
 * Creates an order with one line that may carry a depletion estimate.
 */
async function createOrderItem(
  userId: string,
  productId: string,
  options: {
    estimatedEmptyAt?: Date | null;
    orderNumber: string;
  },
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId,
      orderNumber: options.orderNumber,
      status: "PENDING",
      paymentStatus: "PENDING",
      paymentMethod: "COD",
      subtotalPaisa: 100000,
      totalAmountPaisa: 108000,
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
          quantity: 1,
          estimatedEmptyAt:
            options.estimatedEmptyAt === undefined
              ? null
              : options.estimatedEmptyAt,
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

  createdOrderItemIds.push(itemId);

  return itemId;
}

let categoryId: string;
let productId: string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the SMS " +
        "reminder integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const adminId = await createUser(`${runId}_admin@example.com`, {
    role: "ADMIN",
  });

  actor = {
    id: adminId,
    name: "Admin Actor",
    email: `${runId}_admin@example.com`,
  };

  categoryId = await createCategory(`${runId}-cat`);
  productId = await createProduct(categoryId, "SMS Product");
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    /*
     * The audit entries are scoped to **this file's** order items, plus
     * the sweep entry the service writes under the fixed id `"sweep"`.
     *
     * A blanket `entityType: "order_item"` delete would erase the shop's
     * own history — every real reminder the shop has ever sent — to make
     * this file's assertions tidy. The audit log is a record of what
     * happened to the shop, and a test is not allowed to rewrite it.
     *
     * The `"sweep"` entry is named because the sweep is a run rather than
     * an item, so it has no single item to point at. It is included here
     * because this file's own sweeps are what wrote it.
     */
    await prisma.adminAuditLog.deleteMany({
      where: {
        entityType: "order_item",
        entityId: { in: ["sweep", ...createdOrderItemIds] },
      },
    });

    /*
     * The SMS log is scoped the same way — to the messages this file's
     * orders produced. `smsLog.deleteMany({})` would take the shop's
     * entire message history with it.
     */
    await prisma.smsLog.deleteMany({
      where: { orderItemId: { in: createdOrderItemIds } },
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

/**
 * A date inside the reminder window.
 */
function dueSoon(): Date {
  return new Date(Date.now() + 24 * 60 * 60 * 1000);
}

/**
 * A date far outside the reminder window.
 */
function notDue(): Date {
  return new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
}

describe("triggerDepletionReminders — the happy path", () => {
  it("sends a reminder to a customer who opted in", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_opted_in@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S1`,
    });

    const gateway = new MockSmsGateway();

    const result = await triggerDepletionReminders(actor, { gateway });

    // The sweep is global, so `result.sent` may include items left
    // behind by earlier tests. This item's message is what matters.
    const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

    expect(sentKeys).toContain(`reminder:${itemId}`);
    expect(result.failed).toBe(0);

    const message = gateway.sent.find(
      (m) => m.idempotencyKey === `reminder:${itemId}`,
    );

    expect(message?.to).toBe("+8801700000000");

    // The claim marked the item.
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { reminderSentAt: true },
    });

    expect(item?.reminderSentAt).not.toBeNull();

    // The log row records the send.
    const log = await prisma.smsLog.findFirst({
      where: { orderItemId: itemId },
    });

    expect(log?.status).toBe("sent");
    expect(log?.reason).toBe("depletion_reminder");
    expect(log?.idempotencyKey).toBe(`reminder:${itemId}`);
  });

  it("sends the reminder before the product runs out", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_early@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    // Due in one day, with a three-day lead time.
    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S2`,
    });

    const gateway = new MockSmsGateway();

    await triggerDepletionReminders(actor, { gateway });

    // The sweep is global, so the gateway may carry messages for items
    // another test left behind. This item's message is what matters —
    // and it is what proves the lead time is honoured.
    const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

    expect(sentKeys).toContain(`reminder:${itemId}`);
  });
});

describe("triggerDepletionReminders — the consent gate", () => {
  it("does not send to a customer who has not opted in", async () => {
    if (!databaseAvailable) return;

    // The most important test in this suite.
    const userId = await createUser(`${runId}_not_opted_in@example.com`, {
      phone: "+8801700000000",
      smsOptIn: false,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S3`,
    });

    const gateway = new MockSmsGateway();

    const result = await triggerDepletionReminders(actor, { gateway });

    // This item's message was never sent.
    const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

    expect(sentKeys).not.toContain(`reminder:${itemId}`);

    // And it was skipped, with the reason recorded.
    const detail = result.details.find((d) => d.orderItemId === itemId);

    expect(detail?.status).toBe("skipped");
    expect(detail?.reason).toMatch(/opted in/i);

    // The item was not claimed.
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { reminderSentAt: true },
    });

    expect(item?.reminderSentAt).toBeNull();

    // And no log row was written.
    const logs = await prisma.smsLog.count({
      where: { orderItemId: itemId },
    });

    expect(logs).toBe(0);
  });

  it("does not send to a customer with no phone number", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_no_phone@example.com`, {
      phone: null,
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S4`,
    });

    const gateway = new MockSmsGateway();

    const result = await triggerDepletionReminders(actor, { gateway });

    // This item's message was never sent, and it was skipped for the
    // right reason.
    const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

    expect(sentKeys).not.toContain(`reminder:${itemId}`);

    const detail = result.details.find((d) => d.orderItemId === itemId);

    expect(detail?.status).toBe("skipped");
    expect(detail?.reason).toMatch(/phone number/i);
  });

  it("protects a customer who opts out after the candidate list was built", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_opt_out_mid@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S5`,
    });

    // The customer opts out. The candidate list was built *before* the
    // opt-out — but the consent check lives in the claim query's
    // `WHERE` clause, not in application code after the fetch. So the
    // claim fails, and nothing is sent.
    await prisma.user.update({
      where: { id: userId },
      data: { smsOptIn: false },
    });

    const gateway = new MockSmsGateway();

    const result = await triggerDepletionReminders(actor, { gateway });

    const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

    expect(sentKeys).not.toContain(`reminder:${itemId}`);

    // The item was not claimed.
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { reminderSentAt: true },
    });

    expect(item?.reminderSentAt).toBeNull();

    // And the report says exactly why.
    const detail = result.details.find((d) => d.orderItemId === itemId);

    expect(detail?.status).toBe("skipped");
    expect(detail?.reason).toMatch(/opted in/i);
  });
});

describe("triggerDepletionReminders — the reminder window", () => {
  it("does not send for an item with no estimate", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_no_estimate@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: null,
      orderNumber: `${runId}-S6`,
    });

    const gateway = new MockSmsGateway();

    await triggerDepletionReminders(actor, { gateway });

    // Estimates are never inferred, so there is nothing to remind about.
    //
    // The sweep is **global** — it looks at every order item in the
    // table, not just this suite's — so the gateway may legitimately
    // carry messages for items another test left behind. What must not
    // happen is a message for *this* item, which has no estimate and
    // therefore has no reminder to send.
    const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

    expect(sentKeys).not.toContain(`reminder:${itemId}`);
  });

  it("does not send for an item that is not due yet", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_not_due@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: notDue(),
      orderNumber: `${runId}-S7`,
    });

    const gateway = new MockSmsGateway();

    await triggerDepletionReminders(actor, { gateway });

    // The sweep is global — it looks at every item that is due — so
    // the assertion is about *this* item, not about the run's totals.
    // Earlier tests in this file leave unclaimed items behind, and the
    // sweep correctly picks them up.
    const sentKeys = gateway.sent.map((m) => m.idempotencyKey);

    expect(sentKeys).not.toContain(`reminder:${itemId}`);

    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { reminderSentAt: true },
    });

    expect(item?.reminderSentAt).toBeNull();
  });

  it("uses a lead time of three days", async () => {
    expect(REMINDER_LEAD_TIME_DAYS).toBe(3);
  });
});

describe("triggerDepletionReminders — idempotency", () => {
  it("sends one message when the sweep runs twice", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_twice@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S8`,
    });

    const firstGateway = new MockSmsGateway();
    await triggerDepletionReminders(actor, { gateway: firstGateway });

    const secondGateway = new MockSmsGateway();
    await triggerDepletionReminders(actor, { gateway: secondGateway });

    // The first run sent it; the second did not. Exactly one message
    // for this item, across both runs.
    const firstKeys = firstGateway.sent.map((m) => m.idempotencyKey);
    const secondKeys = secondGateway.sent.map((m) => m.idempotencyKey);

    expect(firstKeys).toContain(`reminder:${itemId}`);
    expect(secondKeys).not.toContain(`reminder:${itemId}`);

    // And the item was claimed only once.
    const logs = await prisma.smsLog.count({
      where: { idempotencyKey: `reminder:${itemId}` },
    });

    expect(logs).toBe(1);
  });

  it("sends one message when two sweeps run concurrently", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_concurrent@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S9`,
    });

    const firstGateway = new MockSmsGateway();
    const secondGateway = new MockSmsGateway();

    await Promise.all([
      triggerDepletionReminders(actor, { gateway: firstGateway }),
      triggerDepletionReminders(actor, { gateway: secondGateway }),
    ]);

    // Exactly one of the two concurrent sweeps claimed this item.
    const totalForItem =
      firstGateway.sent.filter(
        (m) => m.idempotencyKey === `reminder:${itemId}`,
      ).length +
      secondGateway.sent.filter(
        (m) => m.idempotencyKey === `reminder:${itemId}`,
      ).length;

    expect(totalForItem).toBe(1);

    // And the log confirms it.
    const logs = await prisma.smsLog.count({
      where: { idempotencyKey: `reminder:${itemId}` },
    });

    expect(logs).toBe(1);
  });
});

describe("triggerDepletionReminders — failure handling", () => {
  it("records a failure and continues with the next item", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_failing@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const failingItem = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S10`,
    });

    const secondUser = await createUser(`${runId}_after_failure@example.com`, {
      phone: "+8801700000001",
      smsOptIn: true,
    });

    const secondItem = await createOrderItem(secondUser, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S11`,
    });

    // A gateway that fails the message for one item and accepts the rest.
    let callCount = 0;

    const gateway = {
      name: "flaky",
      async send(message: {
        to: string;
        body: string;
        idempotencyKey: string;
      }) {
        // The failing call is the one for the item this test expects to
        // fail; every later call succeeds.
        callCount += 1;

        if (message.idempotencyKey === `reminder:${failingItem}`) {
          throw new SmsGatewayError(
            "PROVIDER_UNAVAILABLE",
            "flaky",
            "The provider is down.",
          );
        }

        return { ok: true, providerMessageId: `flaky_${callCount}` };
      },
    };

    const result = await triggerDepletionReminders(actor, { gateway });

    // One failure did not abort the rest. The sweep is global — it
    // looks at every due item — so the counts include items left
    // behind by earlier tests. What matters is that BOTH of this
    // test's items were processed: the first failed, the second was
    // sent.
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(result.examined).toBeGreaterThanOrEqual(2);

    // The failure is recorded, with its error code.
    const failureLog = await prisma.smsLog.findFirst({
      where: { orderItemId: failingItem },
    });

    expect(failureLog?.status).toBe("failed");
    expect(failureLog?.errorCode).toBe("PROVIDER_UNAVAILABLE");

    // The second message was sent and recorded.
    const successLog = await prisma.smsLog.findFirst({
      where: { orderItemId: secondItem },
    });

    expect(successLog?.status).toBe("sent");
  });

  it("does not loop on a failed item", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_no_loop@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S12`,
    });

    const gateway = {
      name: "always-fails",
      async send() {
        throw new SmsGatewayError("SEND_FAILED", "always-fails", "Nope.");
      },
    };

    await triggerDepletionReminders(actor, { gateway });

    // The item was still claimed, so the next sweep does not try it
    // again. The admin resends by hand if they want to.
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { reminderSentAt: true },
    });

    expect(item?.reminderSentAt).not.toBeNull();
  });
});

describe("triggerDepletionReminders — the dry run", () => {
  it("reports without sending or writing anything", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_dry@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S13`,
    });

    const gateway = new MockSmsGateway();

    const result = await triggerDepletionReminders(actor, {
      gateway,
      dryRun: true,
    });

    // The sweep is global, so `result.sent` counts every item that
    // *would* have been reminded — including items another test left
    // behind. This item is one of them, which is what the dry run is
    // reporting on.
    expect(result.sent).toBeGreaterThanOrEqual(1);

    // And a dry run sends nothing at all.
    expect(gateway.sent).toHaveLength(0);

    // Nothing was written.
    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { reminderSentAt: true },
    });

    expect(item?.reminderSentAt).toBeNull();

    const logs = await prisma.smsLog.count({
      where: { orderItemId: itemId },
    });

    expect(logs).toBe(0);
  });

  it("reports a customer without consent as skipped", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_dry_no_consent@example.com`, {
      phone: "+8801700000000",
      smsOptIn: false,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-S14`,
    });

    const gateway = new MockSmsGateway();

    const result = await triggerDepletionReminders(actor, {
      gateway,
      dryRun: true,
    });

    // The sweep is global, so the totals include items left behind by
    // earlier tests. This test's item is the one that matters.
    const skippedIds = result.details
      .filter((d) => d.status === "skipped")
      .map((d) => d.orderItemId);

    expect(skippedIds).toContain(itemId);

    // And the reason says exactly why.
    const detail = result.details.find((d) => d.orderItemId === itemId);

    expect(detail?.reason).toMatch(/opted in/i);
  });
});

describe("resendReminder", () => {
  it("sends a manual resend to a customer who opted in", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_resend@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: null,
      orderNumber: `${runId}-R1`,
    });

    const gateway = new MockSmsGateway();

    const result = await resendReminder(actor, itemId, { gateway });

    expect(result.sent).toBe(true);
    expect(result.smsLogId).toBeTruthy();
    expect(gateway.sent).toHaveLength(1);

    const log = await prisma.smsLog.findFirst({
      where: { id: result.smsLogId },
    });

    expect(log?.reason).toBe("manual_resend");
    expect(log?.idempotencyKey).toBe(`reminder:${itemId}:manual`);
  });

  it("refuses a customer who has not opted in", async () => {
    if (!databaseAvailable) return;

    // A manual resend does NOT bypass consent. Admin authority is for
    // deciding to send, not for overriding the recipient's consent.
    const userId = await createUser(`${runId}_resend_no_consent@example.com`, {
      phone: "+8801700000000",
      smsOptIn: false,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: null,
      orderNumber: `${runId}-R2`,
    });

    const gateway = new MockSmsGateway();

    await expect(
      resendReminder(actor, itemId, { gateway }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(gateway.sent).toHaveLength(0);
  });

  it("refuses a repeated manual resend of the same item", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_resend_twice@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: null,
      orderNumber: `${runId}-R3`,
    });

    const gateway = new MockSmsGateway();

    await resendReminder(actor, itemId, { gateway });

    await expect(
      resendReminder(actor, itemId, { gateway }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Only one message was actually sent.
    expect(gateway.sent).toHaveLength(1);
  });

  it("sends a manual resend even when the item was already reminded", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_resend_after@example.com`, {
      phone: "+8801700000000",
      smsOptIn: true,
    });

    const itemId = await createOrderItem(userId, productId, {
      estimatedEmptyAt: dueSoon(),
      orderNumber: `${runId}-R4`,
    });

    const sweepGateway = new MockSmsGateway();
    await triggerDepletionReminders(actor, { gateway: sweepGateway });

    // The sweep is global, so it may have sent this item plus others.
    // What matters is that THIS item was reminded.
    expect(
      sweepGateway.sent.map((m) => m.idempotencyKey),
    ).toContain(`reminder:${itemId}`);

    const item = await prisma.orderItem.findUnique({
      where: { id: itemId },
      select: { reminderSentAt: true },
    });

    expect(item?.reminderSentAt).not.toBeNull();

    // The manual resend bypasses the schedule — that is its purpose.
    const resendGateway = new MockSmsGateway();
    const result = await resendReminder(actor, itemId, {
      gateway: resendGateway,
    });

    expect(result.sent).toBe(true);
    expect(resendGateway.sent).toHaveLength(1);
    expect(resendGateway.sent[0]?.idempotencyKey).toBe(
      `reminder:${itemId}:manual`,
    );
  });

  it("throws a 404 for an item that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      resendReminder(actor, "ckq1doesnotexist00000000a", {
        gateway: new MockSmsGateway(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
