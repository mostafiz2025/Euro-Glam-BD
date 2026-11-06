-- Step 14 — Promotional badges on a product.
--
-- One change: the `badges` column on `products`.
--
-- A product used to carry two hardcoded booleans — `isNewArrival` and
-- `isBestSeller`. Two checkboxes answer two questions, and a shop that
-- wants a "Limited Edition" badge or a seasonal campaign badge has
-- nowhere to put it except the product description, where it is
-- invisible to the catalogue and impossible to filter by.
--
-- So a product now carries a **list** of badges: any of the closed set
-- of known badges, plus free-text custom tags for the one-off campaign
-- that a closed set cannot anticipate.
--
-- The list is the single source of truth. `isNewArrival` and
-- `isBestSeller` remain in the schema because the storefront reads
-- them, but they are a *mirror* of two entries in the list — the admin
-- catalogue service maintains them on every write, so there is still
-- exactly one place an admin actually edits.
--
-- ── The backfill ─────────────────────────────────────────────────────────
--
-- The existing rows already carry the two boolean flags, and some of
-- them are set. Leaving the badge list empty for those products would
-- make the two disagree: the storefront would render "New" while the
-- admin's badge editor showed nothing checked, and the first admin to
-- save that product would silently clear the flag.
--
-- So the list is **backfilled from the booleans**. The order is
-- deliberate — "Best Seller" first, then "New Arrival" — because the
-- badge editor renders the list in the order it stores it, and the
-- storefront's "Best Seller" badge is the darker one. The order is
-- cosmetic; the membership is what matters.
--
-- A scalar list cannot carry a `@@index` in PostgreSQL, so the column
-- is deliberately not indexed. The catalogue filters on the two
-- booleans, which are.

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "badges" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill the badge list from the two boolean flags that already exist.
--
-- `ARRAY_REMOVE(..., NULL)` drops the element a false flag produces —
-- a CASE with no ELSE yields NULL, and NULL is not a valid badge.
UPDATE "products"
SET "badges" = ARRAY_REMOVE(
    ARRAY[
        CASE WHEN "isBestSeller" THEN 'Best Seller' END,
        CASE WHEN "isNewArrival" THEN 'New Arrival' END
    ],
    NULL
)
WHERE "isBestSeller" = true OR "isNewArrival" = true;
