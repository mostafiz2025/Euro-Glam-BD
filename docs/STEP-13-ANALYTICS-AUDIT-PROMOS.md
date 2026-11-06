# Step 13 — Analytics Explorer, Audit Trail & Promo Management

## Context

Step 12 turned the admin surface into an enterprise console: a theme
layer, a collapsible shell, hand-rolled SVG charts, a real traffic
collector, product CRUD, and three new admin pages (Users, Settings,
Analytics).

Step 13 adds three things to it:

| # | Area | What landed |
|---|---|---|
| 1 | **The Analytics page** | Live metrics from `db.order` and `db.trafficEvent`, a revenue trend, a traffic-sources breakdown, and a nav link directly below Dashboard |
| 2 | **The Audit Logs page** | An explorer over the database's audit trail — every mutating admin action, filterable by action, entity type and free text |
| 3 | **The Promos panel** | Create, edit and deactivate discount codes, with the audit trail they deserve |

The 870-test baseline includes the new work. Nothing that shipped before
was weakened: the audit-vocabulary test was **extended** to cover the
three new `AdminAction` values, never loosened.

---

## 1. The Analytics page

`src/app/admin/analytics/page.tsx` — four metric tiles, a revenue
trend chart, and a traffic-sources breakdown.

### The metrics are live

The figures come from `db.order` and `db.trafficEvent` at request time:

| Tile | Query |
|---|---|
| **Net Revenue** | `db.order.aggregate` over non-cancelled orders |
| **Total Orders** | `db.order.count` |
| **Store Visits** | `db.trafficEvent.count` |
| **Conversion Rate** | orders ÷ visits |

### The conversion rate is `null` against a zero base

`computeConversionRate(orders, visits)` returns `null` when `visits` is
zero or negative. A percentage against a zero base is a division by zero
wearing a percentage's clothes, so the tile renders "—" rather than
`0%`. "Nobody visited, so nobody converted" and "no visits at all" are
different facts, and the panel says which one it is.

### The four figures fail together; the charts fail independently

The metric tiles load as one unit, so a failed query fails the whole
row — an admin never sees a metric card next to a missing neighbour
that looks like a deliberate omission. The charts load separately,
because a revenue series and a traffic breakdown fail for unrelated
reasons and one outage should not blank the other.

### The traffic sources are a collected fact

The buckets come from `TrafficEvent.source`, which the Step 12 collector
derives from the real referrer and UTM values against a closed taxonomy
(`facebook` | `organic` | `direct` | `email` | `other`).

Two things are deliberate:

- **No seeded data.** Before any traffic has been collected, the donut
  shows an explicit empty state. Never four invented slices.
- **The colour follows the taxonomy, not the rank.** Facebook keeps its
  colour when it drops from first to third, because a channel that
  changes colour when its rank changes is a chart that has to be
  re-learned every week.

`PaymentMethod` is **not** a traffic source. `COD | BKASH | NAGAD |
CARD` is how they paid, not where they came from — a "Facebook" slice
built from bKash orders would be a fabrication that looks entirely
plausible on a dashboard.

---

## 2. The Audit Logs page

`src/app/admin/audit-logs/page.tsx` — an explorer over
`AdminAuditLog`.

### The trail is a read

Every mutating admin action in this codebase writes its audit entry
**in the same transaction as the change**. The trail is already complete
and already correct, so this page only reads it.

There is deliberately **no "undo"**. An undo would be a second mutation,
and a second mutation needs its own audited entry — and the first one's
meaning would be lost.

### Three states, not two

| State | What it means | What it renders |
|---|---|---|
| **Loaded** | The entries are there | The trail |
| **Loaded and empty** | There genuinely is no activity | An empty state |
| **Failed** | The database was unreachable | An error panel |

A failed load never renders as an empty list. A trail that says "no
activity" because the database was unreachable is a trail that will
eventually be believed.

### The filters

- **Action** — a closed enum of the `AdminAction` values, labelled in
  prose ("Changed a product's stock", not `PRODUCT_STOCK_ADJUSTED`).
- **Entity type** — a closed enum of `AUDIT_ENTITY_TYPES`.
- **Search** — a plain GET form matching the actor's name, their email,
  the reason, or the entity id.

The **API** rejects an unrecognised filter with a 400. The **page**
ignores one, because a bad URL should not leave an admin staring at an
error page when the fix is to click a different link.

### Every filter link preserves the others

Each chip and each pagination link carries **all four** parameters. A
filter link that dropped the others would be a trap: an admin who
filtered by action and then clicked a different action would lose their
entity filter without being told.

### The diff

Each entry renders the fields that changed:

```
pricePaisa   ৳950  →  ৳1,200
percentOff   (not set)  →  20
```

The heuristic for money is the field's **name**, never the value: a
`usageCount` is not money, and both happen to be integers.

---

## 3. The Promos panel

`src/app/admin/promos/page.tsx`, plus two client components:
`CouponFormDialog` and `DeactivateCouponDialog`.

### The discount is two columns, one of them null

`percentOff` and `amountOffPaisa`. A single `value` column would make
"20" mean 20% in one row and ৳20 in another, and the reader would have
to know which. Two columns cannot be misread.

The form mirrors this: it shows **one** value input, whose unit follows
the discount type. A form with two inputs would let an admin fill in
both and have the server reject the combination — the server is right to
reject it, but the form should never produce a combination the server
will refuse.

### The status is derived, not stored

Only "switched off" is a stored column. "Expired" and "used up" are
facts about the **current time**, so storing them would mean a nightly
job updating rows that are already correct by derivation.

The status is computed on read, by `couponStatus` — the same function
the API uses, so the badge on the page and the decision at checkout
cannot disagree.

### A change to the terms needs a reason

A change to **what the coupon is worth** requires a mandatory reason.
It is a price reduction, and "percentOff 10 → 20" with no reason cannot
answer "why".

Switching a coupon **on or off** is a decision about whether to offer it,
not about what it is worth, so it does not need one — the same
distinction the product price change draws.

The rule lives in the **service**, not only in the request schema, so
every caller of the table gets it.

### A coupon is deactivated, never deleted

A coupon that has been redeemed has **history**. Deleting the row would
erase the record of the campaign, and the orders that used it would
point at a code that no longer exists. So the row stays, the audit entry
says it was deactivated, and the redemption count is preserved.

### The code is normalised

The service folds the code to uppercase, so "eid2026" and "EID2026"
cannot become two coupons. The unique constraint is the real guarantee;
the read inside the transaction turns the common case into a clear
message.

---

## 4. The API surface

| Route | Method | What it does |
|---|---|---|
| `/api/admin/analytics` | `GET` | The funnel metrics and the traffic breakdown |
| `/api/admin/audit-logs` | `GET` | The trail, filtered by action / entity / actor / search |
| `/api/admin/coupons` | `GET` | The coupon list with its counts |
| `/api/admin/coupons` | `POST` | Create a coupon |
| `/api/admin/coupons/[id]` | `GET` | One coupon |
| `/api/admin/coupons/[id]` | `PATCH` | A partial update |
| `/api/admin/coupons/[id]/deactivate` | `POST` | Deactivate, with a mandatory reason |

Every route is admin-only, calls `requireAdmin()` (the proxy is a fast
filter; the guard is the authority), and calls `await connection()`
**outside** the try block.

Every mutating route writes its audit entry **in the same transaction as
the change**.

---

## 5. The schema changes

```prisma
enum AdminAction {
  // … the existing fourteen …
  COUPON_CREATED
  COUPON_UPDATED
  COUPON_DELETED
}

model Coupon {
  id String @id @default(cuid())
  code String @unique @db.VarChar(40)
  description String? @db.VarChar(200)
  discountType CouponDiscountType
  percentOff Int?
  amountOffPaisa Int?
  expiresAt DateTime
  usageLimit Int?
  usageCount Int @default(0)
  isActive Boolean @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([isActive, expiresAt])
  @@index([createdAt(sort: Desc)])
  @@map("coupons")
}

enum CouponDiscountType {
  PERCENTAGE
  FIXED
}
```

`usageLimit` is **nullable**, and null means "no limit". Zero would mean
"nobody may use this", which is a different thing — and an accidental
zero would silently kill a campaign.

The migration is additive. No backfill: `archivedAt` is nullable,
`TrafficEvent` is new, the enum values are additive.

---

## 6. The five bugs the tests caught

The new tests found five real defects, all in code that type-checked
and linted cleanly.

### 6.1 A deactivation with a blank reason was accepted

`deactivateCoupon` did `reason.trim()` and stored the result — but never
checked that it was non-empty. The API's schema caught it; the service
did not. A blank reason would leave an audit entry with a null
`reason`, which is exactly the entry that cannot answer "why did this
coupon stop working?"

**Fixed:** the service now refuses a blank reason itself.

### 6.2 A change of discount type was impossible

`updateCoupon` merged the patch with the old row and validated the
result. Switching a percentage coupon to a fixed one carried the old
`percentOff` into the merged terms, and the validation rejected it as
*"a fixed-amount coupon cannot also have a percentage"* — so a type
change could never be made.

**Fixed:** when the type moves, the column that no longer applies is
dropped **before** the merge. The type change always lands on a
coherent row.

### 6.3 An unrecognised entity-type filter was silently ignored

`adminAuditLogQuerySchema` bounded `entityType` as a free string, so
`entityType=unicorn` parsed cleanly and the API returned an empty list
with a 200. That is the exact failure the action filter was designed to
prevent: an admin who filters for something the server does not
recognise and gets back an empty list has no way of knowing their
filter was ignored.

**Fixed:** the entity-type filter is now a closed enum, taken from the
same list the audit writer uses.

The list itself moved from `src/lib/admin/audit.ts` to
`src/lib/validation/admin.ts`, because the admin services import from
validation and validation must not import from them. The audit module
re-exports it, so there is exactly one copy.

### 6.4 A coupon with no description was refused

`couponCreateSchema` typed `description` as an optional **string**. The
admin form, however, sends `description: null` for an empty box — the
one honest way to say "there is no description" from a form that always
submits the field.

So the most ordinary creation there is — a coupon with a code, a
discount and an expiry, and no prose — was rejected with a 400. It type-
checked perfectly: `null` was never passed to the schema in TypeScript,
because the form builds the body as a `Record<string, unknown>`.

**Fixed:** the field is now `.nullable().optional()`. A coupon with no
description is a perfectly ordinary coupon, and the schema now says so.

### 6.5 The form's "needs a reason" rule drifted from the server's

The server requires a reason whenever a change alters **what the coupon
is worth** — the discount type, the percentage, the amount, or the usage
limit. The form computed the same predicate to decide whether to show
the asterisk, and it had drifted: it counted the discount type, the
percentage and the amount, but **not the usage limit**.

The limit decides how many times the discount can be taken, so changing
it changes the value of the campaign. An admin who edited only the limit
would have got a 400 from a form that never asked for a reason — a
rejection they could not have anticipated and could not have understood.

**Fixed:** the form's predicate now mirrors the server's **exactly**. A
form that asks for a reason the server does not need is an annoyance; a
form that does not ask for a reason the server *does* need is a bug.
The rule is written once in the service and mirrored in the form, and
both are covered by tests on each side of the boundary.

---

## 6A. Why the discount is one field, not two

A note on the form's shape, because it is the one place where the UI
deliberately does **not** mirror the database.

The database stores the discount in **two mutually-exclusive columns** —
`percentOff` and `amountOffPaisa`, one of which is always null. The form
shows **one** value input, whose unit follows the discount type. A form
with two inputs would let an admin fill in both and then have the server
reject the combination — the server is right to reject it, but the form
should never produce a combination the server will refuse.

The *reason* for a terms change, by contrast, is duplicated in both
places, because the form has to know it before it submits.

---

## 7. The verification

### The gate

```bash
npx tsc --noEmit
npx eslint .
DATABASE_URL="postgresql://…" npx vitest run
npx next build
npx tsx scripts/verify-step13.ts
```

**873 tests passing across 48 files.** `tsc` clean, `eslint` clean,
`next build` succeeds with all nine admin pages rendering as `ƒ`
(dynamic, session-gated) and all four new API routes registered.

### The verification script

`scripts/verify-step13.ts` proves the Step 13 properties **outside** the
unit tests, against a real database — 46 checks across nine sections:

1. The analytics funnel, including the conversion rate against a zero
   base.
2. The coupon lifecycle, with its audit entry written alongside it.
3. The mutually exclusive discount columns.
4. The mandatory reason, and that a refused change writes nothing.
5. The audit entry's diff — only the changed fields.
6. The change of discount type.
7. The deactivation, and the preserved redemption count.
8. The coupon list's counts.
9. The trail's action, entity, actor and search filters.

The script removes everything it creates, so it is safe to run
repeatedly.

### A flaky test, fixed

`tests/integration/admin-products.test.ts` compared
`counts.lowStock` against `pagination.total` — two numbers read by
separate queries inside one `Promise.all`, against a database that
other suites are changing at the same time. A product that moved into
or out of the band between the two reads broke the comparison even
though the service was correct. It failed intermittently under a
parallel run and passed every time in isolation.

**Fixed:** the assertion now checks the invariant that holds regardless
of timing — every row in the filtered list is genuinely in the band —
rather than comparing two independently-timed reads.

---

## 8. The files

### Created

| Path | Purpose |
|---|---|
| `src/app/admin/analytics/page.tsx` | The analytics page |
| `src/app/admin/audit-logs/page.tsx` | The audit-trail explorer |
| `src/app/admin/promos/page.tsx` | The promo & coupon panel |
| `src/components/admin/promos/CouponFormDialog.tsx` | Create / edit a coupon |
| `src/components/admin/promos/DeactivateCouponDialog.tsx` | Deactivate / reactivate |
| `src/lib/admin/audit-logs.ts` | The trail's query service |
| `src/lib/admin/coupons.ts` | The coupon service |
| `src/app/api/admin/audit-logs/route.ts` | The trail's API |
| `src/app/api/admin/coupons/route.ts` | The coupon list / create API |
| `src/app/api/admin/coupons/[id]/route.ts` | One coupon — read / update |
| `src/app/api/admin/coupons/[id]/deactivate/route.ts` | The deactivation API |
| `prisma/migrations/20261028200000_coupons_and_audit_explorer/migration.sql` | The schema change |
| `tests/admin/coupons.test.ts` | The pure coupon rules |
| `tests/admin/audit-logs.test.ts` | The diff renderer and the action labels |
| `tests/validation/admin-coupons.test.ts` | The coupon and audit-log schemas |
| `tests/integration/admin-coupons.test.ts` | The coupon lifecycle, against a real database |
| `scripts/verify-step13.ts` | The 46-check verification report |

### Modified

| Path | Change |
|---|---|
| `src/components/admin/shell/admin-nav-items.ts` | The Promos and Audit Logs entries |
| `src/components/ui/icons.tsx` | `LedgerIcon` and `TagIcon` |
| `src/lib/admin/audit.ts` | `COUPON_ACTIONS`; the entity-type list moved to validation |
| `src/lib/admin/analytics.ts` | `getFunnelMetrics` and `computeConversionRate` |
| `src/lib/validation/admin.ts` | The coupon schemas and the audit-log query |
| `prisma/schema.prisma` | The `Coupon` model and the three new actions |
| `tests/admin/nav-items.test.ts` | The two new sections and the count |
| `tests/admin/audit.test.ts` | Extended — never weakened — for the coupon actions |
| `tests/integration/admin-products.test.ts` | The racy assertion |
| `DECISIONS.md` | #83–#97 |
| `package.json` | `verify:step12` and `verify:step13` |

### Deliberately NOT touched

| Path | Why |
|---|---|
| `src/lib/admin/products.ts` | The stock path is proven and tested. The new CRUD lives elsewhere. |
| `src/lib/admin/orders.ts` | The transition table is proven. |
| `src/lib/admin/reviews.ts` | The state machine is proven. |
| `src/proxy.ts` | The fast filter is correct. The guard is the authority. |
| `package.json` dependencies | No chart library, no icon library, no UI kit. |
