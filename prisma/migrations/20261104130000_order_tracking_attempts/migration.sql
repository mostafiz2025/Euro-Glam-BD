-- The guest order-tracking attempt ledger.
--
-- ── Why this table exists ─────────────────────────────────────────────────
--
-- The storefront gained a **public** order-tracking page: a customer who
-- has no account can ask "where is my parcel?" and get an answer. The
-- endpoint behind it is reachable by anyone, signed in or not.
--
-- The protection is the **contact detail** the customer supplies — the
-- email address or the phone number on the order. An order number alone
-- is not enough to answer the question, because an order number is
-- printed on a parcel, quoted over the phone and pasted into a chat
-- window. So the customer must also prove something the attacker does
-- not know.
--
-- That secret is a good protection. But it is not a *rate* limit, and
-- "hard to guess" is not the same as "expensive to guess". A script can
-- try a hundred candidate numbers against one known order number, or a
-- hundred contact details against one known order number, and every one
-- of those attempts costs the attacker nothing.
--
-- So the endpoint counts its attempts, and this table is where the count
-- comes from.
--
-- ── Why the count is in the database, not in memory ───────────────────────
--
-- A process-local counter is reset on every restart and is not shared
-- between instances — which is exactly when a cap is needed. The
-- advisor's hourly message limit is counted the same way, for the same
-- reason.
--
-- ── Why the row holds the order number and nothing else ──────────────────
--
-- The order number is not a secret. What the row must **not** hold is
-- the contact detail — that is the secret, and a table of customer
-- emails and phone numbers is a liability rather than a feature.
--
-- So the row records the number that was looked up, whether the attempt
-- matched, and when. Nothing that would identify a person.

CREATE TABLE "order_tracking_attempts" (
    "id" TEXT NOT NULL,
    "orderNumber" VARCHAR(40) NOT NULL,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_tracking_attempts_pkey" PRIMARY KEY ("id")
);

-- The limit query is "how many failures for this order number since an
-- hour ago", so the two columns are indexed together.
CREATE INDEX "order_tracking_attempts_orderNumber_createdAt_idx"
    ON "order_tracking_attempts"("orderNumber", "createdAt");

-- The rows are pruned by age, so the age is worth its own index.
CREATE INDEX "order_tracking_attempts_createdAt_idx"
    ON "order_tracking_attempts"("createdAt");
