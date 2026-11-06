/**
 * Step 13 verification script.
 *
 * Proves the Step 13 deliverables behave correctly against a real
 * database, outside the unit tests:
 *
 *   1. **The analytics funnel** — the live metrics the Analytics page
 *      shows, computed from `db.order` and `db.trafficEvent`. The
 *      conversion rate must be `null` against a zero base, never a
 *      percentage.
 *   2. **The audit trail** — the explorer must find what the services
 *      wrote, must filter by action and entity type, and must count
 *      the distinct admins who have acted.
 *   3. **The coupon lifecycle** — create, edit, deactivate, each with
 *      its audit entry written in the same transaction; the mandatory
 *      reason; the mutually exclusive discount columns; the preserved
 *      redemption count.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step13.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import { AdminAction, CouponDiscountType, PrismaClient } from "@prisma/client";

import { listAuditLogs } from "@/lib/admin/audit-logs";
import { type AuditActor } from "@/lib/admin/audit";
import {
  couponStatus,
  createCoupon,
  deactivateCoupon,
  listAdminCoupons,
  updateCoupon,
} from "@/lib/admin/coupons";
import { getFunnelMetrics } from "@/lib/admin/analytics";
import { ApiError } from "@/lib/api/errors";

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

const runId = `s13${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCouponIds: string[] = [];

let actor: AuditActor;

async function main(): Promise<void> {
  // ── The fixtures ───────────────────────────────────────────────────────
  const user = await prisma.user.create({
    data: {
      name: "Step 13 Verifier",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Step 13 Verifier",
    email: `${runId}_admin@example.com`,
  };

  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // ── 1. The analytics funnel ────────────────────────────────────────────
  section("1. The analytics funnel");

  const funnel = await getFunnelMetrics(30);

  check(
    "the funnel reports a visit count",
    Number.isFinite(funnel.visits) && funnel.visits >= 0,
    `${funnel.visits} visit(s)`,
  );

  check(
    "the funnel reports an order count",
    Number.isFinite(funnel.orders) && funnel.orders >= 0,
    `${funnel.orders} order(s)`,
  );

  check(
    "the funnel reports a revenue figure",
    Number.isFinite(funnel.revenuePaisa) && funnel.revenuePaisa >= 0,
    `${funnel.revenuePaisa} poisha`,
  );

  /*
   * The conversion rate against a zero base.
   *
   * This is the property that the whole funnel rests on: a percentage
   * against a zero base is a division by zero wearing a percentage's
   * clothes, and the service returns `null` for it instead.
   */
  if (funnel.visits === 0) {
    check(
      "the conversion rate is null against a zero visit base",
      funnel.conversionRate === null,
      `got ${String(funnel.conversionRate)}`,
    );
  } else {
    const expected = (funnel.orders / funnel.visits) * 100;

    check(
      "the conversion rate matches orders ÷ visits",
      funnel.conversionRate !== null &&
        Math.abs(funnel.conversionRate - expected) < 0.0001,
      `got ${String(funnel.conversionRate)}`,
    );
  }

  check(
    "the funnel reports a units-sold figure",
    Number.isFinite(funnel.unitsSold) && funnel.unitsSold >= 0,
    `${funnel.unitsSold} unit(s)`,
  );

  // ── 2. The coupon lifecycle ────────────────────────────────────────────
  section("2. The coupon lifecycle");

  const coupon = await createCoupon(actor, {
    code: `${runId}_percent`,
    description: "The Step 13 verification coupon",
    discountType: CouponDiscountType.PERCENTAGE,
    percentOff: 20,
    expiresAt: future,
    reason: "Created by the verification script.",
  });

  createdCouponIds.push(coupon.id);

  check(
    "the coupon is created with its terms",
    coupon.percentOff === 20 && coupon.amountOffPaisa === null,
    `percentOff=${coupon.percentOff} amountOffPaisa=${coupon.amountOffPaisa}`,
  );

  check(
    "the coupon's code is normalised to uppercase",
    coupon.code === coupon.code.toUpperCase(),
    coupon.code,
  );

  check(
    "the coupon starts active",
    coupon.isActive && couponStatus(coupon) === "ACTIVE",
  );

  // The creation wrote its audit entry.
  const afterCreate = await listAuditLogs({
    entityType: "coupon",
    page: 1,
    limit: 50,
  });

  const createEntry = afterCreate.entries.find(
    (entry) => entry.entityId === coupon.id,
  );

  check(
    "the creation wrote a COUPON_CREATED audit entry",
    createEntry?.action === AdminAction.COUPON_CREATED,
    createEntry?.action ?? "none",
  );

  check(
    "the creation's audit entry names the actor",
    createEntry?.actorId === actor.id,
    createEntry?.actorEmail ?? "none",
  );

  check(
    "the creation's audit entry carries the reason",
    createEntry?.reason === "Created by the verification script.",
    createEntry?.reason ?? "none",
  );

  // ── The mutually exclusive discount columns ────────────────────────────
  section("3. The discount columns are mutually exclusive");

  const both = await createCoupon(actor, {
    code: `${runId}_both`,
    discountType: CouponDiscountType.PERCENTAGE,
    percentOff: 20,
    amountOffPaisa: 15_000,
    expiresAt: future,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  check(
    "a percentage coupon with a fixed amount is refused",
    both instanceof ApiError,
    both instanceof ApiError ? both.message : "it was accepted",
  );

  const tooBig = await createCoupon(actor, {
    code: `${runId}_over`,
    discountType: CouponDiscountType.PERCENTAGE,
    percentOff: 101,
    expiresAt: future,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  check(
    "a percentage above 100 is refused",
    tooBig instanceof ApiError,
    tooBig instanceof ApiError ? tooBig.message : "it was accepted",
  );

  const expired = await createCoupon(actor, {
    code: `${runId}_past`,
    discountType: CouponDiscountType.PERCENTAGE,
    percentOff: 20,
    expiresAt: new Date(Date.now() - 1000),
  }).then(
    () => null,
    (error: unknown) => error,
  );

  check(
    "an expiry in the past is refused",
    expired instanceof ApiError,
    expired instanceof ApiError ? expired.message : "it was accepted",
  );

  // ── The mandatory reason ───────────────────────────────────────────────
  section("4. A change to the terms needs a reason");

  const noReason = await updateCoupon(actor, coupon.id, {
    percentOff: 30,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  check(
    "a change to what the coupon is worth is refused without a reason",
    noReason instanceof ApiError,
    noReason instanceof ApiError ? noReason.message : "it was accepted",
  );

  const unchanged = await prisma.coupon.findUnique({
    where: { id: coupon.id },
    select: { percentOff: true },
  });

  check(
    "the refused change left the coupon alone",
    unchanged?.percentOff === 20,
    `percentOff=${unchanged?.percentOff}`,
  );

  const noReasonEntries = await listAuditLogs({
    entityType: "coupon",
    page: 1,
    limit: 50,
  });

  const refusedEntries = noReasonEntries.entries.filter(
    (entry) => entry.entityId === coupon.id,
  );

  check(
    "the refused change wrote no audit entry",
    refusedEntries.length === 1,
    `${refusedEntries.length} entry/entries`,
  );

  // A change that touches something else does **not** need a reason.
  const descriptionOnly = await updateCoupon(actor, coupon.id, {
    description: "A new description",
  });

  check(
    "a change to the description does not need a reason",
    descriptionOnly.description === "A new description",
  );

  // ── The diff in the audit entry ────────────────────────────────────────
  section("5. The audit entry records only the changed fields");

  await updateCoupon(actor, coupon.id, {
    percentOff: 30,
    reason: "Matching the Eid campaign.",
  });

  const afterUpdate = await listAuditLogs({
    entityType: "coupon",
    page: 1,
    limit: 50,
  });

  const updateEntry = afterUpdate.entries.find(
    (entry) =>
      entry.entityId === coupon.id &&
      entry.action === AdminAction.COUPON_UPDATED,
  );

  const before = (updateEntry?.before ?? {}) as Record<string, unknown>;
  const after = (updateEntry?.after ?? {}) as Record<string, unknown>;

  check(
    "the update's entry records the old percentage",
    before.percentOff === 20,
    `before.percentOff=${String(before.percentOff)}`,
  );

  check(
    "the update's entry records the new percentage",
    after.percentOff === 30,
    `after.percentOff=${String(after.percentOff)}`,
  );

  check(
    "the update's entry leaves the untouched description out",
    !("description" in before) && !("description" in after),
  );

  check(
    "the update's entry carries the reason",
    updateEntry?.reason === "Matching the Eid campaign.",
    updateEntry?.reason ?? "none",
  );

  // ── The type change ────────────────────────────────────────────────────
  section("6. A change of discount type");

  const switched = await updateCoupon(actor, coupon.id, {
    discountType: CouponDiscountType.FIXED,
    amountOffPaisa: 15_000,
    reason: "The campaign became a flat discount.",
  });

  check(
    "the type change is applied",
    switched.discountType === CouponDiscountType.FIXED,
    switched.discountType,
  );

  check(
    "the type change nulls the percentage column",
    switched.percentOff === null,
    `percentOff=${String(switched.percentOff)}`,
  );

  check(
    "the type change sets the fixed amount",
    switched.amountOffPaisa === 15_000,
    `amountOffPaisa=${String(switched.amountOffPaisa)}`,
  );

  // ── The deactivation ───────────────────────────────────────────────────
  section("7. The deactivation");

  // A redemption, so the count is not trivially zero.
  await prisma.coupon.update({
    where: { id: coupon.id },
    data: { usageCount: 7 },
  });

  const blankReason = await deactivateCoupon(actor, coupon.id, "   ").then(
    () => null,
    (error: unknown) => error,
  );

  check(
    "a deactivation with a blank reason is refused",
    blankReason instanceof ApiError,
    blankReason instanceof ApiError
      ? blankReason.message
      : "it was accepted",
  );

  const stillActive = await prisma.coupon.findUnique({
    where: { id: coupon.id },
    select: { isActive: true },
  });

  check(
    "the refused deactivation left the coupon switched on",
    stillActive?.isActive === true,
  );

  const deactivated = await deactivateCoupon(
    actor,
    coupon.id,
    "The campaign ended early.",
  );

  check(
    "the deactivation switches the coupon off",
    deactivated.isActive === false,
  );

  check(
    "the deactivation keeps the redemption count",
    deactivated.usageCount === 7,
    `usageCount=${deactivated.usageCount}`,
  );

  const row = await prisma.coupon.findUnique({
    where: { id: coupon.id },
    select: { id: true },
  });

  check(
    "the deactivation keeps the row",
    row !== null,
  );

  const deactivateEntry = (
    await listAuditLogs({ entityType: "coupon", page: 1, limit: 50 })
  ).entries.find(
    (entry) =>
      entry.entityId === coupon.id &&
      entry.action === AdminAction.COUPON_DELETED,
  );

  check(
    "the deactivation wrote a COUPON_DELETED audit entry",
    deactivateEntry !== undefined,
  );

  check(
    "the deactivation's entry carries the reason",
    deactivateEntry?.reason === "The campaign ended early.",
    deactivateEntry?.reason ?? "none",
  );

  // ── The coupon list ────────────────────────────────────────────────────
  section("8. The coupon list");

  const list = await listAdminCoupons({ page: 1, limit: 20 });

  check(
    "the list reports a total",
    list.counts.total > 0,
    `${list.counts.total} coupon(s)`,
  );

  check(
    "the list's active count does not exceed the total",
    list.counts.active <= list.counts.total,
    `${list.counts.active} active of ${list.counts.total}`,
  );

  check(
    "the list's expired count does not exceed the total",
    list.counts.expired <= list.counts.total,
    `${list.counts.expired} expired of ${list.counts.total}`,
  );

  check(
    "the list's exhausted count does not exceed the total",
    list.counts.exhausted <= list.counts.total,
    `${list.counts.exhausted} exhausted of ${list.counts.total}`,
  );

  // ── The audit trail's filters ──────────────────────────────────────────
  section("9. The audit trail's filters");

  const filtered = await listAuditLogs({
    action: AdminAction.COUPON_CREATED,
    page: 1,
    limit: 50,
  });

  const wrongAction = filtered.entries.filter(
    (entry) => entry.action !== AdminAction.COUPON_CREATED,
  );

  check(
    "the action filter returns only that action",
    wrongAction.length === 0,
    `${filtered.entries.length} entry/entries`,
  );

  const byEntity = await listAuditLogs({
    entityType: "coupon",
    page: 1,
    limit: 50,
  });

  const wrongEntity = byEntity.entries.filter(
    (entry) => entry.entityType !== "coupon",
  );

  check(
    "the entity filter returns only that entity type",
    wrongEntity.length === 0,
    `${byEntity.entries.length} entry/entries`,
  );

  const byActor = await listAuditLogs({
    actorId: actor.id,
    page: 1,
    limit: 50,
  });

  const wrongActor = byActor.entries.filter(
    (entry) => entry.actorId !== actor.id,
  );

  check(
    "the actor filter returns only that admin's entries",
    wrongActor.length === 0,
    `${byActor.entries.length} entry/entries`,
  );

  check(
    "the trail counts the distinct admins who have acted",
    byActor.counts.actors >= 1,
    `${byActor.counts.actors} admin(s)`,
  );

  const searched = await listAuditLogs({
    search: actor.email,
    page: 1,
    limit: 50,
  });

  check(
    "the search finds entries by the actor's email",
    searched.entries.length > 0,
    `${searched.entries.length} entry/entries`,
  );

  const searchedByReason = await listAuditLogs({
    search: "Eid campaign",
    page: 1,
    limit: 50,
  });

  check(
    "the search finds entries by their reason",
    searchedByReason.entries.length > 0,
    `${searchedByReason.entries.length} entry/entries`,
  );

  // ── The summary ────────────────────────────────────────────────────────
  section("Summary");

  if (failures === 0) {
    console.log("\n  All Step 13 checks passed.\n");
  } else {
    console.error(`\n  ${failures} Step 13 check(s) FAILED.\n`);
  }
}

main()
  .catch((error) => {
    console.error("\n  The verification script itself failed:", error);
    failures += 1;
  })
  .finally(async () => {
    try {
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
    } catch {
      // The cleanup is best-effort. A failed cleanup must not mask the
      // script's own result.
    } finally {
      await prisma.$disconnect();
    }

    process.exit(failures === 0 ? 0 : 1);
  });
