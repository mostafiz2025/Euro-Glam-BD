-- Step 13 — Coupons and the audit-trail explorer.
--
-- Three changes:
--
--   1. The `Coupon` table. A coupon is a commercial decision with a
--      monetary value — "twenty percent off" is a price reduction, not a
--      feature — so its terms live in columns an admin sets and an audit
--      entry can record, rather than in a hard-coded rule set.
--
--      The percentage and the fixed amount are **separate columns**, one
--      of which is always null. A single `value` column would make "20"
--      mean 20% in one row and ৳20 in another, and the reader would have
--      to know which. Two columns cannot be misread.
--
--      Money is integer poisha everywhere in this codebase (1 BDT = 100
--      poisha), so a fixed discount is stored in poisha. A float taka
--      amount would introduce a second unit into a system that has
--      exactly one, and the rounding would not be ours.
--
--      `usageLimit` is nullable because null means "no limit". Zero
--      would mean "nobody may use this", which is a different thing, and
--      an accidental zero would silently kill a campaign.
--
--   2. `AdminAction` gains `COUPON_CREATED`, `COUPON_UPDATED` and
--      `COUPON_DELETED`. Every mutating admin action in this codebase is
--      audited, and these would be the first that were not. An audit
--      action that no service can write is an action that looks
--      supported but silently never happens.
--
--   3. The `CouponDiscountType` enum.
--
-- There is no backfill: the `Coupon` table is new, and the enum values
-- are additive.

-- AlterEnum
ALTER TYPE "AdminAction" ADD VALUE 'COUPON_CREATED';
ALTER TYPE "AdminAction" ADD VALUE 'COUPON_UPDATED';
ALTER TYPE "AdminAction" ADD VALUE 'COUPON_DELETED';

-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENTAGE', 'FIXED');

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "description" VARCHAR(200),
    "discountType" "CouponDiscountType" NOT NULL,
    "percentOff" INTEGER,
    "amountOffPaisa" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usageLimit" INTEGER,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE INDEX "coupons_isActive_expiresAt_idx" ON "coupons"("isActive", "expiresAt");

-- CreateIndex
CREATE INDEX "coupons_createdAt_idx" ON "coupons"("createdAt" DESC);
