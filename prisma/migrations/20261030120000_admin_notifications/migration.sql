-- The admin notification inbox.
--
-- One table, `admin_notifications`, and one enum,
-- `AdminNotificationKind`.
--
-- ── Why this is a table and not a column on `orders` ──────────────────────
--
-- A notification is an **event**, not a state. The order row already
-- knows it is new — it was created a moment ago. What the admin needs
-- is a record that they have *not yet seen* it, and a history of what
-- they missed while they were on another page.
--
-- A `lastSeenOrderId` column on the admin's own row would answer the
-- badge question with one column, and it would be wrong for two
-- reasons:
--
--   1. There is no per-admin row. The shop has a small admin team
--      sharing one notification stream, and "the admin's own row"
--      would mean a per-admin table — a second thing to migrate,
--      a second thing to authorise against, and a second thing to
--      forget to join.
--
--   2. A watermark cannot express "unread". It can only say "newer
--      than this". The badge needs to know *which* notifications the
--      admin has already dismissed, because an admin who reads a
--      notification must be able to dismiss it without the badge
--      coming back on the next poll.
--
-- So the unread state lives on the notification itself: one row per
-- event, one boolean per row.
--
-- ── Why the fields are denormalised ───────────────────────────────────────
--
-- The bell shows "EGB-20261030-A1B2C3 — Ayesha Rahman — ৳2,400" for
-- each of the last twenty notifications. Reading that from the orders
-- table and the users table would be twenty joins on every poll.
--
-- Instead the order number, the customer's name, the total and the
-- payment method are **copied** onto the notification at the moment it
-- is created. That is what the audit log already does with the
-- actor's name and email, for the same reason: a notification that
-- has to join to survive its order is a notification that
-- disappears when the order is deleted — and the record that an order
-- once existed is exactly what an admin needs to keep.
--
-- The `entityId` is therefore a plain string and **not** a foreign
-- key. An `onDelete: Cascade` would delete the notification with the
-- order; an `onDelete: Restrict` would stop the order being deleted
-- at all. Neither is what a notification wants. The notification
-- outlives the order, and says so.
--
-- ── Why `read` is a boolean and not a `readAt` ────────────────────────────
--
-- The badge counts unread. That is the only question the column
-- answers, and a boolean answers it with the cheapest possible query.
--
-- A `readAt` timestamp would only be needed to answer "when did the
-- admin see this?" — and the audit log already answers that, better,
-- because it records *who* did it and why.
--
-- ── Why the index leads with `read` ──────────────────────────────────────
--
-- The hot query is "the newest notifications that are unread". That
-- is `WHERE read = false ORDER BY createdAt DESC`, and the
-- `(read, createdAt DESC)` index answers it without a sort.
--
-- The second index on `entityId` supports "every notification about
-- this order" — the question asked when an admin clicks through from
-- the bell to the order's page.

-- CreateEnum
CREATE TYPE "AdminNotificationKind" AS ENUM ('ORDER_PLACED', 'PAYMENT_SETTLED', 'PAYMENT_FAILED');

-- CreateTable
CREATE TABLE "admin_notifications" (
    "id" TEXT NOT NULL,
    "kind" "AdminNotificationKind" NOT NULL,
    "entityId" VARCHAR(64) NOT NULL,
    "orderNumber" VARCHAR(40) NOT NULL,
    "customerName" VARCHAR(160) NOT NULL,
    "totalAmountPaisa" INTEGER NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_notifications_read_createdAt_idx" ON "admin_notifications"("read", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "admin_notifications_entityId_idx" ON "admin_notifications"("entityId");
