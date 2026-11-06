-- The two things that make a one-time password mean something.
--
-- ── 1. The purpose ─────────────────────────────────────────────────────────
--
-- The shop mails a six-digit code for two different jobs:
--
--   • **SIGNUP** — proving that the person registering owns the inbox
--     they registered with. The account is created unverified and becomes
--     usable when the code comes back.
--
--   • **SIGNIN** — letting an existing customer sign in without a
--     password. The account's own password is not needed and is never
--     touched.
--
-- These are different credentials. A code issued for one must not work
-- for the other, and without a column to say which job a code was issued
-- for, one would work for both:
--
--   • An attacker who intercepted the verification mail of somebody who
--     was registering would hold a **valid sign-in code** for that
--     account, and could use it to get in later.
--
--   • A customer who asked for a sign-in code could spend it proving an
--     account is theirs instead — and the account would then be marked
--     verified without the code's own purpose being honoured.
--
-- So the purpose is a column, and the verification lookup filters on it.
--
-- ── Why the enum, and not a string ─────────────────────────────────────────
--
-- The two purposes are a closed set. A free-text column would let a typo
-- — "SignUp", "signup" — create a row that no verification query ever
-- looks for, and the code would be silently unusable. The database
-- refuses the value instead.
--
-- ── Why the default is SIGNIN, and why the column is NOT NULL ─────────────
--
-- Every row that already exists was issued by the sign-in flow — that is
-- the only flow that existed before this migration — so `SIGNIN` is the
-- truthful backfill for all of them.
--
-- The column is NOT NULL because a code with no purpose is a credential
-- that works for everything. The one case the database rejects is
-- exactly the case that must never exist.
--
-- ── The backfill is not a guess ────────────────────────────────────────────
--
-- `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` rewrites the table
-- on PostgreSQL 11+. Every row in this table is a credential with a
-- ten-minute lifetime, so the table is empty or near-empty in practice
-- and the rewrite is not worth optimising around. The alternative —
-- adding a nullable column, backfilling, then setting NOT NULL — buys
-- nothing here and costs a second migration for the same end state.

CREATE TYPE "OtpPurpose" AS ENUM ('SIGNUP', 'SIGNIN');

ALTER TABLE "email_otps"
    ADD COLUMN "purpose" "OtpPurpose" NOT NULL DEFAULT 'SIGNIN';

-- ── 2. The verification timestamp on the account ──────────────────────────
--
-- `emailVerifiedAt` is null until the customer proves they own the inbox.
--
-- It is a timestamp rather than a boolean because a boolean cannot tell
-- "we never asked" from "they said no", and the shop **requires** the
-- answer. A new account is created unverified; the customer is mailed a
-- code; the account becomes usable when the code comes back.
--
-- That is what stops an address registered by somebody else — a typo, or
-- an address harvested from a forum — from receiving the customer's order
-- confirmations and SMS alerts.
--
-- The column is nullable, and null is a real state rather than a
-- placeholder: it means "this account has not been verified yet".

ALTER TABLE "users"
    ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- ── The index that the lookup actually uses ───────────────────────────────
--
-- The verification step asks for "the live code for this address, for
-- this purpose". That is a two-column predicate, so the index is on two
-- columns — the old single-column index on `email` cannot serve it.
--
-- The old index is dropped rather than kept: every query that used it
-- now filters on the pair, and leaving a redundant index behind only
-- costs write throughput.

DROP INDEX "email_otps_email_idx";

CREATE INDEX "email_otps_email_purpose_idx" ON "email_otps"("email", "purpose");
