-- The email sign-in one-time password ledger.
--
-- ── Why this table exists ─────────────────────────────────────────────────
--
-- The storefront can sign a customer in with a code mailed to them
-- instead of a password they would have to remember and store.
--
-- The code is the **only** thing standing between "know this person's
-- email address" and "be signed in as this person". An email address is
-- not a secret — it is printed on every order confirmation and typed
-- into half the forms on the internet — so the proof has to be
-- something the server issues and the attacker cannot predict.
--
-- This table is where that issued proof lives between the moment it is
-- mailed and the moment it is used.
--
-- ── Why the code is hashed ────────────────────────────────────────────────
--
-- A row in this table is a live credential for as long as it has not
-- expired. It sits in the same database as customer addresses, orders
-- and reviews, and a dump of it is a list of credentials that work. If
-- the six digits were stored in the clear, that dump would be directly
-- replayable, and a single leaked backup would be a credential leak
-- rather than an inconvenience.
--
-- So the code is stored as a SHA-256 hash, salted with the row's own
-- id. The salt matters: without it, two customers issued the same six
-- digits would have identical stored values, and the table would double
-- as a precomputed lookup of "which account does 123456 belong to?".
--
-- SHA-256 rather than a password hash is deliberate and correct here,
-- unlike for a password. The code has six digits and ten minutes of
-- life, so there is no secret worth slowing down: the search space is
-- a million values and the salt defeats the rainbow table. A slow
-- hash would cost the server time on every verification without making
-- the code any harder to steal from the database.
--
-- ── Why the row is deleted on use ─────────────────────────────────────────
--
-- A verified OTP is worthless. Leaving it behind — even flagged as
-- consumed — keeps a replayable hash in the table for as long as the
-- row survives, and gives an attacker one more thing to take. The row
-- goes when the code is used.
--
-- ── Why `expiresAt` is an absolute instant ───────────────────────────────
--
-- The deadline is a property of the record, not of the request. Storing
-- the instant means it survives a restart and means "is this still
-- live?" does not have to reconstruct a duration from a configuration
-- value that may since have changed.

CREATE TABLE "email_otps" (
    "id" TEXT NOT NULL,
    "userId" VARCHAR(64) NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_otps_pkey" PRIMARY KEY ("id")
);

-- The verification step looks up "the live code for this address", so
-- that lookup must be indexed.
CREATE INDEX "email_otps_email_idx" ON "email_otps"("email");

-- A customer's outstanding codes are listed when a new one is issued,
-- to invalidate the previous one.
CREATE INDEX "email_otps_userId_idx" ON "email_otps"("userId");

-- The sweep that deletes expired rows walks this column.
CREATE INDEX "email_otps_expiresAt_idx" ON "email_otps"("expiresAt");

-- The user is deleted with their account, and their outstanding codes go
-- with it — a code for an account that no longer exists is not a code
-- anyone should be able to redeem.
ALTER TABLE "email_otps"
    ADD CONSTRAINT "email_otps_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
