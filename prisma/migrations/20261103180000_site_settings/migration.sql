-- The shop's site settings.
--
-- ── Why this table exists ──────────────────────────────────────────────────
--
-- The homepage carousel was the shop's only editable surface: an admin
-- could change what the hero said, but nothing about the rest of the
-- storefront's chrome.
--
-- The announcement marquee is the next one. It is a line of marketing
-- copy that sits above the header on every page, so it is a
-- **commercial surface** — what the shop says first, to every visitor,
-- on every visit — and it needs an admin switch and an audit trail in
-- the same way the hero banner does.
--
-- ── Why a single-row table rather than more columns ────────────────────────
--
-- The same reasoning as `ai_configs`: a table with one row, guarded to
-- one row by the service layer, whose `key` is always "default".
--
-- It is a **separate model** rather than more columns on `ai_configs`
-- because the two answer different questions and have different
-- lifecycles. `ai_configs` is the advisor's *compliance and behaviour*
-- configuration — compliance text, versioned, written on a schedule.
-- `site_settings` is the shop's *presentation* configuration — what the
-- storefront says, and whether it says it.
--
-- ── The switch, not a value ────────────────────────────────────────────────
--
-- `isMarqueeEnabled` is a boolean rather than a status string because
-- the marquee is either on the page or it is not. There is no
-- in-between, and no "on but empty" — an empty marquee is a strip of
-- coloured nothing, which is why the admin route refuses to save empty
-- text while the switch is on.
--
-- ── Why the text is kept while the switch is off ───────────────────────────
--
-- Turning the marquee off is a **pause**, not a deletion. An admin who
-- switches it off for a campaign and switches it back on expects their
-- message to come back, so the text is preserved rather than cleared.
--
-- ── Why `marqueeHref` is a closed path ────────────────────────────────────
--
-- The same rule the hero banner's calls to action follow. The href is
-- rendered into an `href` attribute, and an announcement that could
-- point at `javascript:…`, at another host, or at a `data:` URI would
-- be a way to take the storefront over from the shop that owns it. It
-- may be a path within the storefront, or nothing.

CREATE TABLE "site_settings" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "isMarqueeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "marqueeText" VARCHAR(240) NOT NULL DEFAULT '',
    "marqueeHref" VARCHAR(255),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- ── The new audit action ───────────────────────────────────────────────────
--
-- The marquee is a commercial surface, so switching it on or off is
-- recorded in the audit log alongside the change itself.
--
-- PostgreSQL 12+ allows new enum values to be added inside a
-- transaction, and the value is only visible to *other* sessions after
-- the transaction commits. The Prisma client reads the enum out of the
-- catalogue at query time, so a value added here is usable by the next
-- query the client makes.
ALTER TYPE "AdminAction" ADD VALUE 'SITE_SETTINGS_UPDATED';

-- ── The single row ─────────────────────────────────────────────────────────
--
-- The table is guarded to one row by the service layer, and the unique
-- index is what enforces that. The `key` is the natural name for it.
CREATE UNIQUE INDEX "site_settings_key_key" ON "site_settings"("key");
