-- Step 17 — Dynamic discovery: category, concern and brand imagery.
--
-- Four changes:
--
--   1. The `image` column on `categories`.
--
--   2. The `skin_concerns` table. The concerns used to live in a static
--      array in `src/lib/format/taxonomy.ts`, which meant an admin could
--      not add one, edit one, or give one a picture. The storefront's
--      "Shop By Concern" section is a discovery surface, so its entries
--      are content — and content belongs where an admin can manage it.
--
--   3. The `brands` table. The same argument applies to brands, with one
--      important caveat: **this does not change `Product.brand`.**
--
--      Step 16 deliberately made `Product.brand` a plain nullable string
--      rather than a foreign key, because a `Brand` table would mean a
--      join on every product read and a migration rewriting every seeded
--      row. That decision stands. This table holds the *presentation*
--      data — the logo, the monogram, the display name, the ordering —
--      and the product still stores the brand **name** it was given.
--
--   4. `AdminAction` gains nine values. Every mutating admin action in
--      this codebase is audited, and these would be the first that were
--      not. An audit action that no service can write is an action that
--      looks supported but silently never happens.
--
-- ── The backfill ─────────────────────────────────────────────────────────
--
-- The two new tables are seeded from the static vocabularies they
-- replace, so the concerns and brands that are already in the code do not
-- vanish when those arrays are retired.
--
-- The `id`s are **fixed strings**, not generated ones. That is what makes
-- the backfill idempotent: re-running it updates the same rows rather
-- than inserting a second copy of every concern.
--
-- The monograms are written out rather than computed. "La Roche-Posay" →
-- "LR" is a house convention, not a derivation, and a derivation would
-- produce "LR" only by luck.
--
-- `Category.image` gets **no** backfill. There are no category images
-- today, and a migration that guessed which file an icon should come
-- from would be inventing data. The column is added empty and the admin
-- uploads real images.

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "image" VARCHAR(255);

-- AlterEnum
ALTER TYPE "AdminAction" ADD VALUE 'CATEGORY_CREATED';
ALTER TYPE "AdminAction" ADD VALUE 'CATEGORY_UPDATED';
ALTER TYPE "AdminAction" ADD VALUE 'CATEGORY_DELETED';
ALTER TYPE "AdminAction" ADD VALUE 'CONCERN_CREATED';
ALTER TYPE "AdminAction" ADD VALUE 'CONCERN_UPDATED';
ALTER TYPE "AdminAction" ADD VALUE 'CONCERN_DELETED';
ALTER TYPE "AdminAction" ADD VALUE 'BRAND_CREATED';
ALTER TYPE "AdminAction" ADD VALUE 'BRAND_UPDATED';
ALTER TYPE "AdminAction" ADD VALUE 'BRAND_DELETED';

-- CreateTable
CREATE TABLE "skin_concerns" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "tag" VARCHAR(60) NOT NULL,
    "relatedTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image" VARCHAR(255),
    "description" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skin_concerns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brands" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "monogram" VARCHAR(4) NOT NULL,
    "logo" VARCHAR(255),
    "description" VARCHAR(200),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "skin_concerns_slug_key" ON "skin_concerns"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "brands_name_key" ON "brands"("name");

-- CreateIndex
CREATE UNIQUE INDEX "brands_slug_key" ON "brands"("slug");

-- The backfill — the concerns that were in the static array.
--
-- The `id`s are fixed so a re-run updates rather than duplicates.
INSERT INTO "skin_concerns" ("id", "name", "slug", "tag", "relatedTags", "createdAt", "updatedAt")
VALUES
    ('concern_acne',        'Acne',          'acne',          'BHA',            ARRAY['BHA','SALICYLIC_ACID','BENZOYL_PEROXIDE','NIACINAMIDE'], NOW(), NOW()),
    ('concern_dullness',    'Dullness',      'dullness',      'VITAMIN_C',      ARRAY['VITAMIN_C','ASCORBYL_GLUCOSIDE','NIACINAMIDE'], NOW(), NOW()),
    ('concern_fine_lines',  'Fine Lines',    'fine-lines',    'RETINOL',        ARRAY['RETINOL','RETINAL','RETINYL_PALMITATE','VITAMIN_C'], NOW(), NOW()),
    ('concern_dryness',     'Dryness',       'dryness',       'HYALURONIC_ACID', ARRAY['HYALURONIC_ACID','GLYCERIN','PANTHENOL','CERAMIDES'], NOW(), NOW()),
    ('concern_sensitivity', 'Sensitivity',   'sensitivity',   'PANTHENOL',      ARRAY['PANTHENOL','CENTELLA','CERAMIDES','OAT_EXTRACT'], NOW(), NOW()),
    ('concern_texture',     'Texture',       'texture',       'AHA',            ARRAY['AHA','GLYCOLIC_ACID','LACTIC_ACID','MANDELIC_ACID'], NOW(), NOW()),
    ('concern_oil_control', 'Oil Control',   'oil-control',   'NIACINAMIDE',    ARRAY['NIACINAMIDE','BHA','SULFUR'], NOW(), NOW()),
    ('concern_protection',  'Sun Protection','protection',    'SPF',            ARRAY['SPF','VITAMIN_E','VITAMIN_C'], NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- The backfill — the brands that were in the static registry.
--
-- The monograms are the house convention, written out. `sortOrder`
-- follows the order the brands appear in `KNOWN_BRANDS`, so the
-- storefront's order is stable and does not depend on an alphabetical
-- sort of the name.
INSERT INTO "brands" ("id", "name", "slug", "monogram", "sortOrder", "createdAt", "updatedAt")
VALUES
    ('brand_bioderma',         'Bioderma',       'bioderma',         'BD', 10, NOW(), NOW()),
    ('brand_cerave',           'CeraVe',         'cerave',           'CV', 20, NOW(), NOW()),
    ('brand_la_roche_posay',   'La Roche-Posay', 'la-roche-posay',   'LR', 30, NOW(), NOW()),
    ('brand_maybelline',       'Maybelline',     'maybelline',       'MB', 40, NOW(), NOW()),
    ('brand_musta_baby',       'Musta Baby',     'musta-baby',       'MB', 50, NOW(), NOW()),
    ('brand_musta_makeup',     'Musta Makeup',   'musta-makeup',     'MM', 60, NOW(), NOW()),
    ('brand_neutrogena',       'Neutrogena',     'neutrogena',       'NG', 70, NOW(), NOW()),
    ('brand_the_ordinary',     'The Ordinary',   'the-ordinary',     'TO', 80, NOW(), NOW()),
    ('brand_vichy',            'Vichy',          'vichy',            'VY', 90, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;
