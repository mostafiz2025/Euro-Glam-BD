-- The payment attempts made against a gateway order.
--
-- One table, `payment_attempts`, and one enum, `PaymentAttemptOutcome`.
--
-- ── Why this is a table and not a column on `orders` ───────────────────────
--
-- An order can be attempted many times: the customer opens the sandbox
-- window, the payment fails, they try again. The *current* state of the
-- payment is one value — it lives on `orders.paymentStatus`. The *history*
-- of the attempts is many rows, and a row of history does not fit in a
-- column.
--
-- ── Why the payment status does not become FAILED ──────────────────────────
--
-- The tempting design is to write `FAILED` on the order when a payment
-- attempt fails, and let the customer retry from `FAILED`. That contradicts
-- two existing rules:
--
--   1. `PAYMENT_STATUS_TRANSITIONS` treats `FAILED` as terminal
--      (src/lib/admin/orders.ts). Retrying from `FAILED` would need a
--      `FAILED -> PENDING` path that exists nowhere else, and a special
--      case in a closed table is a bug factory.
--
--   2. Restoring the reserved stock on failure and then letting the
--      customer retry the SAME order would oversell. The restoration in
--      `changeOrderStatus` is guarded by the order's status transition —
--      there is no separate "already restored" flag — so a
--      failure-then-retry sequence either restores the stock twice or
--      restores it and retries without re-reserving it.
--
-- So a failed attempt leaves `orders.paymentStatus` at PENDING and leaves
-- the reservation intact. The order is still live; the money is still
-- unresolved; the customer retries with one click. The failure is recorded
-- here, as an attempt, which is what it actually is.
--
-- ── Why this is not the admin audit log ────────────────────────────────────
--
-- `AdminAuditLog` is the *staff* trail. This is the *customer-visible*
-- history of their own attempts, and it needs its own rows. The audit log
-- records that a gateway event happened; this table records what the
-- gateway said.
--
-- ── Why the FK is RESTRICT ────────────────────────────────────────────────
--
-- The attempts are the evidence that an order was paid for. Deleting them
-- would destroy that evidence while the order itself survives, so the
-- database refuses. An attempt is deleted only when its order is.

-- CreateEnum
CREATE TYPE "PaymentAttemptOutcome" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "outcome" "PaymentAttemptOutcome" NOT NULL,
    "sessionId" VARCHAR(64),
    "failureMessage" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_attempts_orderId_idx" ON "payment_attempts"("orderId");

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
