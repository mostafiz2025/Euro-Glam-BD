import {
  AdminAction,
  CouponDiscountType,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import {
  createCoupon,
  deactivateCoupon,
  updateCoupon,
} from "@/lib/admin/coupons";
import { ApiError } from "@/lib/api/errors";

/**
 * The coupon service, against a real database.
 *
 * A coupon is a **commercial decision with a monetary value**, so the
 * properties these tests prove are the ones that make the audit trail
 * worth having:
 *
 *   1. The coupon and its `COUPON_CREATED` entry are written
 *      **together**, in one transaction.
 *   2. A change to what the coupon is **worth** requires a reason. A
 *      change to something else — the description, the expiry — does
 *      not. This is the rule the product price change follows, and it
 *      is enforced in the service so every caller gets it.
 *   3. The audit entry records **only the fields that changed**.
 *   4. The percentage and the fixed amount are **mutually exclusive**.
 *      One column is always null.
 *   5. A code is unique, and a duplicate is a conflict — not a
 *      silently-created second coupon.
 *   6. Deactivating keeps the row and the redemption count.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCouponIds: string[] = [];

const runId = `cpn${Date.now()}${Math.floor(Math.random() * 100000)}`;

let actor: AuditActor;

/**
 * A date far enough in the future that the test does not rot.
 */
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

/**
 * Reads the audit entries for one coupon, newest first.
 */
async function readAuditEntries(couponId: string) {
  return prisma.adminAuditLog.findMany({
    where: { entityType: "coupon", entityId: couponId },
    orderBy: { createdAt: "desc" },
  });
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the coupon " +
        "integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const user = await prisma.user.create({
    data: {
      name: "Test Coupon Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Test Coupon Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) return;

  if (createdCouponIds.length > 0) {
    await prisma.adminAuditLog.deleteMany({
      where: {
        entityType: "coupon",
        entityId: { in: createdCouponIds },
      },
    });

    await prisma.coupon.deleteMany({
      where: { id: { in: createdCouponIds } },
    });
  }

  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("createCoupon", () => {
  it("writes the coupon and its audit entry together", async () => {
    if (!databaseAvailable) return;

    const code = `${runId}_created`;

    const coupon = await createCoupon(actor, {
      code,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 20,
      expiresAt: FUTURE,
      reason: "The Eid campaign launch.",
    });

    createdCouponIds.push(coupon.id);

    expect(coupon.code).toBe(code.toUpperCase());
    expect(coupon.percentOff).toBe(20);
    expect(coupon.amountOffPaisa).toBeNull();
    expect(coupon.usageCount).toBe(0);
    expect(coupon.isActive).toBe(true);

    const entries = await readAuditEntries(coupon.id);

    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe(AdminAction.COUPON_CREATED);
    expect(entries[0].actorId).toBe(actor.id);
    expect(entries[0].entityType).toBe("coupon");
    expect(entries[0].entityId).toBe(coupon.id);
    expect(entries[0].reason).toBe("The Eid campaign launch.");
  });

  it("normalises the code to uppercase", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_mixed`,
      discountType: CouponDiscountType.FIXED,
      amountOffPaisa: 15_000,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    expect(coupon.code).toBe(`${runId}_mixed`.toUpperCase());
  });

  it("accepts a coupon with no description", async () => {
    if (!databaseAvailable) return;

    // The admin form sends `null` for an empty description box, and a
    // coupon with no description is perfectly ordinary.
    const coupon = await createCoupon(actor, {
      code: `${runId}_nodesc`,
      description: null,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 20,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    expect(coupon.description).toBeNull();
  });

  it("refuses a duplicate code", async () => {
    if (!databaseAvailable) return;

    const code = `${runId}_duplicate`;

    const first = await createCoupon(actor, {
      code,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(first.id);

    await expect(
      createCoupon(actor, {
        code,
        discountType: CouponDiscountType.PERCENTAGE,
        percentOff: 15,
        expiresAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // Exactly one coupon carries the code. The service stores the
    // **normalised** form, so the count has to ask for that — asking for
    // the lowercase form would find nothing and the assertion would
    // pass for the wrong reason.
    const rows = await prisma.coupon.count({
      where: { code: code.toUpperCase() },
    });

    expect(rows).toBe(1);
  });

  it("refuses a percentage coupon with a fixed amount", async () => {
    if (!databaseAvailable) return;

    await expect(
      createCoupon(actor, {
        code: `${runId}_both`,
        discountType: CouponDiscountType.PERCENTAGE,
        percentOff: 20,
        amountOffPaisa: 15_000,
        expiresAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses a fixed coupon with a percentage", async () => {
    if (!databaseAvailable) return;

    await expect(
      createCoupon(actor, {
        code: `${runId}_both2`,
        discountType: CouponDiscountType.FIXED,
        percentOff: 20,
        amountOffPaisa: 15_000,
        expiresAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses a percentage of zero", async () => {
    if (!databaseAvailable) return;

    await expect(
      createCoupon(actor, {
        code: `${runId}_zero`,
        discountType: CouponDiscountType.PERCENTAGE,
        percentOff: 0,
        expiresAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses a percentage above one hundred", async () => {
    if (!databaseAvailable) return;

    await expect(
      createCoupon(actor, {
        code: `${runId}_over`,
        discountType: CouponDiscountType.PERCENTAGE,
        percentOff: 101,
        expiresAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses an expiry in the past", async () => {
    if (!databaseAvailable) return;

    await expect(
      createCoupon(actor, {
        code: `${runId}_past`,
        discountType: CouponDiscountType.PERCENTAGE,
        percentOff: 20,
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("writes nothing when the terms are refused", async () => {
    if (!databaseAvailable) return;

    const code = `${runId}_refused`;

    await expect(
      createCoupon(actor, {
        code,
        discountType: CouponDiscountType.PERCENTAGE,
        percentOff: 200,
        expiresAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const rows = await prisma.coupon.count({
      where: { code: code.toUpperCase() },
    });

    expect(rows).toBe(0);
  });
});

describe("updateCoupon", () => {
  it("requires a reason for a change to what the coupon is worth", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_terms`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    await expect(
      updateCoupon(actor, coupon.id, { percentOff: 20 }),
    ).rejects.toBeInstanceOf(ApiError);

    // The coupon is untouched, and no audit entry was written.
    const row = await prisma.coupon.findUnique({
      where: { id: coupon.id },
      select: { percentOff: true },
    });

    expect(row?.percentOff).toBe(10);

    const entries = await readAuditEntries(coupon.id);

    expect(entries.length).toBe(1);
  });

  it("does not require a reason for a change to the description", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_desc`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    const updated = await updateCoupon(actor, coupon.id, {
      description: "The Eid collection",
    });

    expect(updated.description).toBe("The Eid collection");
    expect(updated.percentOff).toBe(10);
  });

  it("does not require a reason for switching the coupon on or off", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_switch`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    const updated = await updateCoupon(actor, coupon.id, { isActive: false });

    expect(updated.isActive).toBe(false);
  });

  it("records only the changed fields in the audit entry", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_diff`,
      description: "Before",
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    await updateCoupon(actor, coupon.id, {
      percentOff: 20,
      reason: "Matching the Eid campaign.",
    });

    const entries = await readAuditEntries(coupon.id);
    const entry = entries[0];

    expect(entry.action).toBe(AdminAction.COUPON_UPDATED);

    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;

    expect(before.percentOff).toBe(10);
    expect(after.percentOff).toBe(20);

    // The description did not change, so it is not in the entry. An
    // audit log that reproduces the whole row on every save is a log
    // nobody reads.
    expect("description" in before).toBe(false);
    expect("description" in after).toBe(false);
  });

  it("writes no audit entry for a save that changes nothing", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_nochange`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 10,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    const entriesBefore = await readAuditEntries(coupon.id);

    await updateCoupon(actor, coupon.id, {
      description: null,
      reason: "Nothing actually moved.",
    });

    const entriesAfter = await readAuditEntries(coupon.id);

    expect(entriesAfter.length).toBe(entriesBefore.length);
  });

  it("clears the other discount column when the type changes", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_switchtype`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 20,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    const updated = await updateCoupon(actor, coupon.id, {
      discountType: CouponDiscountType.FIXED,
      amountOffPaisa: 15_000,
      reason: "The campaign became a flat discount.",
    });

    expect(updated.discountType).toBe(CouponDiscountType.FIXED);
    expect(updated.amountOffPaisa).toBe(15_000);

    // The percentage is nulled, because the two columns are mutually
    // exclusive. A row with both set would be ambiguous.
    expect(updated.percentOff).toBeNull();
  });

  it("refuses an update that would leave the coupon in an invalid state", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_invalid`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 20,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    await expect(
      updateCoupon(actor, coupon.id, {
        percentOff: 500,
        reason: "An attempt to break the rule.",
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses an update to a coupon that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      updateCoupon(actor, "ckq1doesnotexist00000abc", {
        description: "Nothing.",
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe("deactivateCoupon", () => {
  it("keeps the row and the redemption count", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_deactivate`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 15,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    // A redemption, so the count is not trivially zero.
    await prisma.coupon.update({
      where: { id: coupon.id },
      data: { usageCount: 4 },
    });

    const deactivated = await deactivateCoupon(
      actor,
      coupon.id,
      "The campaign ended early.",
    );

    expect(deactivated.isActive).toBe(false);
    expect(deactivated.usageCount).toBe(4);

    // The row is still there. A coupon that has been redeemed has
    // history, and deleting it would erase the record of the campaign.
    const row = await prisma.coupon.findUnique({
      where: { id: coupon.id },
      select: { id: true },
    });

    expect(row).not.toBeNull();
  });

  it("writes an audit entry with the reason", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_deactaudit`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 15,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    await deactivateCoupon(actor, coupon.id, "The campaign ended early.");

    const entries = await readAuditEntries(coupon.id);

    expect(entries.length).toBe(2);
    expect(entries[0].action).toBe(AdminAction.COUPON_DELETED);
    expect(entries[0].reason).toBe("The campaign ended early.");
  });

  it("refuses a deactivation with a blank reason", async () => {
    if (!databaseAvailable) return;

    const coupon = await createCoupon(actor, {
      code: `${runId}_blankreason`,
      discountType: CouponDiscountType.PERCENTAGE,
      percentOff: 15,
      expiresAt: FUTURE,
    });

    createdCouponIds.push(coupon.id);

    await expect(
      deactivateCoupon(actor, coupon.id, "   "),
    ).rejects.toBeInstanceOf(ApiError);

    const row = await prisma.coupon.findUnique({
      where: { id: coupon.id },
      select: { isActive: true },
    });

    expect(row?.isActive).toBe(true);
  });
});
