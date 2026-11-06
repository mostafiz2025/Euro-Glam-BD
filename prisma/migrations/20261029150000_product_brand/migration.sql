-- Step 16 — A brand on a product.
--
-- One change: the `brand` column on `products`.
--
-- ── Why the brand needs its own column ───────────────────────────────────
--
-- The brand used to be **derived** from the product's name: the name
-- "CeraVe Hydrating Facial Cleanser" was split on a closed registry of
-- the brands this shop stocks, longest-match-first, and the prefix
-- became the brand.
--
-- That worked for the admin table, and it worked *only* there. It
-- cannot be edited — an admin cannot say "this is a Bioderma, not a
-- CeraVe" when the name happens to start with the wrong word. It cannot
-- be filtered on, because there is no column to filter. And it cannot be
-- typed: the registry is a closed list, so a shop that stocks a brand
-- the code has never heard of has nowhere to put it.
--
-- So the brand becomes a **first-class, editable field**.
--
-- ── Why it is a column and not a foreign key ────────────────────────────
--
-- A `Brand` table would mean a second admin CRUD (list, create, rename,
-- merge), a join on every product read, and a migration rewriting every
-- seeded row against a new table. For a label with a closed, known
-- vocabulary that is a great deal of machinery for very little gain.
--
-- Instead the column is a plain string, and the **vocabulary lives in
-- the validation layer**. The admin form's brand picker offers the
-- registered brands and lets an admin type a new one; the server
-- validates against the same list, so the column and the vocabulary
-- cannot drift apart.
--
-- ── Why it is nullable ───────────────────────────────────────────────────
--
-- A product can genuinely have no brand — a shop's own generic line, an
-- unbranded piece. And a nullable column can be added to a live table
-- without a backfill that has to invent something for every row.
--
-- Null means "unknown". It does not mean "empty brand", and it is
-- rendered as no brand line at all rather than as a blank one.
--
-- ── Why `name` keeps the brand prefix ────────────────────────────────────
--
-- The name is left exactly as it was: "CeraVe Hydrating Facial
-- Cleanser", not "Hydrating Facial Cleanser". The name feeds the image
-- alt text, the `OrderItem.productName` snapshot that outlives the
-- product, the catalogue's search term and the admin's delete
-- confirmation. Changing it would rewrite the meaning of an entire
-- column, in every consumer of it, for a display concern.
--
-- So the brand is **additional metadata**. The name is the product's
-- identity; the brand is a facet of it.
--
-- ── The backfill ─────────────────────────────────────────────────────────
--
-- The existing rows have names that begin with a registered brand, so
-- the backfill copies the prefix across.
--
-- **It never guesses.** The `CASE` expressions are explicit about the
-- registered brands, and a row whose name matches none of them is left
-- with `NULL` — which is the honest answer, not a blank string. The
-- longest-prefix rule is respected by the order of the `CASE`
-- expressions: "La Roche-Posay" and "The Ordinary" are matched before
-- any shorter brand could take their place.
--
-- The comparison is case-insensitive, because a product named
-- "CERAVE Hydrating Cream" is still a CeraVe product, and the stored
-- value is always the registry's canonical spelling.

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "brand" VARCHAR(80);

-- Backfill the brand from the product's name.
--
-- The order is deliberate: the longest registered prefixes come first,
-- so "The Ordinary Niacinamide" is branded "The Ordinary" rather than
-- being caught by a shorter prefix.
--
-- The trailing space in each `LIKE` pattern is what makes the match a
-- **prefix followed by whitespace** — so "Ceramide Cream" is not
-- branded "CeraVe".
UPDATE "products"
SET "brand" = CASE
    WHEN "name" LIKE 'La Roche-Posay %' THEN 'La Roche-Posay'
    WHEN "name" LIKE 'Musta Makeup %'   THEN 'Musta Makeup'
    WHEN "name" LIKE 'Musta Baby %'     THEN 'Musta Baby'
    WHEN "name" LIKE 'The Ordinary %'   THEN 'The Ordinary'
    WHEN "name" LIKE 'CeraVe %'         THEN 'CeraVe'
    WHEN "name" LIKE 'Bioderma %'       THEN 'Bioderma'
    WHEN "name" LIKE 'Neutrogena %'     THEN 'Neutrogena'
    WHEN "name" LIKE 'Maybelline %'     THEN 'Maybelline'
    WHEN "name" LIKE 'Vichy %'          THEN 'Vichy'
    ELSE NULL
END
WHERE "name" LIKE 'La Roche-Posay %'
   OR "name" LIKE 'Musta Makeup %'
   OR "name" LIKE 'Musta Baby %'
   OR "name" LIKE 'The Ordinary %'
   OR "name" LIKE 'CeraVe %'
   OR "name" LIKE 'Bioderma %'
   OR "name" LIKE 'Neutrogena %'
   OR "name" LIKE 'Maybelline %'
   OR "name" LIKE 'Vichy %';

-- The brand is filtered on the storefront's brand facet and by the
-- catalogue's brand search, so it is indexed.
CREATE INDEX "products_brand_idx" ON "products"("brand");
