-- The homepage hero banners.
--
-- The hero carousel used to be a hard-coded array in
-- `src/components/home/hero-slides.ts`: four slides decided in code and
-- shipped with the code. This table moves them into the database, where
-- the admin panel can create, edit and retire them.
--
-- ── Why the banner is a row and not a pointer ────────────────────────────
--
-- A hero slide is an *editorial* unit — an eyebrow, a headline, a body,
-- two calls to action and a set of trust points. It is not a product. So
-- the copy lives here, and only the artwork is a stored file: `image`
-- holds a storage adapter key, never a raw URL.

-- ── The new audit actions ────────────────────────────────────────────────
--
-- The hero is a **commercial surface**: what the shop says first, to
-- every customer, on every visit. "Who changed the headline on the home
-- page, and from what to what" is exactly the question an audit trail
-- exists to answer.
--
-- PostgreSQL 12+ allows new enum values to be added inside a
-- transaction, and the value is only visible to *other* sessions after the
-- transaction commits. The Prisma client reads the enum out of the
-- catalogue at query time, so a value added here is usable by the next
-- query the client makes.
ALTER TYPE "AdminAction" ADD VALUE 'HERO_BANNER_CREATED';
ALTER TYPE "AdminAction" ADD VALUE 'HERO_BANNER_UPDATED';
ALTER TYPE "AdminAction" ADD VALUE 'HERO_BANNER_DELETED';

-- ── The banners table ────────────────────────────────────────────────────
--
-- `trust` is a plain text array: a trust point is a phrase, not an
-- entity, so there is nothing to join to. `isActive` switches a banner
-- off without deleting it, because the audit trail needs the row to still
-- be there to describe what happened to it.
CREATE TABLE "hero_banners" (
    "id" TEXT NOT NULL,
    "eyebrow" VARCHAR(80) NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(400) NOT NULL,
    "ctaLabel" VARCHAR(60) NOT NULL,
    "ctaHref" VARCHAR(255) NOT NULL,
    "secondaryCtaLabel" VARCHAR(60) NOT NULL,
    "secondaryCtaHref" VARCHAR(255) NOT NULL,
    "trust" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image" VARCHAR(255),
    "gradient" VARCHAR(255) NOT NULL DEFAULT 'bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]',
    "glow" VARCHAR(120) NOT NULL DEFAULT 'bg-brand-400/45',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hero_banners_pkey" PRIMARY KEY ("id")
);
