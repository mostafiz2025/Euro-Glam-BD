-- The shop's marquee colours and its contact details.
--
-- ── Why this migration exists ─────────────────────────────────────────────
--
-- Two additions to the single-row `site_settings` table, both of them
-- moving something that was **hard-coded** into the database:
--
--   1. The marquee's **colours**. The bar was `bg-neutral-900` with
--      `text-white`, chosen in the component and unchangeable. An
--      announcement is a campaign surface — a launch wants rose, a
--      quiet week wants ink — and a campaign that cannot change colour
--      is a campaign that has already been designed for the shop
--      rather than by the shop.
--
--   2. The footer's **contact details**. The footer said
--      "hello@euroglam.bd" and "Mon–Sat, 9am–8pm" because those two
--      strings were in the component. A shop whose support address
--      changes — a new mailbox, a new counter, new opening hours —
--      had to wait for a deploy to say so.
--
-- ── Why the colours are hex triplets and not token names ──────────────────
--
-- A token name (`marquee-ink`) would constrain the shop to the colours
-- the design system already had, and would mean adding a token to
-- `globals.css` for every colour anyone ever wanted. The bar's ground
-- is a *per-announcement* choice, so it is stored as the value itself:
-- a six-digit hex triplet, in the form a colour picker hands back.
--
-- The two colours are stored **independently** rather than as a
-- "theme" name, because the pair is the shop's to choose and the
-- legibility of the pair is the validation layer's job — a bar whose
-- ground and type are too close in lightness is a bar nobody can read.
--
-- The defaults are the colours the bar already had, so a fresh row
-- looks exactly like the bar the shop is used to.

ALTER TABLE "site_settings"
    ADD COLUMN "marqueeBgColor" VARCHAR(7) NOT NULL DEFAULT '#1c1917',
    ADD COLUMN "marqueeTextColor" VARCHAR(7) NOT NULL DEFAULT '#ffffff';

-- ── The contact details ───────────────────────────────────────────────────
--
-- The footer reads these instead of the strings it used to carry.
--
-- All four default to the **empty string** rather than to a plausible
-- placeholder. An empty string means "the shop has not told us this",
-- and the footer then renders the line it can support — a shop with no
-- store address shows no address, which is honest, rather than one
-- showing "123 Example Road", which is a lie the customer might try to
-- visit.
--
-- The phone is a **display** string rather than a dialable one: the
-- footer shows it the way the shop writes it ("01819-000000"), and the
-- `tel:` link is built from the digits alone.
ALTER TABLE "site_settings"
    ADD COLUMN "supportEmail" VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN "supportPhone" VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN "supportHours" VARCHAR(120) NOT NULL DEFAULT '',
    ADD COLUMN "storeAddress" VARCHAR(400) NOT NULL DEFAULT '';
