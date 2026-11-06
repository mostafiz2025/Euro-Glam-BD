-- Step 11 — Admin dashboard: the product stock audit action.
--
-- One change:
--
--   1. `AdminAction` gains `PRODUCT_STOCK_ADJUSTED`. An admin changing
--      a product's stock by hand is a privileged action, and the audit
--      log is where the answer to "who set this to zero, and why?"
--      lives. Without an enum value there is no way to record it.
--
-- There is no backfill: the enum value is new, and no existing row
-- refers to it.

-- AlterEnum
ALTER TYPE "AdminAction" ADD VALUE 'PRODUCT_STOCK_ADJUSTED';
