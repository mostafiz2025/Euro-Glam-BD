-- Step 9 — Order reference number and subtotal.
--
-- Two changes to the `orders` table:
--
--   1. `orderNumber` — a human-readable reference ("EGB-20261027-A1B2C3")
--      that a customer can quote over the phone. It is @unique so it can
--      be looked up directly, but it is NOT the primary key: `id` remains
--      the identity.
--
--   2. `subtotalPaisa` — the sum of the line totals, before shipping.
--      `totalAmountPaisa` is what the customer pays (subtotal + shipping).
--      Without the subtotal, a receipt cannot show what the goods cost
--      versus what the delivery cost.
--
-- `orderNumber` is NOT NULL, and `subtotalPaisa` is NOT NULL, so existing
-- rows need a backfill before the constraint is applied. The backfill
-- derives a placeholder order number from the row's own id, which is
-- unique, and a zero subtotal.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "orderNumber" VARCHAR(40),
ADD COLUMN     "subtotalPaisa" INTEGER;

-- Backfill: a deterministic, unique placeholder for any pre-existing row.
-- `id` is the primary key, so prefixing it guarantees uniqueness even
-- when two rows would otherwise receive the same generated number.
UPDATE "orders" SET "orderNumber" = 'LEGACY-' || "id"
WHERE "orderNumber" IS NULL;

-- The subtotal is unknown for legacy rows. The total is known, and the
-- legacy shipping was 0, so the subtotal equals the total.
UPDATE "orders" SET "subtotalPaisa" = "totalAmountPaisa"
WHERE "subtotalPaisa" IS NULL;

-- Now make both columns required.
ALTER TABLE "orders" ALTER COLUMN "orderNumber" SET NOT NULL,
ALTER COLUMN "subtotalPaisa" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNumber_key" ON "orders"("orderNumber");

-- CreateIndex
CREATE INDEX "orders_paymentStatus_idx" ON "orders"("paymentStatus");
