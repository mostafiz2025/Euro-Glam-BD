# Step 12 — Enterprise Admin Console

## Context

Steps 1–11 built the platform: a public catalogue, a cart with
ingredient-conflict checking, a transactional checkout, an AI advisor
that cannot talk its way into recommending a blocked product, and an
admin surface with four working pages (overview, inventory, orders,
reviews) over a service layer with atomic audit writes, conditional
updates and closed transition tables.

Step 11's console was **working but plain**. A horizontal nav, totals
without history, no theme, no product CRUD, and no traffic data of any
kind.

Step 12 turns it into an enterprise console. Eight areas:

| # | Area | What landed |
|---|---|---|
| 1 | **Dark mode** | A token layer, a split neutral ramp, an inline no-flash script |
| 2 | **The shell** | A fixed collapsible sidebar, a top bar, a theme toggle |
| 3 | **Charts & analytics** | Hand-rolled SVG line/donut charts, a zero-filled sales series, growth metrics |
| 4 | **Traffic** | A real collector, a closed taxonomy, an honest empty state |
| 5 | **Order & inventory control** | An inline status dropdown, a low-stock badge, a signed-delta stock dialog |
| 6 | **Product CRUD** | Add / Edit / Delete, with **archive** as the default delete |
| 7 | **Reviews, Users, Settings** | A moderation table, a read-only user list, an audited AI-config form |
| 8 | **Docs & verification** | `DECISIONS.md` #66–#82, this guide, `scripts/verify-step12.ts` |

Every existing service, guard, transaction and test survived. The
583-test baseline grew to **753 passing tests across 43 files**.

---

## 1. Dark mode — a token layer, not `dark:` on every element

### 1.1 The neutral ramp is split, on purpose

The original ramp was `--neutral-50` … `--neutral-900`, exposed as
`bg-neutral-*` / `text-neutral-*` / `border-neutral-*`. Dark mode
requires re-pointing some of those values — but **not all of them**.

`text-white` sits on brand fills (`bg-brand-600`). White-on-brand is
correct in *both* themes. So re-pointing `--color-white` to a dark
surface would put dark text on every primary button in dark mode.

The ramp therefore splits into two scales:

| Scale | Range | Behaviour |
|---|---|---|
| **Surface / text** | `--neutral-50` … `--neutral-700` | Re-points across themes |
| **Fill** | `--neutral-800`, `--neutral-900` | Stays dark in both themes |

`--color-white` is never touched.

### 1.2 The semantic tokens

Five new tokens are exposed through `@theme inline`:

```
--color-surface          /* the card / panel background   */
--color-surface-muted    /* the inset / table-stripe bg   */
--color-surface-sunken   /* the page canvas behind cards  */
--color-foreground       /* primary text                  */
--color-foreground-muted /* secondary text                */
--color-border           /* hairline borders              */
```

The codemod that applied them was mechanical:

| Before | After |
|---|---|
| `bg-white` | `bg-surface` |
| `bg-neutral-50` / `bg-neutral-100` | `bg-surface-muted` |
| `bg-neutral-900` | `bg-neutral-950` |
| `text-neutral-900` | `text-foreground` |
| `text-neutral-500/600/700` | `text-foreground-muted` |
| `border-neutral-200/300` | `border-border` |
| `text-white` | **never touched** |

### 1.3 The mechanism

- `@custom-variant dark (&:where(.dark, .dark *));` — Tailwind v4's
  first-class dark variant.
- A `.dark` block in `globals.css` re-points the surface/text scale.
- The theme is read from **`localStorage` + `prefers-color-scheme`**,
  **never a cookie** — decision #46. A cookie read in the root layout
  makes every route request-time and `next build` fails.
- The read happens in an **inline blocking script** in the root layout's
  `<head>`, which sets `document.documentElement.classList` *before*
  first paint. That is the standard no-flash pattern.
- **The `<html>` element's JSX `className` never carries the theme.**
  React would render `class=""` on the server and `class="dark"` on the
  client — a hydration mismatch. The inline script owns the class;
  React owns nothing here.
- `ThemeToggle` hydrates *after* the inline script has run, so its
  first render already matches the DOM.

### 1.4 Theme-aware chart colours

Charts read `var(--brand-500)`, `var(--neutral-400)` and friends
through `currentColor` and CSS variables. A theme flip repaints in the
same frame, with **no JS state and no re-render**.

---

## 2. The shell

### 2.1 The layout

`src/app/admin/layout.tsx` keeps its `requireAdmin()` gate — that is
non-negotiable — and wraps the children in a **client** shell
component, because the sidebar collapses.

```
src/components/admin/shell/AdminShell.tsx    (client — collapse + mobile drawer)
src/components/admin/shell/AdminSidebar.tsx  (client — nav items, active state)
src/components/admin/shell/AdminTopbar.tsx   (client — search, theme toggle, user menu)
src/components/admin/shell/ThemeToggle.tsx   (client — sun / moon)
```

The shell is a client component **inside** a server layout. The
authoritative gate therefore stays server-side: a client-side check
could be bypassed by anyone who edits the DOM.

### 2.2 The navigation

| Label | Route | Icon |
|---|---|---|
| Dashboard | `/admin` | grid |
| Inventory | `/admin/inventory` | box / tag |
| Orders | `/admin/orders` | bag / receipt |
| Reviews | `/admin/reviews` | star |
| Users | `/admin/users` | `UsersIcon` |
| Settings | `/admin/settings` | `SettingsIcon` |

`SunIcon`, `MoonIcon`, `UsersIcon` and `SettingsIcon` are hand-rolled
in `src/components/ui/icons.tsx`, in the same style as the ~40 icons
already there. No icon library was added.

### 2.3 Responsiveness

- **Desktop (`lg`+):** a fixed left sidebar. Collapsed = icons only
  (72px); expanded = icons + labels (260px). The collapse state
  persists in `localStorage`.
- **Mobile:** the sidebar becomes an off-canvas drawer behind a
  hamburger, with a scrim that closes on tap and closes on `Escape`.
- The main column scrolls; the sidebar is `position: fixed` with its
  own scroll when the nav overflows.

### 2.4 Active-route matching

`/admin` matches exactly; every other item matches by prefix. The
matching uses `usePathname()` in the client sidebar, so the layout
stays a server component.

---

## 3. Charts and analytics

### 3.1 Why not Recharts or Chart.js

| Option | Verdict |
|---|---|
| **Recharts** | ~90 kB. Resolves colours in JS, so a theme change re-renders every chart through React. |
| **Chart.js** | Canvas — no server-rendered markup, no CSS variables, no accessible DOM. |
| **Hand-rolled SVG** | **Chosen.** Matches the codebase's existing hand-rolled-icon decision. SSR-able, theme-reactive through CSS variables alone, zero dependencies, accessible (`role="img"` + `<title>`/`<desc>`). |

### 3.2 The geometry is pure

`src/lib/admin/charts.ts` contains no React, no DOM and no database —
only functions taking numbers and returning numbers and strings.

That is deliberate. Chart geometry is where the bugs live: a
divide-by-zero on a flat series, a `NaN` coordinate on an empty one, a
degenerate zero-length arc when only one slice has a value. Those bugs
are almost impossible to find by looking at a rendered chart — you see a
blank, or a slightly wrong curve, and you have no idea which arithmetic
produced it.

The degenerate cases are **named and tested**:

- a zero-valued series produces a valid path, not `NaN` coordinates;
- a series where every point is equal produces a **flat line**, not a
  divide-by-zero;
- a donut with a single non-zero slice produces a **full circle** (two
  half-arcs), not a degenerate zero-length arc;
- a donut with all-zero slices produces an empty ring plus an explicit
  "no data" state — never a fake 100%.

### 3.3 The components

| File | Role |
|---|---|
| `src/components/admin/charts/LineChart.tsx` | SVG `<path>` for the line, a gradient-filled `<path>` for the area, `<title>`/`<desc>`, a labelled axis |
| `src/components/admin/charts/DonutChart.tsx` | `<circle>` segments with `stroke-dasharray`/`stroke-dashoffset`, plus a legend |
| `src/components/admin/charts/ChartFrame.tsx` | The shared card chrome — title, range switcher slot, empty state |
| `src/components/admin/charts/TrafficDonut.tsx` | The traffic widget — donut + legend + empty state |

### 3.4 The analytics service

`src/lib/admin/analytics.ts` is **separate from `stats.ts`**, which
keeps its existing behaviour exactly. `getDashboardStats()` answers
"how much money has come in?" — a question with one number. Analytics
answers "how is that number *moving*?", which needs a time series, a
comparison against a previous period and a traffic breakdown.

```ts
export type SalesRange = "DAILY" | "WEEKLY" | "MONTHLY";

export async function getSalesSeries(range: SalesRange): Promise<SalesPoint[]>
export async function getGrowthMetrics(): Promise<GrowthMetrics>
export async function getTrafficBreakdown(days: number): Promise<TrafficBreakdown>
```

**The series is zero-filled.** The SQL uses `generate_series` over the
period with a `LEFT JOIN` onto the aggregate, so a day with no orders
is an explicit `0` in the series — never a gap in the chart, and never
a shorter-than-expected array.

**Revenue excludes cancelled orders; order volume includes them.** The
money was never taken, so a cancelled COD order contributes nothing to
revenue — the same rule `getDashboardStats` already uses, so the two
must agree. But an abandoned order is still a demand signal. The
asymmetry is documented in the service because it looks like an
inconsistency otherwise.

### 3.5 The timezone

`orders.createdAt` is `TIMESTAMP(3)` — **no timezone**. Confirmed from
`prisma/migrations/20260101000000_init/migration.sql` and
`20261027120000_admin_audit_and_sms_workflow/migration.sql`.

So every comparison is against the server's local time, and the SQL
casts **both sides** of every date comparison to `timestamp`
explicitly. Mixing `timestamp` and `timestamptz` in one comparison is a
classic off-by-one-day chart bug: the series silently shifts, or
duplicates a day at the boundary, depending on the server's offset. The
`generate_series` bounds use `date_trunc('day', now())` — also a
`timestamp`.

### 3.6 Growth is not always a percentage

Growth compares the last 30 days against the previous 30 days.

| Base | Result |
|---|---|
| `previous === 0 && current > 0` | **`new`** — not `+100%` |
| `previous === 0 && current === 0` | **`flat`** |
| `previous > 0` | the percentage, signed |

A percentage against a zero base is a lie. "New" is the honest word.

---

## 4. The traffic collector — building the data, not faking it

### 4.1 Why it exists

There was no traffic data anywhere in the system: no page-view table,
no referrer column, no UTM capture. So a "Customer Traffic & Source"
breakdown could only have been built by inventing four numbers — and an
invented donut is worse than no donut, because it *looks* like data.

So the data is collected.

### 4.2 The table

```prisma
model TrafficEvent {
  id String @id @default(cuid())
  source String @db.VarChar(40)
  referrerHost String? @db.VarChar(255)
  path String @db.VarChar(255)
  visitorId String @db.VarChar(64)
  createdAt DateTime @default(now())
}
```

### 4.3 The closed taxonomy

```ts
export type TrafficSource = "facebook" | "organic" | "direct" | "email" | "other";
```

Five buckets, because a donut of forty hosts is not a breakdown — it is
a log file with circles. And a closed set means a bucket with no
traffic is *reported as zero* rather than being absent, which is a
different and more useful claim.

The derivation order is **fixed and documented**:

1. `utmSource` matches a known source → that source.
2. Otherwise the referrer host contains `facebook.com` / `fb.com` /
   `m.facebook.com` → **facebook**.
3. Otherwise the referrer host is a known search engine (`google.`,
   `bing.`, `duckduckgo.`, `yahoo.`) → **organic**.
4. Otherwise there is **no** referrer and no `utmSource` → **direct**.
5. Otherwise the referrer host contains a mail provider
   (`mail.google.`, `outlook.`, `yahoo.`) → **email**.
6. Otherwise → **other**.

Step 5 is deliberately *after* steps 2–4: a Facebook link clicked from
an email client is still a Facebook click in practice. The taxonomy is
closed and deterministic, so the order is fixed rather than arguable.

Hosts are matched as a **domain suffix** with a label boundary, so
`www.facebook.com`, `m.facebook.com` and `lm.facebook.com` all match
while `facebook.com.example.org` does not.

### 4.4 `PaymentMethod` is NOT a traffic source

`COD | BKASH | NAGAD | CARD` is *how they paid*, not *where they came
from*. Deriving a "Facebook" slice from the orders that happened to be
paid by bKash would be a fabrication — and one that looks entirely
plausible on a dashboard, which is the worst kind.

The channel comes from the referrer host and the UTM parameters, and
from nowhere else.

### 4.5 Privacy

The recorded row contains a bucketed channel, a referrer **host**, a
landing path and a pseudonymous visitor id. It contains:

- **no** IP address
- **no** user agent
- **no** raw referrer URL — only its host, so a campaign parameter or a
  session token in a query string never reaches the database
- **no** cross-site identifier
- **no** personal data

The visitor id is a random value in a first-party cookie
(`egb_vid`, `SameSite=Lax`, `Secure` in production, 365-day expiry). It
is not the user id and it is not a fingerprint: someone who clears
their cookies, or uses two browsers, is two visitors. A signed-in
customer's traffic is bucketed exactly like anyone else's, and the two
are never joined. Events older than 180 days are deleted by a
maintenance script.

### 4.6 The collector

`src/app/api/track/route.ts` is public — it is storefront traffic, not
admin data. The storefront mounts a tiny client component that fires
one `navigator.sendBeacon` on a route change (debounced), capturing
`document.referrer` and the current UTM parameters.

The write is **fire-and-forget**, wrapped in `try/catch`. A failed
analytics write must never break a customer page.

### 4.7 The empty state

Before any traffic has been collected, the widget shows an explicit
"No traffic recorded yet" — never a fake donut of four seeded slices.
This is the Step 9 "silently empty" guard applied to a chart.

---

## 5. Order and inventory control

### 5.1 The services are unchanged

The stock path (`PATCH /api/admin/products/[id]/stock` →
`adjustProductStock` → conditional `updateMany` → `writeAuditEntry` in
one transaction) is **byte-identical**. The order status path calls the
existing `PATCH /api/admin/orders/[id]/status`, which enforces the
closed transition table.

Step 12 adds the *interface*, not new behaviour.

### 5.2 The components

| File | Role |
|---|---|
| `src/components/admin/inventory/StockAdjustDialog.tsx` | A signed `+5` / `−3` delta, with a reason |
| `src/components/admin/inventory/LowStockBadge.tsx` | The low-stock pill |
| `src/components/admin/orders/OrderStatusSelect.tsx` | An inline status dropdown |
| `src/components/admin/products/ProductFormDialog.tsx` | Add / Edit |
| `src/components/admin/products/DeleteProductDialog.tsx` | Archive / hard delete / restore |

`StockAdjustDialog` submits a **signed delta**, never an absolute
quantity — the request's "signed-delta stock adjustment" matches the
service's contract exactly. The dialog is disabled when the adjustment
would drive stock below zero, and the server still refuses it. The
client check is a courtesy, not the guard.

### 5.3 The low-stock threshold

The stock bands are **nested, not a partition**:

- `IN_STOCK` = buyable (`stockQuantity > 0`) — **includes** low stock
- `LOW_STOCK` is a warning **nested inside** `IN_STOCK`
- `OUT_OF_STOCK` (`<= 0`) is the one disjoint band

So `inStock + outOfStock === all` is the true partition; the three-way
sum is not. Any low-stock badge must therefore use
`stockQuantity > 0 && stockQuantity < 5` — the request's "quantity < 5"
wording omits the `> 0` half, and a product at zero is *out of stock*,
not *low*.

`LOW_STOCK_THRESHOLD = 5` in `src/lib/admin/stats.ts` is the single
source of that threshold.

### 5.4 Feedback and refresh

Every mutation follows one pattern:

1. Submit to the existing API route.
2. On success: toast, close the dialog, `router.refresh()` so the
   server component re-renders with the new data.
3. On failure: surface the API envelope's `error.message` **verbatim**.
   The server's 409 text is the useful part ("That adjustment would
   leave the stock at -3…"), and it must not be replaced with a generic
   "Something went wrong."

`router.refresh()` — not a full reload — re-renders the server
components without losing the sidebar state.

---

## 6. Product CRUD

### 6.1 A new module, not a widening of `products.ts`

`src/lib/admin/products.ts` carries an explicit doc comment declaring
the admin product surface *"Stock only."* That sentence describes a
deliberate boundary.

Rather than delete the sentence, Step 12 **widens the module's scope
and rewrites the comment to describe the new boundary honestly** — the
request explicitly requires product CRUD, and the original comment's
argument (a price change is a commercial decision that needs a record
of the old value, the new value and the reason) is *satisfied* by the
new module, not violated by it.

```
src/lib/admin/products.ts   ← the stock path, untouched
src/lib/admin/catalog.ts    ← the CRUD path, new
```

### 6.2 The transaction shape

The same template as `src/lib/admin/orders.ts`:

```ts
return db.$transaction(async (tx) => {
  // read → validate → conditional updateMany → writeAuditEntry(tx, …) → re-read
}, { maxWait: 5_000, timeout: 10_000 });
```

A price or stock edit is **conditional on the values the admin saw**, so
two admins editing the same product produce one winner and one 409 —
the same safety property the order and review services already have.

The audit entry records `before` and `after` as the **changed fields
only**, so the log shows "price 95000 → 120000" rather than the entire
product row. A **price change requires a mandatory reason**.

### 6.3 The empty-data trap

One real bug was found and fixed here. Prisma's `updateMany` with an
**empty `data` object matches zero rows** rather than matching the one
row it was aimed at. An edit that changed only the stock therefore
matched nothing and produced a spurious 409 — every stock-only product
edit would have failed.

The fix is to skip the update entirely when the edit named no editable
field:

```ts
if (touched.length > 0) {
  const updated = await tx.product.updateMany({ where: expectation, data });
  if (updated.count === 0) {
    throw ApiError.conflict("This product was changed by someone else while you were editing it. Reload and try again.");
  }
}
```

### 6.4 The stock-delta path

A stock change on an Edit form is expressed as a signed `stockDelta`
and routed through the existing stock service, so it keeps the
`PRODUCT_STOCK_ADJUSTED` trail and the conditional-update safety. The
Edit form **never overwrites stock with an absolute value**.

The stock-delta path writes its **own** `PRODUCT_STOCK_ADJUSTED` audit
entry — separate from the `PRODUCT_UPDATED` entry for the field edit.

### 6.5 Delete means archive

`OrderItem.productId` is `onDelete: Restrict`, and the order line
snapshots the product's name and price *precisely so that history
survives*. A hard delete of a product that appears on any order fails
at the database level.

So the dialog has **two** modes, and archive is the default:

- **Archive** — withdraws the product. It disappears from every
  storefront query; the order history survives; it can be restored.
  This is almost always the right answer.
- **Delete outright** — removes the row. Possible **only** for a
  product with no order items, no cart items and no reviews. The
  server refuses it otherwise, and says why.

The typed `confirmName` is the standard confirmation for "this exact
thing". A destructive action with one click is a destructive action
somebody will do by accident. The `reason` is mandatory because a
deletion is the one admin action that leaves nothing behind to inspect.

### 6.6 Restore is a separate action

Restoration is a **commercial decision**, exactly like archiving — so
it asks for a reason and writes its own audit entry. It does **not**
ask for the typed name; nothing is being destroyed.

The three operations stay three distinct endpoints with three distinct
audit actions:

| Operation | Endpoint | Audit action |
|---|---|---|
| Archive | `DELETE /api/admin/products/[id]` | `PRODUCT_DELETED` (outcome `ARCHIVED`) |
| Hard delete | `DELETE /api/admin/products/[id]` (`mode: "hard"`) | `PRODUCT_DELETED` (outcome `DELETED`) |
| Restore | `POST /api/admin/products/[id]/restore` | `PRODUCT_UPDATED` (outcome `RESTORED`) |

The reason they stay separate: **archive is not reversible by an
ordinary update.** If restoring were a field edit, the timestamp of a
withdrawal could be forged by anyone with edit rights — the record of
*when* a product was withdrawn is exactly the thing an audit needs.

### 6.7 The storefront filter — the ten sites

**This was the highest-risk work in the step.** A forgotten
`archivedAt: null` filter **sells an archived product**.

```ts
// src/lib/catalog/product-visibility.ts
export const ACTIVE_PRODUCT_WHERE = {
  archivedAt: null,
} satisfies Prisma.ProductWhereInput;
```

A full read-only audit of the codebase found the exposure is **10
distinct query sites across 5 files** — *not* the five initially
estimated. The helper alone is not sufficient; each site needs a
specific treatment.

| # | Site | Call | Treatment |
|---|---|---|---|
| 1 | `catalog/service.ts` — list / search / filter | `findMany` / `.count` from `buildWhereClause()` | `archivedAt: null` **inside `buildWhereClause()`** — covers the rows *and* the count, and every downstream caller |
| 2 | `catalog/service.ts` — product detail | `findUnique({ where: { id } })` | **Switch to `findFirst({ where: { id, archivedAt: null } })`** — Prisma 6.19's `findUnique` accepts only unique-field filters |
| 3 | `catalog/service.ts` — related products | `findMany({ where: { categoryId, id: { not }, stockQuantity: { gt: 0 } } })` | Add `archivedAt: null` |
| 4 | `catalog/service.ts` — category product counts | `_count: { select: { products: true } }` | Filtered count: `_count: { select: { products: { where: { archivedAt: null } } } }` — otherwise the filter panel counts withdrawn products |
| 5 | `cart/service.ts` — `loadProduct`, add-to-cart | `findUnique({ where: { id } })` | **Switch to `findFirst`** + `archivedAt: null` |
| 6 | `cart/service.ts` — cart read, quantity update | nested `product: { select }` | Nested relation — see the drop-semantics caveat below |
| 7 | `ai/service.ts` — advisor shortlist | `findMany({ where: { stockQuantity: { gt: 0 }, … } })` | Add `archivedAt: null` — an archived product must not be recommended |
| 8 | `catalog/review-submission.ts` — review existence check | `findUnique({ where: { id } })` | **Switch to `findFirst`** + `archivedAt: null` |
| 9 | `orders/service.ts` — checkout cart read | nested `product: { select }` | Filter at the read and throw a **distinct** error — see below |
| 10 | `orders/service.ts` — checkout stock decrement | `updateMany({ where: { id, stockQuantity: { gte } } })` | **Do NOT add `archivedAt: null`** — see below |

**Two sites needed a behaviour decision, not just a filter.**

**(a) The checkout decrement must not reuse the insufficient-stock
signal.** At site 10, `count === 0` currently means *"not enough
stock"*. If `archivedAt: null` were added there, an archived product
would produce the same `count === 0` and the customer would be told
*"does not have enough stock left"* for a product that was withdrawn —
wrong, and confusing enough to generate a support ticket. The archived
check happens at site 9 instead and throws a **distinct**
`ApiError.conflict("… is no longer available")` before the decrement
loop.

**(b) A nested-relation filter silently drops rows — it does not
error.** At sites 6 and 9, adding `where: { archivedAt: null }` to a
nested `product` select makes Prisma **omit the cart item entirely**
(an inner-join-like effect) rather than returning it with a null
product. The customer's cart would silently lose the line — a price
that changes between viewing the cart and paying, with no explanation.

So a nested filter is **not** used at site 9. The product is read
unfiltered, `archivedAt` is checked in application code, and a distinct
"no longer available" error is thrown. At site 6 the cart **keeps** the
line but the UI marks it **"no longer available"** and blocks checkout —
the honest presentation, because silently removing a line changes the
total the customer agreed to.

Site 6's implementation: the nested select gains `archivedAt: true` as
a *selected field* (not a filter), and the cart service exposes
`available: boolean` per line. The cart UI renders a disabled line for
an unavailable product.

### 6.8 What is deliberately NOT affected

Verified by the audit:

- `src/proxy.ts` and `src/lib/catalog/existence.ts` are HTTP-based —
  they inherit the fix at site 2 automatically, so an archived
  product's page returns a proper HTTP 404 via the existing branded
  rewrite.
- There is **no raw SQL** touching products (the only `$queryRaw` in
  the codebase is `SELECT 1` in the health route).
- There are **no server actions**, **no** `generateStaticParams`, **no**
  sitemap or feed, and **no** GraphQL — so there is no cache to
  invalidate and no second rendering path to cover.

### 6.9 Admin reads deliberately do NOT filter

`src/lib/admin/stats.ts` and `src/lib/admin/catalog.ts` must see
archived products — an admin has to be able to find and restore them.

The admin inventory list therefore gains an explicit `ARCHIVED` filter
and an `archived` count, so archived products are visible *as a
category* rather than silently mixed into the live catalogue.

`ARCHIVED` is a **visibility axis**, distinct from the stock
partition. It is not a fourth stock band: an archived product may also
be out of stock, and the two counts are independent.

---

## 7. Reviews, Users and Settings

### 7.1 Reviews — the table UI only

The API already existed (`GET /api/admin/reviews`,
`PATCH /api/admin/reviews/[id]`) and the state machine is proven. **The
service and the API are untouched.** Step 12 adds the table:

- A `ReviewModerationTable` with columns: product, customer, rating,
  comment, submitted, state, actions.
- One-click **Approve** / **Hide** / **Re-approve**, each calling the
  existing PATCH with `{ action }`.
- A reason field for **Hide** (the API already accepts `reason`).
- The state pill reuses `StatusBadge` from
  `src/components/admin/primitives.tsx`.
- The pending count in the sidebar comes from the same `counts` the
  queue uses, so the badge and the list cannot disagree.

### 7.2 Users — read-only by design

`GET /api/admin/users` lists users with role, join date, order count
and lifetime spend.

**Read-only is a decision, not an omission.** Every mutating admin
action in this codebase is audited. An un-audited user-edit path would
be the only one — and a user-edit path has obvious abuse potential
(role elevation, phone-number harvesting, `smsOptIn` flipping). If a
role-change capability is wanted later, it is a separate, audited
decision, not a silent side effect of a "Users" page.

### 7.3 Settings — AI configuration only, and audited

`AiConfig` already existed with exactly the fields Settings needs:
`disclaimerText`, `aiProductIds`, `systemPrompt`,
`enforceCartConflicts` — plus `disclaimerVersion`, `key` and
`updatedAt`.

Settings **gains** an audit trail it never had: `AI_CONFIG_UPDATED`,
written in the same transaction as the update, with `before`/`after`
holding the changed fields.

Two things that are **not** settings:

- `disclaimerVersion` is a **stamp**, not a setting. The schema comment
  says so: *"Bumped whenever disclaimerText changes; stamped onto
  every message's meta so an audit can prove which version a user
  actually saw."* It is incremented by the service when
  `disclaimerText` changes — never edited by hand.
- `LOW_STOCK_THRESHOLD` stays a **constant** in
  `src/lib/admin/stats.ts`. A setting defaulting to zero would mean
  "low stock" means "out of stock", which is the Step 9 bug class.

---

## 8. The API surface

```
GET    /api/admin/products                 list, with the ARCHIVED filter
POST   /api/admin/products                 create
GET    /api/admin/products/[id]            one product, full detail
PATCH  /api/admin/products/[id]            update
DELETE /api/admin/products/[id]            archive by default; hard delete with mode="hard"
POST   /api/admin/products/[id]/restore    restore an archived product
GET    /api/admin/analytics                the series, the growth metrics, the traffic breakdown
GET    /api/admin/users                    the read-only user list
GET    /api/admin/settings/ai-config       the AI configuration
PATCH  /api/admin/settings/ai-config       update it, with an audit trail
POST   /api/track                          the traffic beacon (public)
```

`PATCH /api/admin/products/[id]/stock` (Step 11) is **unchanged**.

Every route keeps the house conventions: `await connection()` sits
**outside** the try block, the proxy is a fast filter and
`requireAdmin()` is the authority, and every mutating action is
audited.

### 8.1 The `P2003` branch

`handleApiError` mapped `P2002` → 409, `P2025` → 404 and `P2034` → 409,
but had **no `P2003` branch** — a foreign-key violation fell through
to the generic 500 "Something went wrong".

`P2003` is exactly what a hard delete of a product that gained an
order item between the check and the delete raises, and it is a
**conflict, not a crash**. The new branch sits right after the `P2002`
branch and names the remedy: *"That product is now part of an order and
cannot be deleted. Archive it instead."*

---

## 9. Verification

### 9.1 The storefront gate — the ten-point check

`scripts/verify-step12.ts` proves the archived-product safety net by
**running the real queries**, not by reading the source:

1. `/` — the home Best Sellers and New Arrivals grids exclude archived
   products.
2. `/products` — the grid, the sort control's count, and the category
   filter panel all exclude them (the panel's *counts* too — a filter
   offering "12 products" when there are 9 sellable is a lie).
3. `/products/[id]` — an archived product's page returns a **404**.
4. The related-products rail excludes them.
5. The cart cannot **add** an archived product.
6. The cart **keeps** an already-added archived product, marks it "no
   longer available", and **blocks checkout**.
7. The AI advisor never recommends an archived product.
8. A review cannot be submitted for an archived product.
9. Checkout of a cart containing an archived product fails with **"no
   longer available"**, *not* "does not have enough stock".
10. The public REST API excludes archived products.

The script has four sections and 46 checks: the storefront gate, the
CRUD and its audit trail, the traffic taxonomy and privacy posture, and
the analytics.

### 9.2 The test suite

New suites:

| Suite | Covers |
|---|---|
| `tests/admin/charts.test.ts` | The degenerate geometry — zero, flat, single-slice, all-zero |
| `tests/admin/analytics.test.ts` | Growth metrics — `new`, `flat`, positive, negative |
| `tests/admin/traffic.test.ts` | Every branch of the source taxonomy |
| `tests/admin/catalog.test.ts` | Product validation and the archive predicate |
| `tests/validation/admin-catalog.test.ts` | The create / update / delete schemas |
| `tests/integration/admin-catalog.test.ts` | CRUD + audit + the archived filter, end to end |
| `tests/integration/traffic.test.ts` | The collector and the breakdown |
| `tests/api/errors.test.ts` | The Prisma code mappings |

**The existing 583 tests all still pass.** The audit-vocabulary test was
**extended** to require a lookup for every new enum value — never
weakened.

### 9.3 The vitest `.env` trap

`vitest.config.ts` does **not** load `.env`. Integration tests read
`DATABASE_URL` from the process environment, so running `npx vitest run`
without it **silently skips** the integration suites rather than
failing them — a false green that would mask real failures.

The gate is therefore run with the variable set explicitly:

```bash
DATABASE_URL="postgresql://postgres:…@localhost:5432/euro_glam_bd?schema=public" \
  npx vitest run
```

### 9.4 The command gate

```bash
npx prisma generate
npx prisma migrate deploy

npx tsc --noEmit
npx eslint .
DATABASE_URL="…" npx vitest run
npx next build
```

Expected: **753 passing tests across 43 files**, `tsc` clean, `eslint`
clean, build succeeds with the new admin routes rendering as `ƒ`
(`/api/admin/products`, `/api/admin/products/[id]`,
`/api/admin/products/[id]/restore`, `/api/admin/products/[id]/stock`,
`/api/admin/analytics`, `/api/admin/users`,
`/api/admin/settings/ai-config`, `/admin/products`, `/admin/settings`,
`/admin/users`).

---

## 10. The risks that were real

| # | Risk | Mitigation |
|---|---|---|
| R1 | A forgotten `archivedAt: null` filter **sells an archived product** | One shared `ACTIVE_PRODUCT_WHERE`, applied at all **10 verified sites across 5 files**; a ten-point gate; a per-file grep in the verification script |
| R12 | The checkout's stock decrement conflates "archived" with "out of stock" | The decrement is deliberately **not** filtered; the archived check happens at the read, with a **distinct** error |
| R13 | A nested-relation filter silently drops the cart line, changing the customer's total | The cart keeps the line and marks it unavailable; checkout is blocked. The nested select gains `archivedAt` as a **field**, not a filter |
| — | Prisma's `updateMany` with empty `data` matches **zero** rows | The field update is skipped entirely when no editable field was touched (§6.3) |
| — | A `P2003` foreign-key violation falls through to a generic 500 | A dedicated `P2003` → 409 branch, naming the remedy (§8.1) |
| R3 | The inline theme script causes a hydration mismatch | The `<html>`'s JSX `className` never carries the theme — the script owns the class, React owns nothing |
| R4 | The traffic collector slows the storefront | Fire-and-forget `sendBeacon`, a debounced route-change hook, a `try/catch` that swallows analytics failures |
| R6 | The growth percentage divides by zero | `previous === 0` returns `new`, never a percentage. Tested |
| R7 | The chart geometry produces `NaN` on an empty series | Pure functions with explicit degenerate cases; unit-tested |
| R8 | A concurrent edit clobbers a price change | The conditional `updateMany` on the observed values |
| R11 | The analytics SQL mixes `timestamp` and `timestamptz` | `createdAt` is `TIMESTAMP(3)` — verified from the migrations. Both sides of every comparison are cast to `timestamp` explicitly |
| R10 | The traffic donut ships with invented numbers | The empty state is explicit; no seed data is ever written |
| — | The vitest config does not load `.env`, so integration tests skip silently | The gate sets `DATABASE_URL` explicitly (§9.3) |

---

## 11. The files

### Created

| Path | Purpose |
|---|---|
| `prisma/migrations/20261028xxxxxx_admin_console_v2/migration.sql` | `archivedAt`, `TrafficEvent`, the new `AdminAction` values |
| `src/lib/catalog/product-visibility.ts` | `ACTIVE_PRODUCT_WHERE` |
| `src/lib/traffic.ts` | Source derivation, the visitor cookie, the event writer |
| `src/lib/admin/analytics.ts` | The sales series, the growth metrics, the traffic breakdown |
| `src/lib/admin/charts.ts` | The pure SVG geometry |
| `src/lib/admin/catalog.ts` | Product create / update / archive / hard delete / restore |
| `src/lib/admin/users.ts` | The read-only user list |
| `src/lib/admin/ai-config.ts` | The AI configuration, with its audit trail |
| `src/lib/admin/shell-preferences.ts` | The persisted sidebar state |
| `src/components/admin/charts/*` | `LineChart`, `DonutChart`, `ChartFrame`, `TrafficDonut` |
| `src/components/admin/shell/*` | `AdminShell`, `AdminSidebar`, `AdminTopbar`, `ThemeToggle` |
| `src/components/admin/inventory/*` | `StockAdjustDialog`, `LowStockBadge` |
| `src/components/admin/orders/OrderStatusSelect.tsx` | The inline status dropdown |
| `src/components/admin/products/*` | `ProductFormDialog`, `DeleteProductDialog` |
| `src/components/admin/reviews/ReviewModerationTable.tsx` | The moderation table |
| `src/components/admin/settings/AiConfigForm.tsx` | The AI-config form |
| `src/app/api/admin/products/route.ts` | GET + POST |
| `src/app/api/admin/products/[id]/route.ts` | GET + PATCH + DELETE |
| `src/app/api/admin/products/[id]/restore/route.ts` | POST |
| `src/app/api/admin/analytics/route.ts` | The dashboard analytics |
| `src/app/api/admin/users/route.ts` | The user list |
| `src/app/api/admin/settings/ai-config/route.ts` | GET + PATCH |
| `src/app/api/track/route.ts` | The traffic beacon |
| `src/app/admin/products/page.tsx` | The product management page |
| `src/app/admin/users/page.tsx` | The Users page |
| `src/app/admin/settings/page.tsx` | The Settings page |
| `tests/admin/*`, `tests/validation/admin-catalog.test.ts`, `tests/integration/*`, `tests/api/errors.test.ts` | The new suites |
| `scripts/verify-step12.ts` | The 46-check verification report |

### Modified

| Path | Change |
|---|---|
| `src/app/globals.css` | The dark tokens, the split neutral ramp, `@custom-variant dark`, the semantic surface tokens |
| `src/app/layout.tsx` | The inline no-flash theme script |
| `src/app/admin/layout.tsx` | The shell; the `requireAdmin()` gate preserved |
| `src/app/admin/page.tsx` | The metric cards with growth, the sales chart, the traffic donut |
| `src/app/admin/inventory/page.tsx` | The low-stock column, the stock dialog, the product CRUD entry points |
| `src/app/admin/orders/page.tsx` | The inline status dropdown |
| `src/app/admin/reviews/page.tsx` | The moderation table |
| `src/components/admin/primitives.tsx` | Theme-aware surfaces; the existing props preserved |
| `src/components/ui/icons.tsx` | `UsersIcon`, `SettingsIcon`, the sidebar icons |
| `src/lib/admin/stats.ts` | The `ARCHIVED` visibility axis and the `archived` count; the stock behaviour unchanged |
| `src/lib/admin/audit.ts` | `PRODUCT_ACTIONS` gains `created`/`updated`/`deleted`; `AI_CONFIG_UPDATED` |
| `src/lib/admin/products.ts` | The stock path, unchanged; the scope comment rewritten |
| `src/lib/catalog/service.ts` | Sites 1–4 |
| `src/lib/cart/service.ts` | Sites 5–6 |
| `src/lib/orders/service.ts` | Sites 9–10 — the archive check only; the pricing, decrement and conflict logic are untouched |
| `src/lib/ai/service.ts` | Site 7 — plus the exported `listAdvisorCandidateIds` verification helper |
| `src/lib/catalog/review-submission.ts` | Site 8 |
| `src/lib/validation/admin.ts` | The product schemas; the `ARCHIVED` filter |
| `src/lib/api/errors.ts` | The `P2003` → 409 branch |
| `prisma/schema.prisma` | `archivedAt`, `TrafficEvent`, the enum values |
| `DECISIONS.md` | Decisions #66–#82 |
| `docs/STEP-12-ADMIN-CONSOLE.md` | This guide |

### Deliberately NOT touched

| Path | Why |
|---|---|
| `src/lib/admin/products.ts` — the stock write | Step 11's atomic stock write is proven and tested. The CRUD lives in `catalog.ts` |
| `src/lib/admin/orders.ts` | The transition table is proven. The UI calls the existing API |
| `src/lib/admin/reviews.ts` | The state machine is proven. The UI calls the existing API |
| `src/proxy.ts` | The fast filter is correct. The guard is the authority |
| `src/lib/auth/guards.ts` | `requireAdmin()` is correct |
| `src/lib/orders/service.ts` — the checkout *logic* | Its pricing, stock-decrement and ingredient-conflict logic is unchanged. Two targeted edits for the archive check only |
| `package.json` dependencies | No chart library, no icon library, no UI kit |
