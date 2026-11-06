-- Step 12 — Enterprise admin console: archiving, traffic collection, and
-- the audit actions the new surfaces need.
--
-- Four changes:
--
--   1. `Product.archivedAt`. Archiving is the default "delete" for a
--      product, and it exists because a hard delete is usually
--      impossible: `OrderItem.productId` is `onDelete: Restrict`, and
--      the order line snapshots the product's name and price precisely
--      so that history survives. A product that has ever been ordered
--      cannot be removed from the database without destroying the
--      record of that sale.
--
--      The column is nullable and defaults to null — "on sale" — so the
--      default is the safe one: a product nobody has thought about is
--      visible.
--
--   2. `AdminAction` gains `PRODUCT_CREATED`, `PRODUCT_UPDATED`,
--      `PRODUCT_DELETED` and `AI_CONFIG_UPDATED`. Every mutating admin
--      action in this codebase is audited, and these are the first
--      actions that would not have been. An audit action that no
--      service can write is an action that looks supported but silently
--      never happens.
--
--   3. The `TrafficEvent` table. There was no traffic data anywhere in
--      the system — no page-view table, no referrer column, no UTM
--      capture — so a traffic breakdown could only have been built by
--      inventing the numbers. This table makes the data real.
--
--      Privacy: the table records a bucketed channel, a referrer *host*,
--      a landing path and a pseudonymous first-party visitor id. It
--      records no IP address, no user agent, no raw referrer URL and no
--      cross-site identifier.
--
--   4. An index on `products(archivedAt)`. Every storefront query
--      filters on it, so it is on the hot path.
--
-- There is no backfill: `archivedAt` is nullable with a null default,
-- `TrafficEvent` is new, and the enum values are additive.

-- AlterEnum
ALTER TYPE "AdminAction" ADD VALUE 'PRODUCT_CREATED';
ALTER TYPE "AdminAction" ADD VALUE 'PRODUCT_UPDATED';
ALTER TYPE "AdminAction" ADD VALUE 'PRODUCT_DELETED';
ALTER TYPE "AdminAction" ADD VALUE 'AI_CONFIG_UPDATED';

-- AlterTable
ALTER TABLE "products" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "products_archivedAt_idx" ON "products"("archivedAt");

-- CreateTable
CREATE TABLE "traffic_events" (
    "id" TEXT NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "referrerHost" VARCHAR(255),
    "path" VARCHAR(255) NOT NULL,
    "visitorId" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "traffic_events_createdAt_idx" ON "traffic_events"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "traffic_events_source_createdAt_idx" ON "traffic_events"("source", "createdAt" DESC);
