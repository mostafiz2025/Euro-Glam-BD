-- Step 10 — Admin audit log, review moderation state and the SMS workflow.
--
-- Four changes:
--
--   1. `admin_audit_logs` — a new table recording every privileged
--      action. One row per decision, appended and never updated, so the
--      full history of a review's moderation survives.
--
--   2. `reviews.isHidden` and `reviews.moderatedAt` — `isApproved` alone
--      cannot tell a hidden review from a pending one; both read as "not
--      public". A hidden review WAS approved once, and that history must
--      not be lost.
--
--   3. `sms_logs` — `errorCode`, `orderItemId`, `reason` and
--      `providerMessageId`, so a failed send is recorded as a failure
--      with a machine-readable code, the admin log view can find the
--      messages for one order line, and support can quote the provider's
--      own reference when asking the provider what happened to a
--      specific message.
--
--   4. Indexes — the moderation queue filters on `isApproved` +
--      `isHidden`; the reminder sweep filters on `estimatedEmptyAt` AND
--      `reminderSentAt IS NULL`; the admin SMS log sorts by `createdAt`
--      and filters by `status`. None of those were indexed.
--
-- There is no backfill: the audit table is new, and every added column
-- is nullable or carries a default.

-- CreateEnum
CREATE TYPE "AdminAction" AS ENUM ('REVIEW_APPROVED', 'REVIEW_HIDDEN', 'REVIEW_UNHIDDEN', 'ORDER_STATUS_CHANGED', 'ORDER_PAYMENT_STATUS_CHANGED', 'ORDER_CANCELLED', 'SMS_REMINDER_SWEEP', 'SMS_REMINDER_SENT', 'SMS_REMINDER_RESENT');

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" VARCHAR(160) NOT NULL,
    "actorEmail" VARCHAR(255) NOT NULL,
    "action" "AdminAction" NOT NULL,
    "entityType" VARCHAR(40) NOT NULL,
    "entityId" VARCHAR(64) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "isHidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "moderatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sms_logs" ADD COLUMN     "errorCode" VARCHAR(60),
ADD COLUMN     "orderItemId" VARCHAR(64),
ADD COLUMN     "reason" VARCHAR(40),
ADD COLUMN     "providerMessageId" VARCHAR(120);

-- CreateIndex
CREATE INDEX "admin_audit_logs_actorId_createdAt_idx" ON "admin_audit_logs"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_entityType_entityId_createdAt_idx" ON "admin_audit_logs"("entityType", "entityId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_logs_action_createdAt_idx" ON "admin_audit_logs"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "reviews_isApproved_isHidden_idx" ON "reviews"("isApproved", "isHidden");

-- CreateIndex
CREATE INDEX "order_items_reminderSentAt_idx" ON "order_items"("reminderSentAt");

-- CreateIndex
CREATE INDEX "sms_logs_createdAt_idx" ON "sms_logs"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "sms_logs_status_idx" ON "sms_logs"("status");

-- AddForeignKey
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
