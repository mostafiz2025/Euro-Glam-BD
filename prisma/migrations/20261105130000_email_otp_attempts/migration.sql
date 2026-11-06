-- The sign-in code request ledger.
--
-- ── Why this table exists ─────────────────────────────────────────────────
--
-- The resend cooldown cannot be counted on the `email_otps` table.
--
-- The obvious place for it is the OTP row itself: "when was the last code
-- sent to this address?" — and that is exactly what the row knows. But
-- an address that has **no account** never gets an OTP row, because there
-- is nothing to sign in to.
--
-- And that address is precisely the one an attacker would probe. A
-- cooldown that only applies to real customers is not a cooldown at all —
-- it is a limit that excludes exactly the traffic it exists to stop. The
-- enumeration oracle would be wide open: probe a thousand addresses as
-- fast as the network allows, and the ones that answer 404 are the ones
-- with no customers, while the ones that answer 429 are the ones that do.
--
-- So the *attempts* are recorded here, separately, and every request
-- writes a row whether or not it produced a code. The cooldown is then a
-- question about this table, and it answers identically for an address
-- with an account and one without.
--
-- ── What this table deliberately does not hold ───────────────────────────
--
-- It holds the address and the time. It does **not** hold whether the
-- address had an account, and it does not hold whether a code was sent.
--
-- A table that recorded the outcome would be a table that says which
-- addresses belong to customers — which is the very thing the endpoint
-- must not reveal, and which a dump of this database would then hand
-- over wholesale.
--
-- ── Why the address is stored at all ─────────────────────────────────────
--
-- The cooldown is per address, so the limit has to be counted per
-- address. The address is not a secret — it is the thing the customer
-- typed — and the table is pruned aggressively.

CREATE TABLE "email_otp_attempts" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_otp_attempts_pkey" PRIMARY KEY ("id")
);

-- The cooldown is counted per address, so this lookup must be indexed.
CREATE INDEX "email_otp_attempts_email_idx" ON "email_otp_attempts"("email");

-- The sweep that deletes old attempts walks this column.
CREATE INDEX "email_otp_attempts_createdAt_idx" ON "email_otp_attempts"("createdAt");
