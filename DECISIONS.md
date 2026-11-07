# Architecture Decisions — Euro Glam BD MVP

All 12 foundational decisions locked and approved, and 255 numbered decisions in total. This file is the source of truth; code must conform to it.

| # | Area | Decision |
|---|------|----------|
| 1 | Deliverable | Working MVP with mocked external services (real DB, real business logic, adapters for AI/SMS/Storage) |
| 2 | Database & ORM | PostgreSQL + Prisma ORM |
| 3 | Backend routing | Next.js App Router — route handlers at `src/app/api/**/route.ts` |
| 4 | Checkout | Cash-on-Delivery (COD) **plus** mobile banking (bKash / Nagad) and card — see "Step 18 decisions", "Step 20 decisions", "Step 21 decisions" and "Step 22 decisions"; `payment_method` / `payment_status` columns present from day one |
| 5 | Auth | Custom JWT via `jose`; HTTP-only cookie; `SameSite=Lax`; 7-day TTL; server-side `CUSTOMER` / `ADMIN` role checks; password sign-in **and** email sign-in by one-time password; accounts are **unverified** until a code mailed to their address comes back — see "Email sign-in by one-time password" and "Step 24 decisions" |
| 6 | AI execution | `AiProvider` interface; deterministic mock by default; real OpenAI behind `AI_PROVIDER=mock\|openai` |
| 7 | Conflict engine | Pure deterministic TypeScript rules engine; severities `BLOCK` and `WARN` |
| 8 | Media storage | `StorageAdapter` abstraction; local filesystem driver; robust server-side upload validation |
| 9 | SMS workflow | Scheduled reminder processing via mock `SmsGateway`; persistent `SmsLog`; explicit opt-in consent; admin-triggered run-now |
| 10 | Review moderation | Unverified purchases allowed; `isApproved=false` default; hidden publicly until admin approval |
| 11 | Deployment | Long-running Node.js server environment by default. A serverless deployment (e.g. Vercel) is supported by setting `STORAGE_DRIVER="cloudinary"`, because the filesystem there is ephemeral — see "Step 28 decisions" |

## Derived engineering rules

- **Referential actions are explicit.** Prisma's default is `SetNull` for optional relations and `Restrict` for mandatory ones. Every relation whose history must survive is written with an explicit `onDelete: Restrict`. `relationMode` stays at the default `foreignKeys` — `prisma` mode moves enforcement into the client and is *weaker*, not stronger.
- **Money is `Int` in the smallest unit (poisha), never `Float`.** BDT has 2 decimal places (1 BDT = 100 poisha). `Float` is excluded because binary floating point cannot represent decimal amounts exactly and sums drift. `Decimal` is reserved for values needing more precision than the currency has.
- **Use `Jsonb`, not `Json`,** for filterable JSON columns — a plain `Json` column cannot be compared in `.where()` at all.
- **`String[]` scalar lists are PostgreSQL-only and must not be indexed.** `@@index` on a scalar list is undocumented/unsupported — use a raw GIN index via `addColumn`/raw SQL if containment lookups are needed later.
- **Nullable `@@unique` does not enforce "one active row".** PostgreSQL treats `NULL != NULL`, so multiple NULLs are allowed. Use a non-null discriminator column or a partial unique index.
- **The LLM never decides whether a conflict exists.** The rules engine is pure, deterministic, and I/O-free; the LLM only phrases an already-decided result.
- **Depletion estimates are user-provided**, never inferred from order data — inference would be fabricated precision.
- **SMS requires explicit opt-in** (`smsOptIn`, default `false`).

---

## Step 9 decisions (API routes & transactional checkout)

| # | Area | Decision |
|---|------|----------|
| 12 | Money | Integer **poisha** (1 BDT = 100 poisha) everywhere — API, database, and calculation. `src/lib/pricing.ts` is the single source of truth for every figure that reaches an order. |
| 13 | Price authority | **The client never states a price.** The checkout body has no price field at all, and `calculateOrderTotals` computes every total from rows read inside the transaction. A client-supplied `totalAmountPaisa` is dropped by the Zod schema, not merely ignored. |
| 14 | Payment | `OrderStatus` and `PaymentStatus` are **separate enums**: an order is `PENDING` / `PENDING` — not paid, and not dispatched. (The "COD only for the MVP" clause was superseded in Step 18; the two-axis rule stands.) |
| 15 | Stock | Decremented with a **conditional** `updateMany` (`where: { stockQuantity: { gte: qty } }`), never a read-then-write. Two concurrent checkouts cannot sell the same unit. |
| 16 | Checkout atomicity | One Prisma **interactive transaction** covers order creation, item snapshots, stock decrement and cart emptying. Any failure rolls all of it back. |
| 17 | Cart ownership | `Cart.userId` is `@unique`; the cart is found **by user**, never by a client-supplied cart id. Cart lines are scoped to the owning cart, so one customer can never address another's line. |
| 18 | Conflict UX | The cart **warns and still adds** (the customer decides); checkout **refuses** a `BLOCK` conflict unless `confirmConflicts: true`. The asymmetry is deliberate — the platform's job is to make sure the customer knows, not to decide for them. |

### Bugs found and fixed while implementing Step 9

These were found by the Step 9 integration and verification work, not by inspection. Each is now covered by a regression test.

**1. The conflict engine silently no-opped for direct importers.**
`evaluateConflicts(products, rules = [])` defaulted to an *empty* rule set. Any caller importing `src/lib/conflicts/engine` directly — which is exactly what the cart and order services did — got zero conflicts: no error, no warning, and a `BLOCK` rule that simply never fired. On the checkout path that meant telling a customer "no conflicts found" while ordering retinol next to an AHA.
*Fix:* the default is now the platform `CONFLICT_RULES` set, and the production services import the rule-bearing entry point `@/lib/conflict-engine`. An empty rule set must now be requested explicitly.
*Guard:* `tests/conflicts/engine.test.ts` — "the default rule set can never be empty".

**2. The catalogue price filter matched nothing.**
The effective-price filter is two *alternative* price paths — "this product is discounted, match on `discountPricePaisa`" and "this product is not discounted, match on `pricePaisa`". They were combined with `AND`, so a product had to satisfy both at once. No product can, so **every price-filtered query returned an empty catalogue** — with a 200 response and a well-formed body. The worst kind of bug: the customer is simply told the shop has nothing in their price range.
*Fix:* the alternatives are now OR-ed inside a single condition, and every independent filter is collected into a list that is AND-ed together — so a search and a price ceiling narrow the catalogue together instead of one replacing the other.
*Guard:* `tests/integration/catalog.test.ts` — six tests covering the effective price, the inclusive ceiling, the filtered count, and filter combination.

**3. `bdPhoneSchema` rejected the format customers actually type.**
The regex `/^(\+?880)?1[3-9]\d{8}$/` rejected `01712345678` — the single most common format a Bangladeshi customer types — despite its own docstring claiming to accept it. Found in Step 3, surfaced by a Step 9 test.
*Fix:* `/^(?:\+?880|0)?1[3-9]\d{8}$/` plus a transform that normalises every accepted spelling to `+880…`.
*Guard:* `tests/validation/schemas.test.ts` — six spellings must normalise to one value.

**4. The WebP dimension parser read the wrong byte offsets.**
`readWebpDimensions` used offsets 26/28; the correct values are 22/24, after the 3-byte frame tag and the 3-byte `9d 01 2a` start code.
*Guard:* `tests/upload/validate.test.ts` — a correctly-structured 30×30 WebP fixture.

### Ordering rules for `where` clauses

Prisma's `AND` and `OR` keys are single slots, and assigning to `where.OR` twice silently drops the first. Two rules follow:

- **Independent filters** go into a list and are combined with `AND`.
- **Alternative filters** (the two price paths, the two search columns) go into a nested `OR` *inside* one entry of that list.

Putting alternatives in a flat `AND` list is the failure mode that produced bug 2 above.

---

## Step 10 decisions (admin dashboard, review moderation & SMS)

| # | Area | Decision |
|---|------|----------|
| 19 | Audit | One general `AdminAuditLog` table, not per-entity columns. A review can be approved, hidden and re-approved; the *history* of those decisions must survive, and columns would destroy it. |
| 20 | Audit atomicity | The audit entry is written **in the same transaction** as the change it describes. A mutation without an audit trail is worse than no audit trail, because it looks complete. `writeAuditEntry` takes a `TransactionClient` and has deliberately **no** overload that accepts the root `db` client, so an out-of-transaction write is awkward by construction. |
| 21 | Review state | `isApproved` + `isHidden` + `moderatedAt`. `isApproved` alone cannot tell a hidden review from a pending one — both read as "not public". A hidden review was *once* approved, and that history must not be lost. The *who* and the *why* live in the audit log; the row carries only the current state. |
| 22 | Order transitions | An explicit closed table, forward-only. `SHIPPED → CANCELLED` is **not** permitted: the goods have left the warehouse, so a cancellation would be a lie, and the refund is a separate operation. |
| 23 | Stock on cancel | Cancelling restores the reserved stock, because every permitted cancellation is pre-dispatch — the `SHIPPED → CANCELLED` edge is what makes this rule safe. The restoration uses the **snapshotted** quantity from the order line, never a re-derived number. |
| 24 | Payment vs fulfilment | `status` and `paymentStatus` move independently and get separate audit actions. A COD order can be `SHIPPED` while the payment is still `PENDING`, because the cash is collected on delivery. |
| 25 | SMS consent | `User.smsOptIn` is the **only** flag that authorises a send. `UserSkinProfile.smsOptIn` is a different feature's flag and is **not** consulted. **A default is not a decision.** |
| 26 | Reminder due date | `estimatedEmptyAt` is non-null, within a fixed **3-day** lead time, and `reminderSentAt` is null. Estimates are never inferred. |
| 27 | Idempotency | The key is deterministic (`reminder:<orderItemId>`) so a re-run cannot double-send. The manual resend uses a distinct suffix so the admin's instruction is not silently swallowed by the unique constraint from the automated run. |
| 28 | SMS transaction shape | The gateway call sits **between** two transactions, not inside one. A network call inside an open transaction holds a pooled connection for the provider's latency. **A missing log row is recoverable; a double-send is not.** |
| 29 | Admin auth | Every admin route calls `requireAdmin()`. The proxy is a fast filter; the guard is the authority. The guard re-reads the role from the database, so a demoted admin loses access immediately rather than when their token expires. |
| 30 | SMS opt-out copy | No "Reply STOP to opt out" line until the system can honour one. An opt-out instruction that does nothing is a promise the system cannot keep — and a customer who replies STOP has been told their objection was received, and then nothing happens. |
| 31 | Advisor authority | **Code decides, the model phrases.** The provider may only *word* an outcome code has already reached. It never decides whether a conflict exists, never downgrades a severity, never widens the allow-list, and never adds a product code did not offer. |
| 32 | Advisor response validation | A recommended id outside the allow-list is dropped, logged, and replaced with the deterministic set. The provider does not get to widen its own permissions. |
| 33 | Advisor conflicts | The code-decided conflicts are re-attached **after** the provider returns. Whatever the model said about a conflict is discarded. Code wins, always. |
| 34 | The advisor disclaimer | Enforced in four places — the service layer, the message `meta.disclaimerVersion`, the admin route, and a hardcoded fallback that ships even when the database is down. The banner has **no dismiss affordance**. A dismissible disclaimer is decoration. |
| 35 | Disclaimer versioning | `disclaimerVersion` is bumped **only when the text actually changes**. The stamp must keep identifying exactly what the customer was shown; a version that moved on every save would be meaningless. |
| 36 | Advisor conversation ownership | A conversation belongs to exactly one user. Another user's id returns `null`, not a `403` — a `403` would confirm the id is real and leak the existence of other people's conversations. |
| 37 | The advisor's skin type | The advisor **never** infers the skin type. A phrase in a chat message is weaker evidence than a field the customer deliberately set. The advisor may *add* a concern; it may never remove one. |
| 38 | The concern catalogue | A closed list of twelve concerns, shared by the API and the UI. A concern is a **label** used to filter the catalogue and match the conflict engine's ingredient tags — free text would be a value nothing can join on. |
| 39 | The provider call precedes the persistence | The expensive call happens **before** the conversation is written. A provider failure must not leave a conversation with a user message and no answer in it. |
| 40 | The advisor's rate limit | Counted from the database, not from a process-local counter. A process-local counter is reset on every restart and is not shared between instances — which is exactly when a cap is needed. |
| 41 | The profile photo's holder conversation | `AdvisorImage.conversationId` is required, so a photo set before any conversation needs a home. Rather than weakening the schema, the photo lives in a dedicated conversation titled `__profile_photo__`, filtered out of every customer-facing list. |
| 42 | The image join | Images are stored against the **conversation** (the cascade needs that) and referenced by the **message** in `meta.imageId`. A conversation may hold several messages, each with its own photo. |
| 43 | One cart, one owner | The header badge, the drawer and the add-to-cart buttons all read **one** `CartDrawerProvider`. Two components each fetching the cart independently is the classic duplicated-state bug: one is fetched before the other, and the badge says "2" while the drawer says "3". |
| 44 | The server owns the cart | The client sends a *request* — "add this", "set this quantity", "remove this" — and the server answers with the whole cart. The client **never** patches its own copy. A locally-patched cart drifts from the server's view of stock and conflicts, and the customer is shown a cart the server will not honour. |
| 45 | A failed request leaves the cart unchanged | The state is replaced only on success. There is no optimistic update, because an optimistic removal the server rejects leaves the customer looking at a cart that is not real. |
| 46 | The root layout does not read the session | `cookies()` in the root layout makes **every** route request-time, and `next build` then fails: the prerender's `cookies()` call rejects. The cart provider discovers the session on the client instead, from the cart API's own answer — a `401` means signed out, a cart means signed in. The storefront stays prerenderable and the drawer stays correct. |
| 47 | A write under a public prefix is not public | `/api/products` is public so the storefront can browse the catalogue. The prefix also covers `/api/products/{id}/reviews`, which is a **write**. The public-prefix list is kept, and a separate carve-out list removes the write paths. A prefix match alone is not enough. |
| 48 | The carve-out is a pattern, not a literal | The carve-out matches `/api/products/{id}/reviews` and the whole `reviews` subtree. A literal `[id]` would never match a runtime path, and the carve-out would silently do nothing — the worst failure a security control can have, because it looks like it is working. |
| 49 | A submitted review is pending, and the customer is told | `isApproved` is **absent** from both the schema and the insert. The column's default makes the review pending, and the form says "waiting for approval" in those words. A review that vanishes with no explanation is indistinguishable from a bug. |
| 50 | The review body carries no identity and no moderation state | `userId` comes from the session; `isApproved` comes from the database default. The body carries a rating, a comment and nothing else. Zod strips unknown keys, so a client that sends `isApproved` gets it dropped rather than honoured. Two independent barriers, each with a test. |

### Why `UserSkinProfile.smsOptIn` is NOT the consent flag

Both flags default to `false`. Reading `UserSkinProfile.smsOptIn`'s default as an explicit refusal means a customer who opted in at registration and later created a skin profile would **silently stop receiving reminders** — not because they refused, but because a feature they used has an unrelated checkbox that was never asked.

The change looks like a security improvement and is actually a bug. `User.smsOptIn` is the only flag the reminder workflow reads, and the schema comment records this so a future engineer does not "fix" it by adding the profile flag to the gate.

The consent is asserted **inside the claim query's `WHERE` clause**, not checked in application code afterwards. A customer who opts out mid-sweep is still protected: the claim fails and nothing is sent.

### The three ways an admin route can say "no"

An illegal action must be refused *and* explained. A 409 that says only "conflict" is a support ticket; a 409 that names the current state and what would have been allowed is a fix.

| Situation | Status | Body |
|---|---|---|
| The review is not in a state the action applies to | 409 | The current state and the action |
| Another admin moderated the same review first | 409 | "moderated by someone else. Reload and try again." |
| The order cannot move to the requested status | 409 | `currentStatus`, `requestedStatus`, `permittedStatuses` |

In all three cases **nothing is written** — no status change and no audit entry.

### Bugs found and fixed while implementing Step 10

**1. The manual resend's idempotency was a check-then-act.**
The original code asked "does a log row with this key exist?" and, finding none, sent the message. Two admins clicking "resend" at the same moment would both pass the check and both send. Worse, the failure path *inserted* a second row with the same key, so the unique-constraint violation masked the real error.
*Fix:* the key is now **claimed** before the provider is called — the log row is inserted with a provisional `queued` status, and the unique constraint is the arbiter. A second resend loses the insert race and is refused, without the customer receiving two messages. The pre-check remains as a fast path that keeps a normal refusal out of the database log.
*Guard:* `tests/integration/sms-reminders.test.ts` — "refuses a repeated manual resend of the same item" and "the refused resend sent nothing".

**2. `SmsLog` had no `providerMessageId` column.**
The service passed `providerMessageId` to the log writer and Prisma silently dropped it — the field was not in the schema, so the write omitted it. The provider's own reference is exactly what support needs in order to ask the provider what happened to a specific message.
*Fix:* the column was added to the schema and to the Step 10 migration, and the log writer now records it.
*Guard:* the manual-resend path asserts on the reference being written.

**3. The sweep's skip reason was one string for four different causes.**
"Not claimed — already reminded, no longer due, or the customer has not opted in" is true in all four cases and useful in none. An admin reading the report cannot tell a consent outcome from a no-op.
*Fix:* the claim now reports *why* it failed, and the sweep's `details` carry a precise reason per item.
*Guard:* `tests/integration/sms-reminders.test.ts` — the skip reason is asserted for the no-consent and no-phone cases.

### The reminder lead time is a constant, not a setting

`REMINDER_LEAD_TIME_DAYS = 3` is a constant in `src/lib/sms/service.ts`. A setting defaulting to zero would mean "due exactly now", and a sweep run at the wrong moment would silently do nothing — which looks identical to "there is nothing to remind about". That is the Step 9 bug class, and a constant cannot be misconfigured.

---

## Step 11 decisions (admin dashboard, logout & route protection)

| # | Area | Decision |
|---|---|---|
| 51 | Two layers of protection | The **proxy** is the fast filter and the **admin layout** is the authority. The proxy rejects an obvious mistake before a page is rendered; the layout re-reads the role from the database. A control that only works in one layer silently stops working when the other layer changes. |
| 52 | The layout is the authoritative gate | `src/app/admin/layout.tsx` calls `getOptionalUser()` and redirects a non-admin to `/forbidden`. It is a *server* component, so the redirect happens before any admin markup reaches the browser — a customer never sees the dashboard shell, only the shell's queries failing. |
| 53 | The proxy's prefix is anchored to a path segment | `isAdminApiPath` / `isAdminPagePath` match `/api/admin` exactly or `/api/admin/…`, so `/administrator` and `/admin-tools` are **not** the dashboard. Locking a page that has nothing to do with administration would be a bug, not caution. |
| 54 | The proxy's two halves are separate | The API half answers with an error envelope (`403`); the page half answers with a redirect. They cannot be one predicate, because "not JSON" and "not HTML" are different answers. |
| 55 | The admin surface is four pages | Overview, Inventory, Reviews and Orders. The admin nav links to all four, and each page renders the numbers **server-side** rather than fetching its own API over HTTP. A server component fetching from its own application is a network round-trip to itself, and the service is the same code the API route calls, so the two cannot disagree. |
| 56 | The dashboard's zeros are a claim, not a fallback | If `getDashboardStats()` fails, the page renders an error state. It does **not** render zeros. Zero is a claim about the shop; "we could not load the numbers" is a claim about the connection. Conflating them turns a real outage into a false all-clear. |
| 57 | The buttons are derived from the server's tables | The review moderation actions and the order status actions are built from `reviewState` / `permittedOrderTargets` — the same closed tables the services enforce. The admin is never offered a move that will be refused. |
| 58 | The stock adjustment is a **signed delta** | "Add 10" or "remove 3", never "set to 42". A signed delta is commutative, so two admins both adding five compose to "add ten" and neither is lost. An absolute write would clobber whatever a concurrent checkout had already deducted — handing a customer's reserved unit back to the shelf. |
| 59 | The conditional update is not a lock | The `updateMany` matches on the quantity the read observed, so a row changed *between* the read and the write produces a `409` instead of a silent overwrite. It does **not** make two concurrent deltas conflict — they are commutative, and both succeeding is the correct outcome. |
| 60 | A negative stock is refused, not clamped | Silently setting the stock to zero would hide the admin's mistake; refusing it tells them the shelf does not hold that many. A refusal writes nothing at all — no stock change and no audit entry. |
| 61 | The stock bands are not a partition | `IN_STOCK` means **buyable** (`stockQuantity > 0` — the storefront's own predicate), and `LOW_STOCK` is a warning *nested inside* it: a product with three units is both in stock and low. `inStock + outOfStock === total` is the true partition; the three-way sum is not, and `lowStock <= inStock` is the invariant. |
| 62 | The logout clears the cookie with the *same attributes* | A cookie cleared with different attributes is a **different cookie** to the browser, and the original survives. The logout writes an empty value with `maxAge: 0` and the same `httpOnly`, `sameSite` and `path` the session cookie was set with. |
| 63 | Logout is a `POST` | A `GET` logout is a logout a prefetcher or an `<img>` tag can trigger by accident. The route exports `POST` only. |
| 64 | The logout clears the browser's state too | The server clears the cookie; the client calls `reset()` on the cart provider, which drops the cart, the error and the drawer, and returns the session to "not known" (`null`) rather than "known to be signed out" (`false`). A second `reset()` is harmless, and the state does not leak the previous user's cart to the next one. |
| 65 | The logout is idempotent | Logging out twice must not error. The second call clears a cookie that is already gone, which is a no-op, not a failure. |

---

## Step 12 decisions (enterprise admin console, dark mode, analytics & product CRUD)

| # | Area | Decision |
|---|---|---|
| 66 | Dark mode | A **token layer**, not `dark:` on every element. The neutral ramp is split into a **surface/text scale** (`--neutral-50` … `--neutral-700`), which re-points across themes, and a **fill scale** (`--neutral-800`, `--neutral-900`), which stays dark in both. `--color-white` is **never** re-pointed, because `text-white` sits on brand fills where white text is correct in both themes — re-pointing white would put dark-on-dark on every primary button. |
| 67 | Theme storage | `localStorage` + `prefers-color-scheme`, read by a **blocking inline script** in the root layout's `<head>` that sets the class before first paint. **Never a cookie** — decision #46: a cookie read in the root layout breaks `next build`. The `<html>`'s JSX `className` never carries the theme, because React would render `class=""` on the server and `class="dark"` on the client. |
| 68 | Charts | Hand-rolled SVG, matching the codebase's existing hand-rolled-icon decision. Recharts (~90 kB, re-renders on theme change because it resolves colours in JS) and chart.js (canvas — no server-rendered markup, no CSS variables, no accessible DOM) were both rejected. The geometry lives in pure, unit-tested functions in `src/lib/admin/charts.ts`. |
| 69 | Analytics growth | Last 30 days vs the previous 30. `previous === 0 && current > 0` reports **`new`**, never `+100%` — a percentage against a zero base is a lie. |
| 70 | Revenue vs orders | Revenue **excludes** cancelled orders; order **volume includes** them, because an abandoned order is still a demand signal. |
| 71 | Traffic | The traffic source is a **collected** fact, derived from `utmSource` and the referrer host against a closed taxonomy (`facebook` \| `organic` \| `direct` \| `email` \| `other`). It is **never** derived from `PaymentMethod` — `COD \| BKASH \| NAGAD \| CARD` is *how they paid*, not *where they came from*. A "Facebook" slice built from bKash orders would be a fabrication that looks entirely plausible on a dashboard. |
| 72 | Traffic privacy | No IP address, no user agent, no raw referrer URL, no cross-site identifier, no personal data. A pseudonymous first-party visitor id only, in a cookie that is not the user id and not a fingerprint. A 180-day retention window. The dashboard shows an **explicit empty state** until traffic has actually been collected — never four seeded slices. |
| 73 | Product delete | **Archive** is the default delete (`archivedAt`). A hard delete exists only for a product with no order items, no cart items and no reviews, behind a typed confirmation and a mandatory reason. `OrderItem.productId` is `onDelete: Restrict`, and the order line snapshots the product's name and price *precisely so that history survives*. |
| 74 | Archived products | One shared `ACTIVE_PRODUCT_WHERE` helper, applied at all **10 verified storefront query sites across 5 files**. A forgotten filter would **sell an archived product** — the highest-risk bug in the step. `scripts/verify-step12.ts` proves the exclusion by running the real queries. |
| 75 | Archived vs out of stock | They are **different errors**. The checkout's stock decrement is deliberately **not** filtered, because `count === 0` there already means "not enough stock"; conflating the two would tell a customer a withdrawn product is merely sold out. The archived check is a separate read with its own message: *"… is no longer available."* |
| 76 | An archived product in a cart | The line is **kept and marked "no longer available"**, and checkout is blocked. Silently dropping the line would change the total the customer agreed to, with no explanation. The nested select gains `archivedAt` as a **field**, never a filter — a nested `where` on a to-one relation compiles to an inner join and drops the parent row. |
| 77 | Product edit and stock | An Edit form expresses a stock change as a signed `stockDelta`, and it gets its **own** `PRODUCT_STOCK_ADJUSTED` audit entry. A stock adjustment that rode along inside a rename would be invisible in the stock trail. The Edit form never overwrites stock with an absolute value. |
| 78 | Price changes | A price change requires a **mandatory reason**, and the audit entry records the old value, the new value, the actor and the reason — in the same transaction as the change. The `before`/`after` pair carries **only the changed fields**, so the entry reads as a diff rather than as two copies of the row. |
| 79 | Users | **Read-only.** Every mutating admin action in this codebase is audited; an un-audited user-edit path would be the only one, with obvious role-elevation and consent-flip abuse potential. |
| 80 | Settings | AI configuration only, and it **gains** the `AI_CONFIG_UPDATED` audit trail it never had. `disclaimerVersion` is a stamp, not a setting; `LOW_STOCK_THRESHOLD` stays a constant — a setting defaulting to zero would mean "low stock" means "out of stock", which is the Step 9 bug class. |
| 81 | A `P2003` is a conflict, not a crash | `handleApiError` maps Prisma's foreign-key violation to a **409** with a message that names the remedy ("Archive it instead"). Without the branch it falls through to a generic 500, which tells the admin nothing and makes a routine race look like an outage. |
| 82 | The `ARCHIVED` band is a visibility axis | Every other inventory band is a statement about **stock**; `ARCHIVED` is a statement about **visibility**. The two are orthogonal — a product can be archived *and* have ten units on the shelf — so it is reported separately and is not folded into the stock partition. |

## Step 13 decisions (analytics explorer, audit trail & promo management)

| # | Area | Decision |
|---|---|---|
| 83 | The Analytics page | A dedicated page with **live** queries against `db.order` and `db.trafficEvent`: Net Revenue, Total Orders, Store Visits and Visitor-to-Order Conversion Rate. The four figures load and fail **together** — one failed query fails the whole panel, so an admin never sees a metric card with a stale or missing neighbour. The charts load **independently**, because a revenue series and a traffic breakdown fail for unrelated reasons. |
| 84 | Conversion rate | `orders ÷ visits`, and **`null` when there are no visits** — a percentage against a zero base is a division by zero wearing a percentage's clothes. The tile renders "—" rather than `0%`, because "nobody visited, so nobody converted" and "no visits at all" are different facts. |
| 85 | Traffic sources are a collected fact | The donut's buckets come from `TrafficEvent.source`, derived from the real referrer and UTM values against a closed taxonomy. The chart shows an **explicit empty state** until traffic has actually been collected — never four seeded slices. The channel's colour is keyed to its **position in the taxonomy**, not its rank, so Facebook keeps its colour when it drops from first to third. |
| 86 | The audit trail is a read | The trail is already complete and already correct — every mutating admin action writes its entry in the same transaction as the change. The explorer only **reads** it. It does not offer an "undo", because an undo would be a second mutation, and a second mutation needs its own audited entry — and the first one's meaning would be lost. |
| 87 | The trail's three states | **Loaded**, **loaded and empty**, and **failed** are three different things, and the panel renders all three differently. A failed load never renders as an empty list: a trail that says "no activity" because the database was unreachable is a trail that will eventually be believed. |
| 88 | The trail's filters | The action filter is a **closed enum** and the entity-type filter is a closed enum too. An unrecognised value is a **400**, not a default — an admin who filters for something the server does not recognise and gets back an empty list has no way of knowing their filter was ignored. The **page** is more forgiving and ignores an unrecognised filter, because a bad URL should not leave an admin staring at an error page when the fix is to click a different link. |
| 89 | The trail's filter links preserve each other | Every filter chip and every pagination link carries **all four** parameters. A filter link that dropped the other filters would be a trap: an admin who filtered by action and then clicked a different action would lose their entity filter without being told. |
| 90 | Money in a diff | A field whose **name** says money (`pricePaisa`, `amountOffPaisa`, …) is rendered as taka; everything else is rendered as the raw number. The heuristic is the field's name, never the value: a `usageCount` is not money, and both happen to be integers. |
| 91 | A coupon's discount is two columns | `percentOff` and `amountOffPaisa`, one of which is always null. A single `value` column would make "20" mean 20% in one row and ৳20 in another, and the reader would have to know which. Two columns cannot be misread. |
| 92 | A coupon is deactivated, never deleted | A coupon that has been redeemed has **history**. Deleting the row would erase the record of the campaign, and the orders that used it would point at a code that no longer exists. The row stays, the audit entry says it was deactivated, and the redemption count is preserved. |
| 93 | A coupon's terms need a reason | A change to **what the coupon is worth** requires a mandatory reason — it is a price reduction, and "percentOff 10 → 20" with no reason cannot answer "why". Switching a coupon **on or off** is a decision about whether to offer it, not about what it is worth, so it does not need one. The rule lives in the **service**, so every caller gets it. |
| 94 | A coupon's code cannot change | The code is normalised to uppercase on the way in, so "eid2026" and "EID2026" cannot become two coupons. The unique constraint is the real guarantee; the read inside the transaction turns the common case into a clear message. |
| 95 | A coupon's status is derived | Only "switched off" is a stored column. "Expired" and "used up" are facts about the **current time**, so storing them would mean a nightly job updating rows that are already correct by derivation. The status is computed on read, by the same function the API uses — so the badge on the page and the decision at checkout cannot disagree. |
| 96 | The promo panel is a read plus three writes | Create, edit, deactivate. No bulk actions and no delete. A bulk action would move many rows on one click, and each of those rows needs its own audited entry — a bulk action that writes one entry has lost the trail it was supposed to keep. |
| 97 | The entity-type list lives in the validation layer | `AUDIT_ENTITY_TYPES` moved from `src/lib/admin/audit.ts` to `src/lib/validation/admin.ts`, because the admin services import from validation and validation must not import from them. The audit module re-exports it, so there is exactly **one copy** of the list — a second list is a list that will drift. |
| 98 | A coupon's description is nullable, not merely optional | `null` is accepted, not just a string and "absent". The admin form sends `null` for an empty description box, and a coupon with no description is perfectly ordinary — so a schema that accepted only a string would refuse the most common creation there is. |
| 99 | The form's reason rule mirrors the server's | A change to the **usage limit** is a change to what the coupon is worth: the limit decides how many times the discount can be taken. The form's "needs a reason" predicate counts the discount type, the percentage, the amount **and** the limit — exactly the server's rule. A form that asks for a reason the server does not need is an annoyance; a form that does not ask for a reason the server *does* need is a 400 the admin could not have anticipated. |
| 100 | The upload is its own endpoint | The product form uploads files to `POST /api/admin/products/images`, and then posts the product's JSON body — including the returned **keys** — to the existing create and update endpoints. A multipart body on `POST /api/admin/products` would force *every* product create and update through a multipart parser, for a field most of them do not touch. The property this buys: the product row is never written with a file that has not already been validated and stored. |
| 101 | `Product.images` holds keys, not URLs | The column documents it outright — *"Storage adapter keys — NOT raw URLs, so the driver can be swapped."* The uploader returns the key; the URL is derived at render time by `imageUrl()`. The old schema's `.url()` check was **wrong**: it would have rejected every key the upload pipeline produces, and accepted a hand-pasted URL the driver could neither serve nor delete. |
| 102 | The stored filename is generated, never derived | The key is 16 bytes of CSPRNG rendered as 32 hex characters, so spaces, ampersands and non-ASCII characters in the user's filename are a non-issue, and `../../etc/passwd.png` cannot escape the upload root. The extension comes from the **detected** MIME type, not the declared one — the magic bytes are trusted; the `Content-Type` is only ever a cross-check. |
| 103 | A legacy absolute path is normalised, not refused | The seeded catalogue holds the **absolute filesystem path** of the machine that uploaded the file, which rendered as `/uploads/C:\Users\…` — a URL that resolved to nothing, so thirteen products showed their placeholder while the image sat on disk. The path is rewritten to the key it points at: the file has not moved, only the reference is corrected. Because the rewrite happens in the schema, **saving a legacy product repairs it** — no migration script, and no risk of touching a row by mistake. |
| 104 | An absolute path outside our uploads root is refused | `C:\Windows\System32\config.png` is not one of ours. Rewriting it would be a guess, and storing it would produce a URL that resolves to nothing. It needs an explicit drive-letter check, because a Windows path contains no forward slashes and would otherwise slip through the relative-key rule. |
| 105 | Validation is separated from the write | The existing `uploadImage()` helper validates **and** writes in one call, so calling it in a loop writes the first file before the second is checked — and a batch whose fourth file is invalid would leave three orphans on disk. The batch is therefore validated up front and only then written, which is what makes it **all-or-nothing**. A partial write failure deletes what was already written; the cleanup is best-effort, because the original error is the one the admin needs to see. |
| 106 | An image change needs no new audit action | `images` was already one of the `EDITABLE_FIELDS` in `src/lib/admin/catalog.ts`, so `PRODUCT_UPDATED` already carries the image diff, in the same transaction as the change. The `before`/`after` hold the changed fields only, so the log reads "2 images → 1 image" rather than the entire product row — and the audit page renders that list readably rather than as raw JSON. |

## Step 15 decisions (inventory table, brand display & dynamic badges)

| # | Area | Decision |
|---|---|---|
| 107 | The brand is **derived**, not stored | There is **no `Brand` model** in the database — a product is a name, a category and a price, and the brand has always lived inside the name ("CeraVe Hydrating Facial Cleanser"). Adding a `Brand` table, a foreign key, a migration and a seed rewrite would be a large change for a string that is already there. So `src/lib/format/brand.ts` splits the name against a **closed registry** of the brands this shop stocks, longest-match-first. The property this buys: the derivation **never guesses**. "The Ordinary" is never branded "The", and a product whose brand is not registered shows its whole name as the title rather than a wrong brand — an empty cell is honest, "The" is not. |
| 108 | The brand registry is a **closed list**, not a heuristic | The tempting alternative is to split on the first word. It is wrong, and visibly so. So the brand must be a **prefix** of the name, followed by whitespace, matched case-insensitively, and the **longest** registered prefix wins. "CeraVe" must not match "Ceramide Cream", and "CeraVe" must not match "CeraVexfoliant". Adding a brand to the registry is a deliberate act: the entry means "products whose names start with this belong to this brand". |
| 109 | The badge list is the **source of truth** | A product now carries a **list** of badges, and `isNewArrival` / `isBestSeller` are a **mirror** of two entries in it, maintained by `resolveBadges()` in the catalogue service on every write. The alternative — teaching the storefront's product card and PDP about badge lists — would have meant changing the storefront's rendering for a display concern. The mirror means the admin edits **one** thing and the storefront's "New" and "Best Seller" labels follow, with no storefront change. |
| 110 | The legacy booleans **still work** | An older client knows nothing about the badge list, so `isNewArrival` and `isBestSeller` remain accepted on the wire — and they may only ever **add** to the list, never remove from it, because the list is the source of truth. They are now **optional** on the create schema rather than defaulted to `false`: a client that sends only the badge list must not also be made to send a boolean that says the same thing. |
| 111 | "Discount Offer" is **derived, never stored** | Whether a product is discounted is a fact about its two **prices**, and prices change. A stored "Discount Offer" badge on a product whose discount was removed yesterday is a lie the storefront would tell. So the schema **refuses** to store it, and the admin form shows it as a read-only note — the admin can see the product is discounted, but the flag is never theirs to set and stale. The storefront derives the badge from the prices at render time. |
| 112 | A closed set of known badges **plus** free text | The known badges ("New Arrival", "Best Seller", "Discount Offer", "Limited Edition") are offered as checkboxes, so an admin **picks** rather than types, and a typo cannot end up on a storefront. Custom tags are free text, because a closed set alone cannot hold "Eid Special 2026" — and free text alone would put a typo badge on the storefront forever. Neither alone is enough. A custom tag that happens to match a known badge is **canonicalised** into it, so "best seller" becomes "Best Seller" rather than a second spelling. |
| 113 | A badge list **replaces**, it does not merge | An absent list leaves the badges alone; a present list replaces them wholesale. That is what a partial update means everywhere else in the schema — it changes what it names and nothing else — and a badge list that could only grow would make it **impossible to remove a badge**. The admin form only sends the list when it actually changed, so a save that meant to change the price does not also re-send the badges it did not touch — which is how one admin's badge gets reverted by another's price edit. |
| 114 | The badge list is **bounded** | At most twelve badges, each at most forty characters. A badge is a label rendered on a product card, not a sentence — and a product with twenty badges has a badge problem, not a promotional one. |
| 115 | The backfill reads the booleans that already existed | The seeded rows carried the two boolean flags, and some were set. Leaving the badge list empty would **desynchronise** them: the storefront would show "New", the admin form would show nothing, and the first save would clear the flag. So the migration backfills each row's list from its flags — using `ARRAY_REMOVE(..., NULL)`, because a `CASE` with no `ELSE` yields `NULL` and `NULL` is not a valid badge. |
| 116 | The inventory row shows **both** prices | The customer pays the discount price, but an admin judging a discount needs to see what the product was worth before it. A row showing only the effective price cannot answer "is this discounted?" So the row shows the effective price, the struck-through original, and the percentage — the same two numbers the storefront's `Price` component renders, from the same source. |
| 117 | The thumbnail is a **derived** image | The row holds **storage keys**, not URLs, and the URL is computed at render time by `imageUrl()`. So the thumbnail follows the same contract as every other image in the codebase: a row keeps working if the storage driver is swapped for a bucket, and a legacy absolute path is normalised to its key on read. The row's image list is fetched by the existing `ADMIN_PRODUCT_SELECT` — no second query, and no second shape of the same data. |
| 118 | A global audit count is a flaky assertion | The integration suites run in **parallel against one shared database**. A test that counts `PRODUCT_CREATED` entries across the whole table moves whenever another suite creates a product — so it fails for a reason that has nothing to do with the code under test. The assertion is now scoped to the test's **own** run id. Global counts must be asserted relationally, never absolutely. |

### Why the admin reads deliberately do **not** filter archived products

The storefront filter and the admin filter answer different questions, and using the same one for both would break one of them.

The storefront asks *"what is for sale?"* — and an archived product is not. The admin asks *"what does the catalogue contain?"* — and an archived product **is** in the catalogue, withdrawn from sale but retained so the order history survives. An admin who cannot find a withdrawn product cannot restore it, and a product that was archived by mistake would be gone for good.

So `ACTIVE_PRODUCT_WHERE` is applied at the ten **customer-facing** sites and at **none** of the admin ones. The admin inventory list gains an explicit `ARCHIVED` filter and an `archived` count, so withdrawn products are visible *as a category* rather than silently mixed into the live catalogue or — worse — silently hidden.

### Why "delete" is archive, and archive is not reversible by an update

Archiving is a **commercial decision**: it takes a product off sale. So it gets its own audit action, its own typed confirmation, and its own dedicated endpoint. It is deliberately **not** a field on the update schema.

The reason is that `archivedAt` is not a value the admin *sets*; it is a **fact about when the product was withdrawn**. Letting an update write `archivedAt` directly would mean the timestamp could be anything — including a date in the past, which would make the audit entry a lie — and it would blur the difference between "the admin edited the product" and "the admin withdrew the product".

So there are three separate operations, each with its own audit entry:

| Operation | Endpoint | Audit action |
|---|---|---|
| Edit the product's details | `PATCH /api/admin/products/[id]` | `PRODUCT_UPDATED` |
| Withdraw it from sale | `DELETE /api/admin/products/[id]` | `PRODUCT_DELETED` (archive) |
| Put it back on sale | `POST /api/admin/products/[id]/restore` | `PRODUCT_UPDATED` (restore) |

And a fourth, for the rare case where the row genuinely must go:

| Operation | Endpoint | Audit action |
|---|---|---|
| Remove the row entirely | `DELETE /api/admin/products/[id]` with `mode=hard` | `PRODUCT_DELETED` (hard) |

### Why the traffic taxonomy's rule order is fixed and documented

A taxonomy that depends on the order of its rules is only defensible if the order is stated. The order in `src/lib/traffic.ts` is:

1. **A known UTM source wins.** A campaign that says where it came from is stating the channel outright.
2. **Facebook's hosts** — a Facebook link is a Facebook click.
3. **A `mail.` subdomain label** — checked *before* the search rule, because `mail.google.com` and `www.google.com` share a registrable domain and only the subdomain label tells them apart. Without this, every Gmail link would be reported as organic search.
4. **A search engine.**
5. **No referrer at all is direct.**
6. **A mail provider's own domain.**
7. **Everything else is `other`.**

Rules 2–4 are host rules and must come before rule 5, because "no referrer" is not a host. Rule 6 comes *after* the host rules deliberately: a Facebook link clicked from an email client is still, in practice, a Facebook click — but the taxonomy is closed and deterministic, so the order is fixed rather than arguable.

The hosts are matched as **domain suffixes on a label boundary**, never as substrings. A substring match would treat `notgoogle.com` as Google and `facebook.com.example.org` as Facebook — and `facebook.com.example.org` is somebody else's site.

### Why the logout clears the cookie *and* the client state

A logout that does not actually end the session is the worst kind of bug in an authentication system, because it *looks* like it works. The user clicks "Sign out", the app navigates to the login page, and everything appears to be fine — while a valid session token is still sitting in the browser, and the next person to use the device is still signed in.

So the property under test is the **cookie**, not the navigation. The navigation is the browser's job; the cookie is the server's. The four-part contract is:

| Part | Where | What it does |
|---|---|---|
| Clear the cookie | `POST /api/auth/logout` | Empty value, `maxAge: 0`, matching attributes |
| Reset the cart | `CartDrawerProvider.reset()` | Drops the cart, the error, the drawer, and the session flag |
| Refresh the router | `router.refresh()` | Re-renders the server components so the header stops showing the signed-in state |
| Redirect | `router.replace("/login?next=%2F")` | `replace`, not `push`, so Back does not return to a page that now requires a session |

### Why the stock bands overlap on purpose

An operator asks two different questions about the shelf: *"what can a customer buy?"* and *"what needs reordering?"*. `IN_STOCK` answers the first (`stockQuantity > 0`) and `LOW_STOCK` answers the second (`0 < stockQuantity <= 5`). A product with three units belongs to **both** answers — it is buyable *and* it needs reordering.

Making the bands disjoint would mean `IN_STOCK` excluded low-stock products, so the filter chip labelled "In stock" would omit products the customer can actually buy. The filter and the count must use the same shape, so the two would have to agree — and agreeing on a lie is worse than overlapping.

The one band that *is* disjoint is `OUT_OF_STOCK` (`stockQuantity <= 0`), because a product with zero units is not "low", it is "none". That is what makes `inStock + outOfStock === total` a true partition of the catalogue.

### Bugs found and fixed while implementing Step 11

**1. `vitest` was not declared in `package.json`.**
Every test file failed to typecheck with `Cannot find module 'vitest'`. The package had been installed ad-hoc and was pruned by a later `npm install`. The dependency is now declared, so the suite is reproducible from a clean checkout.

**2. `PRODUCT_STOCK_ADJUSTED` was not in the audit action lookup.**
The enum had grown a tenth value, but the `AdminAction` union was built from three action lookups. The type error surfaced in the *consumer* rather than the producer, which is why it took reading the consuming test to find it. `PRODUCT_ACTIONS` now exists, and the audit test asserts that **every** enum value is covered by a lookup — so an action no service can write can no longer be added silently.

**3. The concurrency comment claimed the opposite of what the code does.**
`adjustProductStock`'s doc comment said two concurrent adjustments produce "one winner and one 409". Two diagnostic scripts showed the truth: a signed delta is **commutative**, so both succeed and compose to the correct total. The conditional update only refuses when the row changes *between* the read and the write. The code was right; the comment and the test that encoded the same wrong assumption were both fixed.

**4. The band counts were asserted to be a partition.**
A test asserted `inStock + lowStock + outOfStock === all`. The bands are deliberately nested, so the sum exceeds the total. The service was right; the test asserted a property the design does not have. The corrected test asserts the real invariants: `lowStock <= inStock`, and `inStock + outOfStock === all`.

### The guard rails

| Property | Guard |
|---|---|
| A non-admin never sees the dashboard shell | `src/app/admin/layout.tsx` (server-side redirect) |
| The proxy protects both halves of the admin surface | `tests/validation/proxy-admin-paths.test.ts` |
| `/administrator` is not the dashboard | `tests/validation/proxy-admin-paths.test.ts` |
| The logout clears the cookie with matching attributes | `tests/auth/logout.test.ts` |
| The logout is idempotent | `tests/auth/logout.test.ts` |
| A stock write and its audit entry are atomic | `tests/integration/admin-products.test.ts` |
| A negative result is refused and writes nothing | `tests/integration/admin-products.test.ts` |
| A delta composes with a concurrent change | `tests/integration/admin-products.test.ts` |
| Two concurrent deltas compose rather than overwrite | `tests/integration/admin-products.test.ts` |
| The bands nest correctly | `tests/integration/admin-products.test.ts` |

---

## Step 16 decisions (the stored brand & dual pricing)

| # | Area | Decision |
|---|---|---|
| 119 | The brand is **stored**, and the derivation survives as the fallback | Step 15 decided the brand was *derived* — a closed registry matched against the front of the product's name. That was a good fallback and a bad field: an admin could not correct a wrong brand, could not filter the catalogue by one, and could not enter a brand the registry had never heard of. So `Product.brand` is now a real **nullable column**, and the derivation remains only as the fallback for a row whose brand is null. The two are combined by `displayBrand(storedBrand, productName)` — the **stored** value always wins, because an admin who deliberately set "Bioderma" on a product named "CeraVe Serum" must keep that choice. |
| 120 | The column is **not** a foreign key | There is no `Brand` table. A `Brand` table would mean a second admin CRUD (list, create, rename, merge), a join on every product read, and a migration rewriting every seeded row against a new table — for a label with a closed, known vocabulary. Instead the vocabulary lives in `src/lib/format/brand.ts` and the column is a plain string. The picker's suggestions and the server's accepted values read **the same list**, so they cannot drift. |
| 121 | The canonicalisation lives at the **write**, not only in the schema | The Zod schema folds "cerave" to "CeraVe" so the admin form shows the corrected spelling before the save. But the **service** canonicalises too, because the service is where every path to the database passes — a future caller that bypassed the schema would otherwise be able to store "cerave" on one product and "CeraVe" on another, and the shop would show two brands that look identical. The schema's transform is a convenience; the **guarantee** is in the service. |
| 122 | The product's **name** is left intact | The brand is *additional metadata*, not a replacement for the name. The name feeds the image alt text, the `OrderItem.productName` snapshot that outlives the product, the catalogue search term and the admin's typed delete confirmation. Rewriting it to strip the brand prefix would change the meaning of a column in every consumer, for a display concern. So the name stays whole and the brand is shown on its **own line** — above the title, not inside it, or the card would read "CeraVe CeraVe Hydrating Facial Cleanser". |
| 123 | The backfill **never guesses** | The migration brands a row only when its name begins with a *registered* brand, followed by whitespace. A name like "Ceramide Cream" is left null rather than branded "CeraVe" — the same rule the derivation has always used, applied once at migration time. A nullable column also means the migration needs no default and no second pass. |
| 124 | The brand is **searchable on its own** | The catalogue's search condition now matches the brand column as well as the name and the description. That is the reason the brand became a column rather than staying a derivation: a shopper typing "CeraVe" must find the CeraVe products, including one whose *name* does not begin with the brand. |
| 125 | The brand carousel **derives** from the registry | The home carousel and the filter panel used to carry their own hand-written copy of the brand list, and the two had **already drifted** — the registry knew "Musta Baby" and the carousel did not, so a shopper looking for the baby line could not find it. `BRANDS` is now derived from `KNOWN_BRANDS`, so adding a brand to the vocabulary puts it in the picker, the filter panel and the carousel at once, and there is no second list to forget. The **monograms** stay hand-written, because "La Roche-Posay" → "LR" is a house convention, not a derivation — but a brand with no monogram falls back to its first letters rather than rendering a blank tile. |
| 126 | The two prices are labelled by **which one the customer pays** | The form's fields are "**Regular price**" and "**Discount price**", not "Price" and "Discount price". A form that leaves the admin guessing which one is charged is a form where the two get filled in the wrong way — and on a live product that is a visible, priced error. The form also states the saving in plain words beneath the fields, so the admin sees what the storefront will show before saving. |
| 127 | The discount price is **never silently ignored** | A discount price **higher** than the regular price would make `Price` render the regular price (the discount is only shown when it is lower), so the admin's input would appear to have been discarded. The form says so explicitly rather than saving a value that will not be displayed. A discount price **equal** to the regular price is likewise reported as "no discount is shown". |
| 128 | The seed is **idempotent** | The seed's own header claimed it was "safe to run repeatedly", and it was — until the products were created with `create` rather than looked up first. Every run then doubled the catalogue: nineteen products became thirty-eight and the storefront showed every product twice. The product loop now finds the existing row by name and updates the **catalogue** fields, leaving `stockQuantity` alone — the stock is the shop's live state, not the seed's, and a reseed must not hand a customer's reserved unit back onto the shelf. The brand is one of the updated fields, so a seed that adds a brand column does not need a second migration to backfill it. |

### Why the brand picker is a combobox and not a `<select>`

The brand vocabulary is a **closed list plus a typed escape hatch**. A closed list alone cannot hold a brand the code was written before; free text alone would put "cerave", "CeraVe" and "CERAVE" on three products and the storefront would show all three. Neither alone is enough.

A native `<select>` renders its popup with the operating system's own chrome, which cannot be themed — so it would be the one control on the admin page that ignores the dark mode. And it cannot offer "Add brand" at all. So `src/components/ui/brand-picker.tsx` is a **combobox**: a text input that filters a list of suggestions and accepts a value that is not in the list, with the full ARIA pattern (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`, `role="listbox"`, `role="option"`, `aria-selected`), an outside-click close and an `Escape` close that returns focus to the input.

It matches the house pattern established by `OrderStatusSelect.tsx` (a themed listbox, not a native one) and `ProductBadgeEditor.tsx` (a controlled `value`/`onChange` contract with an `Enter`-to-commit).

### Why the picker's text is derived, not synchronised

The picker's closed-state text **is** the value and its open-state text **is** the query, so there is no separate `draft` state to keep in step. An earlier version held one and synchronised it with an effect; React's `react-hooks/set-state-in-effect` rule correctly flagged it as a cascading render. The fix was to remove the duplication rather than to suppress the rule — the effect was keeping a second copy of something already known.

### Why the canonicalisation is not the derivation's job

`splitBrandAndTitle` answers *"what brand does this name start with?"* — a read-only question about a string. `canonicalBrand` answers *"what is this brand called?"* — a write-time question about a value being stored. They are different questions, and conflating them would mean the derivation could rewrite a stored brand, which is exactly what decision 119 forbids.

### The guard rails

| Property | Guard |
|---|---|
| The brand reaches the database | `tests/integration/product-brand.test.ts`; `scripts/verify-step16.ts` |
| A known brand is stored in its registry spelling | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |
| A custom brand is trimmed and collapsed | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |
| A product with no brand is legitimate | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |
| A price-only edit does not touch the brand | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |
| A stored brand beats the derived one | `tests/format/brand.test.ts`; `verify-step16.ts` |
| The brand is searchable on its own | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |
| The carousel shows exactly the registered brands | `tests/format/brand.test.ts`; `verify-step16.ts` |
| The registry holds no duplicate in any casing | `tests/format/brand.test.ts`; `verify-step16.ts` |
| Every registered brand fits the column | `tests/format/brand.test.ts`; `verify-step16.ts` |
| A blank or over-long brand is refused | `tests/format/brand.test.ts`; `verify-step16.ts` |
| The two prices are stored independently | `scripts/verify-step16.ts` |
| The discount mirror is recomputed from the two prices | `scripts/verify-step16.ts` |
| The audit trail records the brand | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |

---

## Step 17 decisions (dynamic discovery: category, concern & brand imagery)

| # | Area | Decision |
|---|------|----------|
| 129 | The three discovery sections become **database reads** | "Shop By Category", "Shop By Skin Concern" and "Shop By Brand" were decided in code: `CONCERNS` and `BRANDS` were static arrays in `src/lib/format/taxonomy.ts`, and there was no admin surface for any of the three. A concern the admin adds has to appear in the storefront without a code change, so the concerns and the brands became tables (`SkinConcern`, `Brand`), and `Category` gained an image column. The static arrays were **retired, not kept in parallel** — two lists drift, and the drifted one is the one the storefront shows. |
| 130 | `KNOWN_BRANDS` **stays** | Step 16 made `KNOWN_BRANDS` the single source of truth for the brand vocabulary. Retiring it now would undo that. It remains the canonicalisation vocabulary the product path validates against, and it is the seed's source — the `Brand` table is seeded **from** it. So the registry is the *spelling* authority and the table is the *presentation* authority, and they are kept in agreement by canonicalising on write with the same `canonicalBrand` the product path uses. |
| 131 | `Product.brand` stays a plain string | Step 16 deliberately made it a nullable string rather than a foreign key, and that decision stands. The `Brand` table holds *presentation* data — the logo, the monogram, the ordering — and the product still stores the brand **name** it was given. So the product read is unchanged: no join, no extra column, no migration of existing rows. |
| 132 | The **monogram is the fallback**, not a removed feature | The brand carousel documents why it uses monograms: *"There is no brand-logo asset for any of these brands — shipping trademarked logos requires permission, and a storefront that displays them without it is a legal problem."* The shop confirmed: logo upload is supported, and the monogram remains the fallback. A brand with no uploaded logo still renders — it renders its monogram. The section never breaks because an admin has not uploaded anything. |
| 133 | The **shop** is responsible for holding trademark permission | The code cannot verify a licence, so it cannot enforce one. What it can do is make the obligation **visible** where the decision is made: the brand form carries the caveat *"Only upload a logo you have permission to use."*, and the audit trail records who uploaded the logo and when — which is the first half of answering "do we have permission to display this?". Shipping the uploaded logo as the admin's responsibility is a **commercial** decision, recorded here so it is not lost. |
| 134 | The upload is its **own endpoint** | A category's name and slug are JSON; its image is bytes. Bolting `multipart/form-data` onto the create/update routes would force every write through a multipart parser, for a field most of them do not touch. So the flow is: upload → get **keys** → send the keys with the JSON body. The row is therefore never written with a file that has not already been validated and stored. A half-finished upload leaves an orphaned file for the cleanup job; it never leaves a category pointing at a file that does not exist. |
| 135 | The storage key is persisted, **not** a URL | `Category.image`, `SkinConcern.image` and `Brand.logo` hold storage adapter **keys**; `imageUrl()` turns a key into a URL at render time. A URL stored in the column would mean rewriting every row when the driver is swapped — and decision 8 committed the project to a `StorageAdapter` abstraction precisely so the driver *can* be swapped. |
| 136 | The three scopes are **separate directories** | `categories`, `concerns` and `brands` are three allow-listed scopes in `STORAGE_SCOPES`. The scope becomes a directory name under `public/uploads/`, so the allow-list is the path-traversal guard — which is exactly why it stays a fixed list rather than free text. The scopes are separate because the three are managed independently: a brand's logo is replaced far more often than a category's card image, and one scope's cleanup must not sweep another's files. |
| 137 | The upload service is a **generalisation**, not a copy | `src/lib/admin/discovery-images.ts` holds the whole algorithm — validate the whole batch, write each file, delete the written ones if a later write fails. Three near-identical copies of that algorithm would be three places for it to drift. `uploadProductImages` is a thin wrapper over it, so the product path keeps its exact behaviour and its exact error messages. The **batch cap is a parameter**, so the product's twenty images and a discovery entity's one do not impose their limits on each other. |
| 138 | The image is validated by **magic bytes** | The declared `Content-Type` and the filename are both chosen by the sender. `assertValidImage` reads the bytes and decides the type; the declared type is only ever a cross-check, and a mismatch is refused. The stored extension comes from the **detected** type, and the stored name is **generated** — so a file called `../../etc/passwd.png` cannot escape the upload root. |
| 139 | The icon table **decorates**, it does not gate | `CATEGORY_ICONS` stays. A category with no icon entry still renders, with a neutral fallback tile, and a category with no uploaded image falls back to its icon. The rule is the same one the icons were built on: the artwork enhances the catalogue, and it never decides whether a category appears. |
| 140 | A category with products **cannot be deleted** | `Product.categoryId` is `onDelete: Restrict`, so the database refuses the delete anyway. But a bare constraint violation is not an explanation — it does not say how many products are in the way, or what to do about them. So the service counts them first and says *"This category still has 9 products. Move them first."* Cascading would be worse: it would delete the shop's products because somebody tidied up a category. |
| 141 | Deleting a brand **leaves the products alone** | `Product.brand` is a plain string, not a foreign key, so there is nothing to cascade to and nothing that can block the delete. The products that carry the brand name keep it — they simply have no logo to show, because the storefront falls back to the monogram. A brand delete is never destructive to the catalogue. |
| 142 | Every new mutation is **audited** | Nine new `AdminAction` values — `CATEGORY_*`, `CONCERN_*` and `BRAND_*` — each with the same lookup discipline as every other group. The existing test that asserts **every** enum member is covered by a lookup was **extended, not weakened**, so a new action cannot be added without a service that can write it. The audit entry and the mutation share one transaction. |
| 143 | The seed **never writes** an upload | The seed writes the brands and the concerns, but it must not write their `image` / `logo` columns — not on create, and not on update. A seed that reset them would silently wipe the card image of every category the shop has decorated. The seed finds its rows by slug and updates the **catalogue** fields, so a third run does not duplicate them, and the upload columns are left alone on both paths. |
| 144 | A failed storefront query renders an **empty list** | `fetchCategories` already behaved this way, and the new `fetchConcerns` and `fetchBrands` match it exactly: they never throw. A failed concern query must not take the storefront down with it; the section renders an honest empty state instead. |
| 145 | The storefront **streams** the new sections | The home page's three discovery sections sit behind their existing `<Suspense>` boundaries, so the static shell still ships instantly. A slow discovery query delays a section, not the page. |

### Why the brand logo is `object-contain` and the category image is `object-cover`

They are different kinds of picture. A **logo** is artwork on a transparent or flat background, and `cover` crops it to fill the circle — a cropped logo is a broken logo, and "La Roche-Posay" cropped to its middle two letters is not a logo. So the logo is `contain`ed. A **card image** is a photograph, and `cover` fills the tile edge to edge without distorting it, which is what a card wants.

### Why the concern image sits *behind* the label

A concern tile is a chip with a label on it. Putting the image behind the label at low opacity, under a gradient scrim, keeps the label legible over any photograph — a bright image behind 12px text would make the text unreadable, and unreadable text on a discovery tile is worse than no image at all.

### Why the concerns and the brands are **ordered** the way they are

The concerns are ordered by name, because a shopper looking for "Acne" scans alphabetically and the tile grid is the thing they scan. The brands are ordered by `sortOrder` and then by name, because the brand order is a **commercial** decision — which brand the shop wants first in the carousel is the shop's call, not the alphabet's — and the name is only the tiebreaker for two brands the shop ordered the same way.

### Bugs found and fixed while implementing Step 17

**1. The shared upload service imposed the discovery cap on the product upload.**

The generalised service carried `MAX_DISCOVERY_IMAGES = 4` as a constant, and `uploadProductImages` called it. Every product upload of more than four images then failed with *"You can upload at most 4 images at a time."* — a regression in a feature that had shipped and been verified in Step 14. The fix was to make the cap a **parameter** of the shared service (`maxFiles: number = MAX_DISCOVERY_IMAGES`), declare `MAX_PRODUCT_IMAGES = 20` alongside it, and pass it from the product wrapper. One implementation of "validate the batch, write, clean up"; two independent limits. `MAX_PRODUCT_IMAGES` is re-exported from `product-images.ts` so the product path's existing importers keep working.

**2. The three new services had no pagination booleans.**

`coupons.ts` returns `hasNextPage` and `hasPreviousPage`, and the admin pages read them. The three new services returned only `total`, so the pages failed to typecheck with *"Property 'hasPreviousPage' does not exist"*. The fix was to add `totalPages` and both booleans — the pagination shape is a house convention, and a new service that omits half of it breaks every consumer that follows the convention.

**3. The `BRANDS` array was retired but the carousel still imported it.**

`src/lib/format/taxonomy.ts` had `BRANDS`, `CONCERNS`, `BRAND_MONOGRAMS`, `brandSlug()` and `monogramFor()` — all derived from `KNOWN_BRANDS`. Retiring the static vocabularies meant removing all of them, and the carousel, the products page and the filter panel all had to be rewired to the database reads in the same change. Removing the arrays **first** and rewiring **second** would have left the build broken in between; the rewiring and the retirement were done together.

### The guard rails

| Property | Guard |
|---|---|
| An uploaded image reaches the database | `tests/integration/discovery-crud.test.ts`; `tests/integration/discovery.test.ts`; `scripts/verify-step17.ts` |
| The storefront reads the imagery back | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| A missing image reads as `null`, not as absent | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| The monogram survives as the fallback | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| A brand with no logo still renders | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| The image is validated by magic bytes | `tests/admin/discovery-images.test.ts` |
| A renamed `.txt` is rejected, not stored | `tests/admin/discovery-images.test.ts` |
| A batch is all-or-nothing | `tests/admin/discovery-images.test.ts` |
| The product's twenty-image cap is not the discovery's four | `tests/admin/discovery-images.test.ts` |
| Every new mutation is audited | `tests/integration/discovery-crud.test.ts`; `verify-step17.ts` |
| A category with products cannot be deleted | `tests/integration/discovery-crud.test.ts`; `verify-step17.ts` |
| The refusal names the product count | `tests/integration/discovery-crud.test.ts`; `verify-step17.ts` |
| Deleting a brand leaves its products alone | `tests/integration/discovery-crud.test.ts`; `verify-step17.ts` |
| The brand name is canonicalised on write | `tests/integration/discovery-crud.test.ts`; `verify-step17.ts` |
| The registry and the table agree | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| The seed never wipes an upload | `verify-step17.ts` |
| A failed storefront query renders an empty list | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| The audit vocabulary covers every new action | `tests/admin/audit.test.ts` |
| The nav offers the three new sections | `tests/admin/nav-items.test.ts` |

---

## Step 18 decisions (checkout payment methods)

The checkout accepted exactly one payment method — Cash on Delivery — and the
customer was never asked how they intended to pay. The `PaymentMethod` enum
already carried `COD | BKASH | NAGAD | CARD`, so the vocabulary existed and the
UI simply did not use it.

| # | Area | Decision |
|---|------|----------|
| 146 | Four methods, and COD is still the default | `COD`, `BKASH`, `NAGAD` and `CARD` are all selectable at checkout, and `COD` remains the default — it is the platform's primary method and the one most of the shop's customers use (decision #4). The default is the *safe* default, not a restriction: the customer can always switch. |
| 147 | bKash and Nagad stay **separate** | A combined "MOBILE" value would leave the admin unable to tell whose wallet to check. The shop settles each transfer against a specific operator's account, so the operator is part of the fact being recorded, not a display detail. |
| 148 | The radio group, not a row of buttons | The options are native `<input type="radio">` inside a `<fieldset>` with a `<legend>`. That buys arrow-key navigation, screen-reader group semantics and real `checked` state for free. A row of `<button>`s would have to re-implement all three, and would get the focus behaviour wrong. |
| 149 | A mobile-banking order **requires** two references | `paymentSenderNumber` and `paymentTransactionId` are required when — and only when — the method is `BKASH` or `NAGAD`. A transfer that cannot be matched to a merchant statement line cannot be settled, so the order is refused at the door rather than discovered at reconciliation. |
| 150 | A stray reference on a cash or card order is **refused** | Not ignored. A recorded transfer that does not exist is worse than a missing one: the admin would chase a payment that was never made. The schema rejects the combination rather than quietly dropping the field. |
| 151 | The sender number is stored in the **local `01XXXXXXXXX` form** | Deliberately **not** `bdPhoneSchema`, which normalises to `+880XXXXXXXXX`. That is right for a *contact* number — the same person must not be stored two ways — but this field is a **reconciliation key**: the admin looks it up in the bKash or Nagad merchant statement, and those statements list the number as the customer typed it. Storing E.164 would produce a number appearing in *no* statement, defeating the purpose of the column. The schema accepts `+8801712345678`, `8801712345678`, `01712345678` and `1712345678`, and normalises all of them to the local form. |
| 152 | The TrxID is upper-cased | `abc123` and `ABC123` are the same transaction typed two ways. Normalising to one case makes them one value in the database and one key on a reconciliation query. |
| 153 | Every method starts `PENDING` | A customer *telling* us they sent a transfer is not the same as the money having arrived. Marking a mobile-banking order `PAID` at checkout would be a claim the system cannot make — and one the customer could trigger themselves by choosing that method. The admin confirms it against the merchant statement and moves the payment to `PAID`. |
| 154 | The columns are **flat**, not a JSON blob | `paymentSenderNumber` and `paymentTransactionId` are two nullable `VARCHAR` columns rather than a `paymentDetails` JSON. They are queried ("which orders are awaiting a bKash transfer?"), they are indexed in time, and they are typed. A JSON blob would make every reconciliation query a text scan. |
| 155 | The columns are nullable, and there is **no backfill** | Every existing order is a COD order with no transfer references, so `NULL` is the truthful value. The migration adds the columns empty — guessing a reference for an order that never had one would invent data. |
| 156 | The customer's own order page shows the **real** method | The order detail page used to carry a hard-coded *"Cash on delivery. The courier will call you before delivering."* With four methods that would have told a bKash customer they had paid cash on delivery. The method, the sender number and the TrxID are now read from the order, and the payment pill says *"Verifying transfer"* rather than *"Due on delivery"* for a method that is not COD. |
| 157 | The labels live in **one place** | `src/lib/format/payment.ts` maps `BKASH → "bKash"` and `CARD → "Card Payment"`. The customer must never see a raw enum — an order confirmation reading *"Payment method: BKASH"* looks like a database leaked onto the page. The module is client-safe and imports nothing, so a client component can use it without dragging server code into the bundle. |
| 158 | The client sends the transfer details **only** when they apply | The two keys are omitted entirely for a non-mobile-banking order rather than sent as `undefined`. An absent key and a present-but-empty key are different requests, and the server's validation is written against the absent one. |

### Why the fields are validated on the field, not in the transform

A malformed sender number is malformed whichever method was chosen, and a
field-level failure carries the field's **path** — so the API's error mapper can
point at the exact input in the form. Validating it in the `transform` instead
threw a raw `ZodError` out of `safeParse`, which meant a bad number produced a
500 rather than a 422 with a field error. The `superRefine` decides *whether*
the field is required; the field schema decides *whether it is well-formed*.

### Why the two axes stay separate

`paymentStatus` and `status` move independently, and decision #24 still
governs. A bKash order can be `SHIPPED` while the payment is still `PENDING`
— the goods went out before the transfer cleared, which is an ordinary
occurrence in a shop that verifies transfers by hand.

### Bugs found and fixed while implementing Step 18

**1. The order page told every customer they had paid cash on delivery.**

`src/app/orders/[id]/page.tsx` carried a hard-coded *"Cash on delivery. The
courier will call you before delivering."* and a payment pill that read *"Due
on delivery"* for every `PENDING` order. With four methods that is a factual
misstatement to three of them. The fix was to read the method from the order
and let the copy follow it.

**2. The admin order list printed the raw enum.**

`{order.paymentMethod}` rendered `BKASH` in the admin console. The admin is
not the customer, but the raw code in the order row is still the code — and the
console has a label helper for exactly this. Fixed to `paymentMethodLabel`.

**3. The `transform` made the two payment fields required in the output type.**

Spreading the keys unconditionally made `paymentSenderNumber` a required key on
the inferred output — `paymentSenderNumber: undefined` is not the same as the
key being absent — and that broke eight existing call sites that build a
checkout body. The keys are now spread **conditionally**, so a body that does
not mention them produces a result that does not carry them either.

**4. A malformed sender number produced a 500, not a 422.**

The `transform` called `senderNumberSchema.parse(...)`, which **throws**. A
`safeParse` that throws is not a safe parse. The fix was to move the shape
validation onto the field (`senderNumberSchema.optional()`), where a failure is
an ordinary validation issue with a path — and the transform now only handles
the absent case.

**5. The checkout form redirected to the account page instead of the order.**

The form read `result.data.order.id`, but `placeOrder` returns **`orderId`** —
there is no `id` on the response. So the `orderId` was always `undefined`, the
ternary fell through to `/account`, and every customer who placed an order was
sent to their order list instead of their order page. The order was placed
correctly; only the redirect was wrong, which is why no test caught it — the
API's own tests assert the **database**, and the form's redirect is a client
concern.

This was found by driving the real endpoint end-to-end and reading the actual
response shape, rather than by reading the two sides against each other. The
two spellings are close enough that the eye slides over the difference, and
TypeScript could not catch it because the response was typed with an `as`
cast rather than inferred.

The fix was to read `order.orderId`, and to type the cast with the field the
API actually returns.

The durable part is `src/lib/orders/redirect.ts`. The redirect is now
**computed in one place** — `orderConfirmationPath(order)` — and it is
unit-tested against the field name the service returns, so the form does not
spell the id's name out at all. The two sides cannot drift again.

The root cause was that this codebase has **three order shapes**, and they do
not agree on the id's name:

| Shape | Id field | Why |
|---|---|---|
| `placeOrder` (a mutation) | `orderId` | It names the thing it just created. |
| `listOrders` (a read) | `id` | It reads a row. |
| `getOrderById` (a read) | `id` | It reads a row. |

The checkout form picked the **read** shape's name for a **mutation**
response. The test now asserts the distinction at the **type** level
(`"id" extends keyof PlaceOrderResult`), because a value-level check cannot
see it: the old code type-checked fine against a cast response and was
`undefined` at runtime.

### The guard rails

| Property | Guard |
|---|---|
| All four methods are accepted | `tests/validation/commerce.test.ts` |
| An unknown method is refused | `tests/validation/commerce.test.ts` |
| bKash/Nagad require both references | `tests/validation/commerce.test.ts` |
| COD/Card refuse a stray reference | `tests/validation/commerce.test.ts` |
| The sender number normalises to `01XXXXXXXXX` | `tests/validation/commerce.test.ts` |
| The TrxID is upper-cased | `tests/validation/commerce.test.ts` |
| A malformed number is a field error, not a crash | `tests/validation/commerce.test.ts` |
| The absent keys stay absent | `tests/validation/commerce.test.ts` |
| The transfer details reach the database | `tests/integration/orders.test.ts` |
| A cash order stores no transfer details | `tests/integration/orders.test.ts` |
| A mobile-banking order starts `PENDING` | `tests/integration/orders.test.ts` |
| The order page shows the real method | `tests/integration/orders.test.ts` |

---

## Step 19 decisions (the sandbox payment gateway)

Step 18 gave the customer a choice of method. Three of the four methods were
*online* methods, and nothing online happened: `placeOrder` wrote the order with
`paymentStatus: PENDING`, reserved the stock, emptied the cart, and the customer
was redirected to their order page — where they saw a pill reading **"Verifying
transfer"** and waited for a human to confirm a transfer they had been told to
make themselves.

Step 19 makes the online methods *actually online*, with a simulated SSLCommerz
window. The customer places the order, a gateway window opens, they simulate a
success or a failure, and the order is settled.

| # | Area | Decision |
|---|------|----------|
| 159 | The gateway is a **third** order service, not one of the two | `src/lib/orders/service.ts` is the *checkout*; `src/lib/admin/orders.ts` is the *staff desk*. The gateway is a **customer** write path and fits neither: it settles a payment on an order that already exists (not a checkout), and it takes no `AuditActor` and has no `REFUNDED` in its target set (not the staff desk). It lives in `src/lib/payments/gateway.ts`. |
| 160 | The gateway **uses** the transition table, never extends it | `PAYMENT_STATUS_TRANSITIONS` moved to `src/lib/orders/payment-status.ts` so both readers share one definition and neither imports the other. The gateway's only legal write is `PENDING → PAID`, which **already existed**. `FAILED` and `REFUNDED` stay terminal. `tests/admin/order-transitions.test.ts` passes **unchanged** — it is the canary. |
| 161 | A failed attempt leaves the payment **PENDING** | A failed *attempt* is not a failed *payment*. `paymentStatus` answers *"where is the money?"*, and the money is still unresolved — so it stays `PENDING`, the one-shot token stays live, and the customer retries the same order with one click. The failure is recorded as a `PaymentAttempt` row. |
| 162 | A failed attempt does **not** restore the stock | See "The refusal that was actually a bug" below. This is the decision that keeps the shop from selling the same item twice. |
| 163 | The settlement is authorised by a **one-time token** | `Order.paymentGatewaySessionId` holds 32 hex characters from `crypto.randomUUID()`. The settle endpoint requires the token **and** the session cookie **and** a `PENDING` payment. All three live in one `where` clause, so a losing request matches zero rows and is refused without having written anything. |
| 164 | The token is stored in the **clear**, not hashed | A hash is only useful when the plaintext must be re-sent and never needs recovering — the password case, which is what `users.passwordHash` does with bcrypt. This token is used **exactly once**: the settle consumes it and nulls the column in the same transaction that marks the order `PAID`. The security comes from unguessability (128 bits), one-shot use, and the customer-scoped ownership check — not from a digest. `orders.orderNumber` is the codebase's own precedent for a clear, unguessable, human-quotable reference. |
| 165 | The customer, not the admin, settles their own payment | The settle endpoint requires a `CUSTOMER`. An admin signing in gets a 403 — an admin settling a customer's payment is the admin's job, and it has its own audited path (`PATCH /api/admin/orders/[id]/payment`). The two paths must not be conflated. |
| 166 | The gateway's reference is a **separate column** | `paymentGatewayTransactionId` is distinct from `paymentTransactionId`, which is the *customer's* transfer reference. `checkoutSchema` refuses a TrxID on a card order and `placeOrder` writes `null` for `CARD` (decision #150) — putting a server-minted reference in that column would violate the codebase's own rule in the database. For a bKash order **both** columns are populated; the two are different things and the admin must not have to guess which one they are reading. |
| 167 | The gateway's reference is **deterministic** | `${orderNumber}-GW`. A digest would answer *"which session?"* but not *"which payment?"* — and this reference is meant to be read out over the phone by the shop's staff. |
| 168 | A new audit action, because the trail must answer "who?" | `ORDER_PAYMENT_GATEWAY_SETTLED` is distinct from `ORDER_PAYMENT_STATUS_CHANGED`, which records a *staff member's* decision. `AdminAuditLog.actorId` is a plain FK to `User` with no role constraint, so the **customer** is the actor: actor = the customer, action = `ORDER_PAYMENT_GATEWAY_SETTLED`, before = `{paymentStatus: "PENDING"}`, after = `{paymentStatus: "PAID"}`. Reusing the staff action would make a self-service payment indistinguishable from a manual confirmation. |
| 169 | A simulated failure returns **200**, not 4xx | The request was well-formed and correctly authorised; the *payment* failed. A 4xx would leave the client unable to distinguish "the gateway declined" from "your session expired" — and the client's `if (!payload.ok)` branch is reserved for real errors (401/403/404/409). |
| 170 | The **client** never decides whether a gateway session exists | `placeOrder` mints the session iff the method is not COD, and the checkout form opens the window iff the response carries `order.gateway`. One source of truth: the server. |
| 171 | The gateway window shows the **server's** amount | `amountPaisa` comes from `calculateOrderTotals` inside the order transaction. The modal renders it and never computes it. This extends decision #13 ("the client never states a price") to "the client does not compute prices either". |
| 172 | The window **says it is a sandbox** | The buttons read "Simulate Successful Payment" and "Simulate Failed Payment", but a screenshot of the modal in a demo should not be mistaken for a real payment — so the modal says so plainly, in the place the customer will actually read it. |
| 173 | The settle body is **`.strict()`** | Two fields, and a typo in `outcome` — `"success"`, `"CANCELLED"` — should be loud rather than quietly absent. The house checkout schema is not strict, but that schema is a large object where a stray field is harmless; here a stray `amountPaisa` would be a request that could be edited. |
| 174 | The gateway session is created **inside** the order transaction | A session created outside it could exist for an order that rolled back. It is part of the order's creation, and it is `null` for a COD order — there is nothing for a gateway to settle. |
| 175 | "Pay now" on the order page | The customer who closed the tab mid-payment, or whose attempt failed and who wants to try again later, has an order, a live reservation and a `PENDING` payment — and no way back to the window. The order page's "Pay now" button re-arms the session and opens it. It works natively because the order never left `PENDING`. |
| 176 | The bKash/Nagad TrxID is **kept** | `checkoutSchema` still requires the sender number and the TrxID for those methods. Under a *real* SSLCommerz integration the customer would not type one, because the gateway returns it. This step implements the **conservative** version — the customer still quotes their transfer *and* still runs the gateway — because relaxing the schema would supersede decisions #149/#150 and gut the existing reconciliation workflow. **The tension is recorded here rather than hidden.** Relaxing it is a separate decision. |

### The refusal that was actually a bug

The requirement this step was built from asked for **"on failure → order `FAILED`,
stock restored, retry allowed"**. Two of those three clauses are safe. The third
is not, and the reason is in the code rather than in the state machine.

**`FAILED` is terminal.** `PAYMENT_STATUS_TRANSITIONS[FAILED]` is `[]`. A retry
would need a `FAILED → PENDING` path that exists nowhere else, and a special case
inside a closed table is a bug factory — the table would then be wrong for every
other reader, and the admin endpoint would have to *refuse* a transition the
customer endpoint allows, which is an authorisation distinction encoded in a data
structure.

**The stock restoration is guarded only by the order-status transition.**
`changeOrderStatus` restores the stock when the order is `CANCELLED`, and the
code's own comment says why that is safe: *"Because the status update above was
conditional on the current status, two admins cancelling the same order cannot
both restore the stock."* There is **no separate "have I already restored?" flag**.
The status transition is the entire guard.

So "restore the stock on a failed payment, then let the customer retry the same
order" means one of two things: the stock is restored **twice** (the customer
ends up with two units of a product they ordered once), or the stock is restored
and the order retries **without re-reserving it** — and the customer is charged
for goods that may already have been sold to somebody else. That is an
**overselling bug**, not a state-machine nicety.

**The resolution is a reframing: "restore the stock" is a property of *the order
ending*, not of a payment attempt failing.** The codebase already models this
correctly — `changeOrderStatus` restores on `CANCELLED`, and `CANCELLED` means
"this order will not be fulfilled". A failed payment attempt on a still-live
order is not that.

So the three clauses resolve to:

| The clause | What it becomes | Why |
|---|---|---|
| "retry allowed" | **Kept in full** | The order stays live, the reservation stays, the customer retries the same order with one click inside the same window. |
| "order `FAILED`" | → `PENDING` | `paymentStatus` answers *"where is the money?"*. A failed *attempt* is not a failed *payment*. `FAILED` is the terminal answer that means "this money is gone and the order needs a new one" — a simulation button press is not that. The failure is not lost: it is a `PaymentAttempt` row. |
| "stock restored" | → **"stock stays reserved"** | The stock comes back when the **order** ends (`CANCELLED`), which the admin can already trigger today. |

The escape hatch is that nothing was taken away. `PaymentStatus.FAILED` remains
reachable **by the admin** (`changePaymentStatus`), so an admin can still mark a
gateway order's payment failed by hand if the customer gives up, and then cancel
the order to release the stock. And "Pay now" (decision #175) gives the customer
the retry path the requirement asked for — without the table ever needing a
terminal state to become non-terminal.

### Why the audit action is not reused

`ORDER_PAYMENT_STATUS_CHANGED` already existed and would have been the obvious
thing to reuse. It means *"a staff member changed this order's payment status"*,
and the audit trail's whole job is to answer **who did this**. With one value for
both, a customer's self-service payment would be indistinguishable from a staff
member confirming a transfer by hand — and the trail would be answering "an admin
confirmed this payment" for an event where no admin was involved.

`AdminAuditLog.actorId` is a plain foreign key to `User` with **no role
constraint**, so a customer *can* be an audit actor. The trail therefore reads:
*actor = the customer, action = `ORDER_PAYMENT_GATEWAY_SETTLED`, entity = the
order, before = `{paymentStatus: "PENDING"}`, after = `{paymentStatus: "PAID"}`*.

A failed attempt writes the same action, with an `after` of
`{paymentStatus: "PENDING", outcome: "FAILED"}`. It is the same *kind* of event
— the customer used the gateway — and the outcome is recorded in the snapshot
rather than in a second action, so the vocabulary stays small.

### Why the attempt log is a table and not a column

An order can be attempted many times: the customer opens the window, the payment
fails, they try again. The *current* state of the payment is one value (it lives
on `orders.paymentStatus`); the *history* of the attempts is many rows, and a row
of history does not fit in a column.

It is also deliberately **not** the admin audit log. `AdminAuditLog` is the
*staff* trail. The attempt log is the *customer-visible* history of their own
attempts, and it needs its own rows: the audit log records that a gateway event
happened; the attempt log records what the gateway said.

The foreign key to `orders` is `RESTRICT`. The attempts are the evidence that an
order was paid for — deleting them would destroy that evidence while the order
itself survived.

### The guard rails

| Property | Guard |
|---|---|
| Cash on delivery opens no gateway window | `tests/integration/payment-gateway.test.ts` |
| Every online method gets one | `tests/integration/payment-gateway.test.ts` |
| The window shows the server's total | `tests/integration/payment-gateway.test.ts` |
| A success moves the payment to `PAID` and **consumes the token** | `tests/integration/payment-gateway.test.ts` |
| The settlement, the attempt and the audit entry commit together | `tests/integration/payment-gateway.test.ts` |
| The audit actor is the **customer** | `tests/integration/payment-gateway.test.ts` |
| A failed attempt leaves the payment `PENDING` | `tests/integration/payment-gateway.test.ts` |
| A failed attempt does **not** restore the stock | `tests/integration/payment-gateway.test.ts` |
| A failed attempt **can be retried on the same order**, and the stock is restored zero times | `tests/integration/payment-gateway.test.ts` |
| Another customer cannot settle somebody else's order | `tests/integration/payment-gateway.test.ts` |
| A wrong token is refused and leaves **no trace** | `tests/integration/payment-gateway.test.ts` |
| A settled order cannot be settled again | `tests/integration/payment-gateway.test.ts` |
| Two concurrent settles — **exactly one** wins | `tests/integration/payment-gateway.test.ts` |
| A card order's transfer reference stays `null` | `tests/integration/payment-gateway.test.ts` |
| A bKash order keeps **both** references | `tests/integration/payment-gateway.test.ts` |
| The transition table was **not** extended | `tests/admin/order-transitions.test.ts` (unchanged) |
| The gateway methods list cannot drift from the enum | `tests/payments/gateway.test.ts` |
| The settle body is strict and refuses a smuggled amount | `tests/validation/payments.test.ts` |
| The audit vocabulary grew — it was **extended, not weakened** | `tests/admin/audit.test.ts` (`toBe(3)` → `toBe(4)`) |

---

## Step 20 decisions (the tabbed checkout payment UI)

The checkout's payment section was a vertical list of four radio cards. The
reference design asked for a tabbed selection — icon-led cards for the
payment methods, and a card input interface for card payments.

| # | Decision | Why |
|---|---|---|
| 177 | The three tabs are **Cash on Delivery**, **Mobile Banking** and **Card** | The three are the settlement paths the shop actually has. See "Why Net Banking is not a tab". |
| 178 | **Net Banking was dropped** from the reference design | The `PaymentMethod` enum has no such rail. A tab the server cannot settle is worse than no tab. |
| 179 | Mobile Banking is **one tab but two methods** | DECISIONS.md #147 requires bKash and Nagad to stay separate — the shop settles each transfer against a specific operator's account. |
| 180 | The tabs are **real radio inputs**, styled as cards | A decorative tab strip would regress the accessibility the radio group was deliberately built for. |
| 181 | The **card details never leave the browser** | Three independent guards, the third of which is enforced at the boundary. |
| 182 | The card logic lives in **`src/lib/format/card.ts`**, not in the validation layer | `src/lib/format/` is pure and client-safe; `src/lib/validation/` defines what may reach the server. A card number never reaches the server. |
| 183 | The card is validated with the **real Luhn checksum** | A digit counter would accept `4242 4242 4242 4241` — the right shape and the right length, and not a card number at all. |
| 184 | Validation runs **on blur and on submit**, never per keystroke | A field that shouts "invalid" while the customer types the third of sixteen digits is wrong most of the time, and trains the customer to ignore it. |
| 185 | The server **refuses** the card keys outright | The schema is not `.strict()`, so a leaked card field would be **stripped in silence** — no error, no warning, no failing test. |
| 186 | **No new column** was added | A card number must never be persisted. `payment_method` stays `"CARD"` and the gateway's reference lands in `payment_gateway_transaction_id` as it already does. |
| 187 | The expiry check is **inclusive of the current month** | A card expiring this month is still valid until the end of it. Rejecting it would reject a card that works today. |
| 188 | The security code is labelled **CID** for American Express | Amex calls it the CID and prints it on the front; a customer told "CVC" will look on the back, where it is not. |

### Why Net Banking is not a tab

The reference design offered Card, Mobile Banking and Net Banking. Net
Banking was left out, and deliberately so.

The shop's `PaymentMethod` enum has exactly four values: `COD`, `BKASH`,
`NAGAD`, `CARD`. There is no net-banking rail, and adding one would need
an enum migration, a `paymentBankReference` column, a new gateway method,
and a reconciliation path against a bank merchant account the shop does
not have.

**A tab the customer can click and the server cannot settle is worse than
no tab.** The three tabs that remain are the three paths that actually
settle money:

- **Cash on Delivery** — `COD`, collected by the courier at the door.
- **Mobile Banking** — `BKASH` / `NAGAD`, a transfer the customer quotes.
- **Card** — `CARD`, settled through the sandbox gateway.

### The tabs are radio inputs, not a decorative strip

The obvious way to build a tab strip is a `<div>` of buttons that changes
some state. That is exactly the "set of buttons" the selector's own header
warns against, and it would regress behaviour the codebase deliberately
built:

- **Arrow keys move between options.** A radio group does this for free,
  because the browser implements it. A group of `<button>`s does not.
- **A screen reader announces the group and the position.** "Cash on
  Delivery, radio button, 1 of 3" is what a customer using a screen
  reader needs to know. Buttons announce as buttons.
- **The selected state is real.** `checked` is the browser's own notion of
  it, so it survives a form reset, is announced, and participates in the
  form's own semantics.

So each tab card is a `<label>` wrapping a real `<input type="radio">`,
kept focusable and labelled, with the visible card drawn by the `peer`
sibling. The visual layer and the semantic layer are the same thing.

The Mobile Banking operator choice is a **second radio group**, with its
own `<fieldset>` and `<legend>`, so it is announced as its own group
("bKash, radio button, 1 of 2") rather than as a continuation of the
payment method group.

### Why the card details never leave the browser

The checkout renders a card form so the page reads like a real gateway. The
card number, the expiry, the CVC and the holder name are collected,
formatted and validated **in the browser** — and then discarded.

A shop that stores a card number is a shop that has breached PCI DSS. This
shop stores the payment *method* and the gateway's own reference, and
nothing else.

The guarantee is held in **three independent places**, because a
guarantee that depends on one careful line of code is a guarantee one
future edit can remove:

| # | Guard | What it does |
|---|---|---|
| 1 | **State-only** | The values live in React state and are never given a `name` attribute, so they are not part of the form's `FormData`. |
| 2 | **An explicit allow-list** | The request body is assembled from a fixed set of keys that does not mention them. The card state is simply not in scope. |
| 3 | **A server-side refusal** | `checkoutSchema`'s `superRefine` rejects any body carrying a card key, so a leak is a **400** rather than a silent strip. |

The third is the load-bearing one. It is there because of a specific fact
about this schema: **it is not `.strict()`**, so Zod *strips* unknown keys
rather than rejecting them. Without the explicit refusal, a card field
that leaked into the body would be discarded in silence — no error, no
warning, and no failing test. The requirement would then be enforced only
by the discipline of whoever wrote the `JSON.stringify`.

So the boundary refuses it, where it cannot be forgotten:

```ts
for (const key of CARD_DETAIL_KEYS) {
  if (value[key] !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: "Card details are never sent to the server.",
    });
  }
}
```

Note that the check fires only when a key is **present**. A body that
carries no card keys — which is every legitimate body — is unaffected, and
the parsed output the order service reads carries no card properties.

### Where the card gate lives

Because the server never sees the card, **it cannot check it**. So the
*client* gates the order: a card payment with a malformed card number does
not place the order, the submit button is disabled, and the reason is shown
next to it.

This produces a readable field error rather than a server `400` — which is
the right shape of error for a problem only the browser can see.

The gate applies to a card order only. A cash order and a mobile-banking
order are unaffected.

### The card module's place

The card logic — brand detection, formatting, the Luhn checksum, the expiry
rule — is **pure arithmetic on strings**, which makes it a formatting
concern rather than a validation concern. So it lives in
`src/lib/format/card.ts`, alongside seven other modules that import
nothing at all, precisely so a client component can use them without
dragging Zod into the browser bundle.

The rule that governs the file:

> **Nothing there decides whether a payment is valid. It only decides
> whether the card the customer typed looks like a card.**

The real authorisation is the gateway's, and the gateway is a server-side
sandbox.

### The guard rails

| Property | Guard |
|---|---|
| A Visa prefix is recognised, and a `2221`–`2720` Mastercard is too | `tests/format/card.test.ts` |
| An unknown prefix is **`unknown`**, never a guess | `tests/format/card.test.ts` |
| The Luhn check accepts a real card **and rejects a one-digit change** | `tests/format/card.test.ts` |
| A 15-digit Amex number is accepted | `tests/format/card.test.ts` |
| The expiry accepts the **current month** and refuses a past one | `tests/format/card.test.ts` |
| The CVC is 3 digits for Visa and **4 for Amex** | `tests/format/card.test.ts` |
| A card number is **refused** by the schema | `tests/validation/commerce.test.ts` |
| Every one of the four card keys is refused | `tests/validation/commerce.test.ts` |
| A card key is refused **even on a cash order** | `tests/validation/commerce.test.ts` |
| A card key that is present but **empty** is still refused | `tests/validation/commerce.test.ts` |
| A legitimate body parses, and its output carries **no card properties** | `tests/validation/commerce.test.ts` |
| The four-method contract still holds | `tests/validation/commerce.test.ts` |
| The card details are **not** in the request body | the body is an explicit allow-list in `checkout-form.tsx` |
| No card column was added | `prisma/schema.prisma` (unchanged) |

---

## Step 21 decisions (the SSLCommerz-style gateway window)

The payment window was a receipt: a heading, an order summary, two
simulation buttons. The reference design asked for a **gateway** — a
merchant header, a quick-nav row, three horizontal tabs, provider logo
grids, and a bottom bar carrying the exact amount.

| # | Decision | Why |
|---|---|---|
| 189 | The header shows **`session.merchantName`**, not a hard-coded string | `GATEWAY_MERCHANT_NAME` is the one authority. A payment window naming a different merchant is a support ticket. |
| 190 | A **`Sandbox`** chip sits beside the merchant name | The honest thing about a simulation is to say it where the customer reads it. The reference puts its "DEMO" mark in exactly this spot. |
| 191 | The **NET BANKING tab is shown, and nothing in it is selectable** | The customer is not confused by a missing tab, but a tab they can act on and the server cannot settle is worse than no tab. |
| 192 | **Rocket, Upay and Tap are shown, disabled** | The shop recognises them but holds no account to settle against. A customer who pays by Upay should see that Upay is a thing this shop knows. |
| 193 | The **provider grid is inert** — a confirmation, not a control | `settleGatewayPayment` reads the method from the database. See "The reconciliation bug". |
| 194 | The card fields in the CARDS tab are **display-only** | They arrived at checkout and are never sent. Showing them again would be dishonest. |
| 195 | The **PAN is masked to the last four digits** | A full card number in the DOM is a needless exposure for no benefit. |
| 196 | The **CVC is never rendered at all** — not even masked | It is a secret with no use after the authorisation. See "Why the CVC is not rendered". |
| 197 | **Support and FAQ are non-navigating pills**; Offers links to `/products` | A broken link mid-payment is a dead end at the worst possible moment. Discounted prices really do live on `/products`. |
| 198 | The tabs use the **existing `Tabs` primitive**, keyed on the session id | The primitive already implements the WAI-ARIA pattern. See "The tab seed". |
| 199 | The failure simulation is a **low-emphasis ghost link below the bar** | It is a simulation control, not a cancel button. Putting it in the payment bar as a red button would make it look like one. |
| 200 | The **scrim moved after the panel** in the DOM | It is an absolutely-positioned `<button>`. As the first tab stop it would take focus before the window's own content. |
| 201 | The provider tables live in **`src/lib/format/payment-rails.ts`** | Pure, imports nothing, client-safe — and testable without a DOM, because Vitest runs in a `node` environment. |
| 202 | The brand marks are **drawn**, not downloaded | There are no logo assets and the house forbids an icon library. See "Why the marks are drawn". |

### The reconciliation bug — the most important thing in this change

The reference design's provider grid is a **control**: the customer
picks bKash or Nagad and the order follows. In the gateway window that
would be a bug.

`settleGatewayPayment` reads `order.paymentMethod` **from the database**
and never accepts a method from the client. The order row is the record.

So if the modal's grid were a control — if the customer could switch
bKash to Nagad inside the window — the settle would succeed while the
order row still said `BKASH`. The shop would then try to reconcile a
bKash transfer against a Nagad order. That is DECISIONS.md #147 broken in
a new place, and it would fail silently: the payment succeeds, the order
is paid, and the money is in an account the shop did not expect.

So the grid is **inert**. The rail the server recorded is selected and
confirmed; the others are disabled with a visible reason.

Two reasons, because they are different things to the customer:

| Reason | For | Means |
|---|---|---|
| *"This provider is not available for this shop yet."* | Rocket, Upay, Tap, every bank | The shop cannot settle this at all. |
| *"Not the method chosen at checkout."* | The mobile rail the customer did **not** pick | The shop **can** take this payment — just not for this order. |

The second reason is the reconciliation guard, made visible. The
customer can see that the shop recognises Nagad and that their order is
on bKash, and they can understand why the Nagad tile is greyed out.

The `onChange` handler on the radio is **deliberately empty**, with a
comment saying so. A future edit that adds an `onMethodChange` there
would reintroduce the bug.

### The card guarantee, restated

The card details reach the modal as a **prop to a display component**.
They are never included in the settle request.

```ts
body: JSON.stringify({
  sessionId: session.sessionId,
  outcome,
}),
```

Unchanged, and documented in place — the card details are in scope in
that component and are **not** in that object.

Two backstops stand behind it, and both are enforced by the server
rather than by discipline:

| # | Backstop | What it does |
|---|---|---|
| 1 | `gatewaySettleSchema` is **`.strict()`** | A stray card field is a **400**, not a silent transmission. |
| 2 | `checkoutSchema` **refuses** the four card keys | Step 20's guard, unchanged and not weakened. |

### Why the CVC is not rendered

The PAN is masked to the last four digits — enough to tell the customer
*which* card they are paying with, and no more.

The CVC is not rendered **at all**. Not masked, not as dots: absent
from the DOM. It is the three- or four-digit secret printed on the back
of the card, it is never stored, and nothing after the authorisation
needs to read it. The row reports only that a code was entered.

### "No card details on file" is a fact, not an error

The window has **two** call sites. The checkout form has the card
details in state. The "Pay now" button on an existing order does not:
that order was placed in a different session, so the server never had a
card and neither does the browser.

In that case the panel says so honestly — *"No card details on file"* —
and the PAY button still works. It is not an error state. The card was
never part of that order, and the gateway settles the amount regardless.

### The tab seed

`Tabs` seeds its selection with a **one-time** `useState`:

```ts
const [selectedId, setSelectedId] = useState(
  defaultSelectedId ?? items.find((item) => !item.disabled)?.id ?? items[0]?.id ?? "",
);
```

It does not respond to a changed prop. The window is mounted per
session, so `key={session.sessionId}` on the `<Tabs>` element makes the
tab follow the order's method **structurally** — a remount — rather than
by convention. The shared primitive is **not modified**.

### Why the marks are drawn

There are **no logo assets** in the repository, and the house forbids
pulling in an icon library — `src/components/ui/icons.tsx` says why:
bundle size, and no `node_modules` dependency in the client bundle.

So there are three mark *kinds*:

| Kind | Treatment | Why |
|---|---|---|
| **Card networks** | A typographic wordmark pill | A card network's identity *is* its name. An "M" tile identifies nothing, and would tell an Amex customer their card is a Mastercard. |
| **Mobile banking and banks** | A 44×44 rounded tile with the provider's short mark | A tile is what a logo grid *looks like*, and the full name is always present as text beside it. |
| **Mastercard** | Two overlapping circles | The one mark whose geometry genuinely *is* the identity, and it is trivially drawable. |

The Mastercard circles are the one deliberate exception to the
theme-token rule. A network's identity colours are *part of the
identity*, and the theme's rose — the shop's own brand colour — would
make the mark look like bKash's.

These are **derived marks**, not the providers' real logos, and the
window says so with its `Sandbox` chip. A customer must never think they
are paying a real bKash.

### The disabled technique

A disabled radio is removed from the tab order, which is correct. But it
must still be **perceivable**:

- The radio keeps `disabled`, so a screen reader announces the tile as
  unavailable.
- The tile sits at `opacity-60` with `cursor-not-allowed` — never
  `display:none`, which would remove it from the tree entirely.
- The reason is **visible text**, not `sr-only`. A sighted customer must
  be able to *read* why a tile is greyed out; a reason only a screen
  reader can hear is not an explanation.

### The guard rails

| Property | Guard |
|---|---|
| Exactly two mobile rails are available, and they are bKash and Nagad | `tests/format/payment-rails.test.ts` |
| **Every** net-banking rail is unavailable | `tests/format/payment-rails.test.ts` |
| **Every** unavailable rail carries a non-empty reason | `tests/format/payment-rails.test.ts` |
| The non-recorded mobile rail is disabled with the reconciliation reason | `tests/format/payment-rails.test.ts` |
| Every gateway method maps to a tab | `tests/format/payment-rails.test.ts` |
| The settle body is `{ sessionId, outcome }` — no card key | `gatewaySettleSchema` is `.strict()` |
| A settle body carrying a card number is refused | the live check |
| A settle body carrying a client-chosen method is refused | the live check |
| The order row keeps the method it was placed with | the live check |
| A declined payment leaves the order `PENDING` and the stock reserved | the live check |
| The gateway reference lands as `EGB-…-GW` | the live check |
| No new column, no new enum value, no migration | `prisma/schema.prisma` (unchanged) |

---

## Step 22 decisions (the payment details moved into the gateway window)

The checkout page now holds **only** the payment choice. The card fields
and the mobile-banking transfer details are collected in the gateway
window — the modal that opens over the checkout when the customer presses
"Place order".

### #203 — The checkout page selects the method; the gateway window collects the details

The old checkout page rendered the card form or the TrxID fields
inline, directly under the method selection. That is a page that asks
for a payment reference in the wrong place.

The new split:

| Where | What |
|---|---|
| **The checkout page** | The method selection, and nothing else. |
| **The gateway window** | The card details, the sender number, the TrxID. |

This is not a cosmetic arrangement. The gateway window is where the
customer is looking at the merchant, the order and the exact amount they
are about to send — which is the moment they have the bKash or Nagad
confirmation screen in their hand. A TrxID asked for three fields above
the total is a TrxID asked for out of context.

### #204 — The transfer reference is recorded at **settlement**, not at placement

This is the decision that carries the most weight, because it changes the
**server contract**.

The order's `paymentMethod` is fixed at placement — it is the method the
customer chose, and it is the record the shop reconciles against
(DECISIONS.md #147). But the TrxID cannot be collected at placement any
more, because the customer only has it in front of them once the gateway
window opens, which is *after* the order exists.

So:

- The order is created with `paymentSenderNumber` and
  `paymentTransactionId` as **`null`**.
- The **settle** carries the reference, and `settleGatewayPayment` writes
  it onto the order as it marks the order `PAID`.

The order row still ends up carrying a **complete, reconcilable
reference** — the shop matches the transfer against the operator's
statement by the sender number and the TrxID, exactly as before. Only the
*moment* at which the customer is asked has moved.

The alternative — keeping the requirement at placement — would have meant
the customer quoting a TrxID for an order that did not yet exist, on a
page that does not show the amount.

### #205 — The requirement moved with the field, and it moved to the **service**, not the schema

`checkoutSchema` used to require both transfer references for a
mobile-banking order. That requirement now lives in
`settleGatewayPayment`, and it is enforced there because:

- The settle body has **no method** in it, so the schema cannot check
  the conditional. The method is read from the **order row** — the
  record — which is exactly right, because a client-supplied method would
  be a second, editable copy of the truth.
- The order row is where the method *lives*, so the service is the only
  place that can enforce "a mobile-banking order must settle with a
  reference, and a card or cash order must not".

Both halves of the conditional are enforced:

| Rule | Where |
|---|---|
| A mobile-banking order **must** settle with a sender number **and** a TrxID | `settleGatewayPayment` |
| A card or cash order **must not** settle with either | `settleGatewayPayment` |
| The pair must agree with each other (no half a transfer) | `gatewaySettleSchema.superRefine` |

### #206 — The TrxID's upper-casing moved into the shared schema

`transactionIdSchema` validated the TrxID but did not transform it; the
upper-casing lived in `checkoutSchema`'s transform.

That was a latent bug once the reference is quoted at **settlement**:
the settle path used the raw schema and never upper-cased, so the same
TrxID would have been stored under two different keys depending on which
body carried it — and the reconciliation query would have missed half of
them.

The normalisation now lives in `transactionIdSchema` itself. One schema,
one rule, both boundaries. `abc123` and `ABC123` are one value in the
database.

### #207 — The card is typed in the window, checked in the browser, and **never sent**

The card details are now entered in the gateway window — which is where a
real gateway asks for them. They are validated **in the browser** (Luhn,
expiry, CVC length by brand), and they are **not** in the settle request
body.

The PCI guarantee is unchanged, and is now enforced at the boundary the
details actually cross:

- The fields have **no `name`**, so a `FormData` sweep cannot pick them
  up.
- The settle body is an explicit allow-list.
- `gatewaySettleSchema` is `.strict()`, so a stray card field is
  rejected with a **400** rather than quietly transmitted.

A shop that stores a card number has breached PCI DSS. This shop stores
the payment *method* and the gateway's own reference, and nothing else.

### #208 — PAY is gated on the details the method needs, and the reason is visible

A disabled button with no explanation is a dead end — the customer cannot
tell whether the button is broken or what they are missing.

| Method | PAY is enabled when |
|---|---|
| Card | The card number passes Luhn, the expiry is valid and in the future, the CVC length matches the brand, and the holder name is present. |
| bKash / Nagad | The sender number is a valid Bangladeshi mobile number **and** the TrxID is present. |
| Cash on delivery | Always — but no gateway window opens at all. |

The reason is printed under the bar ("Enter your card details to
continue."), and the gate is repeated inside `settle()` — a disabled
button is a courtesy, and a courtesy is not a guarantee.

The gate is **client-side** for the card because the server never sees
the card, so it cannot check it. The gate for a transfer reference is
belt-and-braces: the server enforces it too, because the server is the
only place that knows the order's method.

### #209 — The provider grid stays inert

Unchanged from Step 21, and the reason is unchanged: the grid is a
**confirmation** of the rail the server recorded, not a control over it.
`settleGatewayPayment` reads `order.paymentMethod` from the database and
never accepts a method from the client, so a grid that could switch
bKash→Nagad would let the customer desynchronise the order from its own
record — and the shop would try to reconcile a bKash transfer against a
Nagad order.

### #210 — `payment-card-preview.tsx` was deleted

It rendered a masked summary of a card that had been typed **elsewhere**.
With the card typed in the window, there is nothing to preview — and the
masking concern it embodied (a full PAN in the DOM) is now handled by the
fact that the number is never rendered twice at all.

### The guard rails

| Property | Guard |
|---|---|
| The checkout page collects **no** payment details | `checkout-form.tsx`; the selector's props are `{ value, onChange }` |
| A mobile-banking order settles **only** with a transfer reference | `tests/integration/payment-gateway.test.ts`; the live check |
| A card or cash order settles **only** without one | `tests/integration/payment-gateway.test.ts`; the live check |
| Half a transfer is refused, at the schema and the service | `tests/validation/payments.test.ts` |
| The transfer reference lands on the order as it settles | `tests/integration/payment-gateway.test.ts`; the live check |
| The TrxID is stored upper-cased, at **both** boundaries | `tests/commerce/payment-transfer.test.ts` |
| The settle body carries **no** card key | `gatewaySettleSchema` is `.strict()`; the live check |
| The settle body carries **no** client-chosen method | `gatewaySettleSchema` is `.strict()`; the live check |
| The order row keeps the method it was placed with | the live check |
| A declined payment leaves the order `PENDING` and the stock reserved | the live check |
| No new column, no new enum value, no migration | `prisma/schema.prisma` (unchanged) |

---

## The AI Advisor

The advisor is the storefront's skincare adviser: a customer describes their
skin (or attaches a photo), and gets product suggestions that fit their
routine — with ingredient conflicts flagged when two things should not be
used together.

### The rule that governs the whole feature

**Code decides, the model phrases.** Every decision the customer sees —
which product, whether a conflict exists, how severe it is — is decided by
code. The provider may only *word* the outcome.

It is defended in three layers:

1. **The candidate list is built in code.** Only in-stock, admin-allowed
   products that survive the conflict engine reach the provider.
2. **The provider's output is validated.** A recommended id outside the
   allow-list is dropped, logged, and replaced with the deterministic set.
3. **The conflicts are re-attached after the call.** Whatever the provider
   said about conflicts is discarded.

Layer 3 is the one that matters most, and it is easy to get wrong in a
subtle way. If the provider's conflicts were merged with the engine's, a
provider that *denied* a conflict would still leave the engine's conflict
in place — but a provider that *added* one would introduce a conflict the
engine never found. The engine's list is the list. Full stop.

### The disclaimer has no dismiss affordance

The disclaimer is a product requirement (PRD §3.A) and the spec makes it
non-disableable by design. It is enforced in four places:

| Where | What it does |
|---|---|
| `src/lib/ai/disclaimer.ts` | The hardcoded fallback. It ships even if the database is down. |
| `src/lib/ai/service.ts` | Attaches a disclaimer to every response, unconditionally. |
| `src/app/api/advisor/chat/route.ts` | Records the version on the message's `meta`. |
| `src/app/api/admin/advisor/config/route.ts` | Rejects an empty disclaimer with a `400`. |

**The banner has no close button.** This is the most likely future
"improvement" to the advisor screen, because dismissible banners feel more
polished. It would break a compliance requirement while looking like a UX
win. The absence of any dismissal affordance is deliberate and should be
preserved.

The version stamp is bumped **only when the text actually changes**. A
version that moved on every save would be meaningless — the stamp exists
to answer "which disclaimer was this customer shown?".

### The advisor never sets the skin type

The advisor may *add* a concern the customer raised. It may never remove
one, and it may never change the skin type. A phrase in a chat message is
weaker evidence than a field the customer deliberately set, so the
deliberate field wins.

The *form* replaces the list — unchecking a box must remove it — while the
*chat* only adds. The two never fight, because the chat route never
removes and the form route never adds.

### Concerns are a closed catalogue

Twelve concerns, shared by the API and the UI. A concern is a **label**
used to filter the catalogue, to match against the conflict engine's
ingredient tags, and to group reviews. All three need a shared
vocabulary: "dullness", "dull" and "looking dull" must resolve to the same
thing, or the filter silently returns nothing.

Free text would also let a customer store an unbounded string in a column
that other code queries with an `in` filter — a value nothing can ever
match. A closed list makes the vocabulary explicit, and a concern that is
not on the list is a validation error rather than a dead row.

### The provider call precedes the persistence

The provider call is the expensive step, and it happens **before** the
conversation is written. A provider failure must not leave a conversation
with a user message and no answer in it.

### The rate limit is counted, not assumed

The advisor is a paid call to a model provider. The count comes from the
database rather than a process-local counter, so it holds across every
instance of the deployment. A process-local counter would be reset on
every restart and would not be shared between instances — which is exactly
when a cap is needed.

### The profile photo's holder conversation

`AdvisorImage.conversationId` is required, so a photo set before any
conversation exists needs a home. The two obvious alternatives were both
worse than a sentinel:

- Making the column nullable would break the cascade for every *other*
  image — a deleted conversation would leave orphaned rows behind.
- Adding a boolean `isInternal` column would mean every conversation
  query has to remember to exclude it. A query that forgets produces a
  phantom conversation in the customer's history.

So the photo lives in a dedicated conversation titled `__profile_photo__`,
reused across swaps, and it is filtered out of every customer-facing list
in one place.

### Bugs found and fixed while implementing the advisor

**1. The conversation loader returned the raw Prisma `MessageRole`.**
The `MessageRole` enum has three values — `USER`, `ASSISTANT`, `SYSTEM` —
but the client type declared only two. The map was assigning the Prisma
enum straight onto a narrower type, which TypeScript rejected. The
narrowing now happens explicitly in the service, with a comment saying
why: the advisor only ever writes `USER` and `ASSISTANT` rows, but the
database *could* hold a third value, and pretending otherwise would be a
lie about the schema.

**2. The images were loaded and then thrown away.**
The conversation detail query selected the conversation's images and
built a lookup map — and then returned `images: []` for every message. The
map was dead code, and the lint rule caught it. The real problem was
underneath: there was no join between a message and its attachment. The
images are stored against the conversation (the cascade needs that) and
now referenced by the message in `meta.imageId`, with the meta being the
join. A conversation may hold several messages, each with its own photo,
so "the conversation's images" was never the right answer to "this
message's images".

**3. The profile-photo route could not create an image.**
`AdvisorImage.conversationId` is required. The first draft of the route
tried to create the image with an empty conversation id — a value the
schema accepted as a string and the database rejected as a foreign key.
The fix was the holder conversation described above, not a looser schema.

**4. A `const` read before its declaration.**
The advisor page built the concern labels from a `CONCERN_TEXT` map
declared *below* it. Under `const`, that is a temporal dead zone — and it
failed at **build time** as "Failed to collect page data for /advisor",
with the actual cause four files away from the message. The declaration
order is now correct, and the comment says why, because the same mistake
will be made again otherwise.

### The guard rails

| Property | Guard |
|---|---|
| Another user's conversation is never returned | `tests/integration/advisor.test.ts`; `scripts/verify-advisor.ts` |
| The disclaimer is always attached | `tests/ai/disclaimer.test.ts`; `verify-advisor.ts` |
| A whitespace-only config falls back to the hardcoded text | `verify-advisor.ts` |
| An invented product id is dropped | `tests/ai/service.test.ts`; `verify-advisor.ts` |
| A provider cannot talk the engine's conflicts out of the response | `verify-advisor.ts` |
| The skin type survives a turn | `verify-advisor.ts` |
| An out-of-stock product is never recommended | `verify-advisor.ts` |
| The message cap and the rate limit are enforced | `tests/validation/advisor.test.ts`; the live check |
| A text file claiming to be a PNG is rejected | the live check (magic bytes, not the declared type) |

---

## The advisor's conflict-warning gate and its transcript

Two defects in the advisor chat, both of which a customer would describe as
"the advisor is broken". Fixed together because they share a cause: **a
decision that belongs in code was being made somewhere it could drift.**

### The conflict warning is a decision, not a rendering detail

The engine's conflict list is built from the customer's **cart** plus the
candidate set. It is therefore *identical on every turn*. A customer with a
retinol in their cart saw the retinol warning under every reply — under
"Hi", under "how long does delivery take?", under "I had a rough day at
work".

That is not a cosmetic problem. A warning that appears on every turn stops
being advice and becomes noise the customer learns to skip. And the panel
that carries it — the amber **"Use with care"** card — is the most alarming
piece of UI on the page, so it is the last thing that should be firing
unbidden.

So the question "may this turn carry a conflict warning?" is answered in
code, in `src/lib/ai/intent.ts`, and carried on the intent as `mayWarn`.

**`mayWarn` is deliberately not the same flag as `mayRecommend`.** The two
ask different questions. `mayRecommend` asks "may this turn put products in
front of the customer?"; `mayWarn` asks "is there a routine here for a
conflict to be about?". A question like *"how do I use retinol?"* is worth
answering with a product and is **not** worth answering with a warning. A
question like *"can I use this with my sunscreen?"* is a question whose
**answer** is a conflict.

The rule that falls out:

| Turn | `mayRecommend` | `mayWarn` |
|---|---|---|
| Greeting | no | no |
| Concern — the customer described their skin | yes | **yes** |
| Order question | no | no |
| Question — plain | yes | no |
| Question — about combining products | yes | **yes** |

### The prompt and the response are gated together

Suppressing the *card* is not enough. The prompt tells the model to warn
about the conflicts it is given, and to say plainly that a blocked product
does not suit the routine. Handing the model the conflict list on a
greeting therefore produces a **prose** warning even when the card is
suppressed — the customer still reads "you already have a retinoid in your
routine" under "Hi", just in a different font.

So both halves are gated on `mayWarn`:

- `src/lib/ai/service.ts` — the request carries `conflicts: []` on a
  non-warning turn, and the response's `conflicts` array is empty.
- `src/lib/ai/openai-compatible.ts` and `src/lib/ai/gemini-provider.ts` —
  the brief's conflict section is headed "not relevant to this turn" rather
  than listing the rules, and the intent note states whether warnings are
  allowed.

The gate is applied **where the provider's output is validated**, so no
provider and no UI can widen it. `mayWarn` is also recorded on the message's
`meta`, so an auditor can see which turns were allowed to warn.

### Why the prepositions needed a product word

The first version of the combination detector matched `"with my"` and
`"with the"`. Both are ordinary English:

- "I am **with my** family" — not a question about a routine.
- "thank you **with the** help" — not a question about a routine.

So a linking preposition now only counts when a **product or ingredient
word** appears alongside it. A message that names the act of combining
outright — "layer", "combine", "together" — needs no such companion,
because those words only appear when the customer is talking about using
things together.

The same class of mistake was found in the concern keywords: a bare
`"rough"` matched *"I had a **rough** day at work"*. The skin complaint is
"rough skin", and the keyword list now says so.

### The customer's message is never removed by a successful turn

Two defects in the chat's `messages` array, both of which made the
customer's own words disappear:

**The optimistic bubble was deleted on success.** The success path filtered
the customer's message out and appended the reply in its place. The customer
typed "my skin is oily", pressed send, and watched their own message vanish
the moment the advisor answered. The server persists it; the server is not
what the customer is looking at.

**The pending bubble was orphaned.** The "thinking" bubble had its own id,
but the success path filtered on the *customer's* id, so the bubble stayed
on screen for the rest of the conversation — permanently thinking.

Both are fixed by addressing each bubble **by its own id**: the customer's
message stays and the answer is appended after it; the pending bubble is
removed by the pending id on both the success and the failure path. A
*failed* turn does remove the customer's message, because that message was
never sent.

### The transcript mutations live outside the component

The mutations live in `src/lib/ai/transcript.ts` as pure functions over a
plain array, rather than inside `setMessages` callbacks in the component.

The reason is testability. Testing them where they were meant mounting a
component, which meant a DOM, which meant a test stack this project does
not have. As pure functions they are asserted directly — and because there
is only one copy of the logic, the behaviour under test is the behaviour
that ships.

### Switching conversations resets the transcript by remounting

`useState` reads its initial value on the **first** render only. A
component that is *reconciled* against new props keeps the old
conversation's messages on screen under the new one's title.

The fix is a `key` on `<AdvisorChat>` in `page.tsx`, set to the conversation
id. A different conversation therefore **mounts a different component
instance** with the new transcript.

A `key` is used rather than an effect that resets the state, for two
reasons. An effect that calls `setState` synchronously causes a cascading
render (the project's own lint rule rejects it). And the remount is what
makes the reset *complete*: the draft, the attachment, the error and the
pending flag all reset with the transcript, without any of them having to
be listed and kept in step.

### The guard rails

| Property | Guard |
|---|---|
| A greeting never carries a conflict warning | `tests/ai/intent.test.ts`; `tests/integration/advisor.test.ts` |
| A casual, non-skincare message never carries a conflict warning | `tests/ai/intent.test.ts`; `tests/integration/advisor.test.ts` |
| A question about combining products **does** carry one | `tests/ai/intent.test.ts`; `tests/integration/advisor.test.ts` |
| The conflict list is not handed to the model on a non-warning turn | `tests/ai/openrouter-provider.test.ts` |
| The gate is recorded on the message's meta | `tests/integration/advisor.test.ts` |
| The customer's message survives a successful turn | `tests/ai/transcript.test.ts` |
| The pending bubble is removed on success **and** on failure | `tests/ai/transcript.test.ts` |
| A preposition alone does not make a turn a warning turn | `tests/ai/intent.test.ts` |

---

## Storefront refinement decisions (the home page)

A pass over the home page — hero, brands, product grids, vertical rhythm.
These are decisions of the same kind as the ones above: they constrain
how the storefront is built, so they are recorded here rather than only
in the comments of the files that implement them.

### 23. The hero's mockups are resolved from the catalogue, never hard-coded

The hero shows real product photography. That photography lives in the
database, behind the storage adapter, and `public/uploads/` is **not
committed** — so a literal `/uploads/products/…` path in source would
resolve on the machine that happens to hold the uploads and 404
everywhere else.

So each slide declares *how to find* its mockup — a brand, a category, a
count — and the server resolves it against the catalogue at request
time. Three consequences follow:

- **A slide's mockup can be empty.** Not every product has been
  photographed. A slide with no resolvable photograph renders its copy
  alone; it never renders a broken image and never takes the page down.
- **The mockup is built from the shop's own photography.** It is the
  thing being sold, so it is the best available proof.
- **A failure is swallowed, per slide.** The other three slides still
  resolve. A hero that shows three campaigns is a less impressive page
  rather than a broken one.

### 24. The slide definitions live in a directive-free module

The slider is a `"use client"` component, and a server component may
only import **components** from a client module — not plain data. If the
slide definitions lived in `hero-slider.tsx`, the home page could not
read them in order to resolve each slide's media.

So the definitions live in `src/components/home/hero-slides.ts`, a module
with **no directive**, and both sides import it: the server to build the
slides the page renders, and the client slider to fall back to them when
it is rendered without media.

### 25. A single-product mockup names the product itself; a group carries an editorial caption

A mockup that names the wrong bottle is worse than no mockup at all — the
shopper can see through it. So:

- A **single-product** mockup shows the product's **own name and price**,
  read from the catalogue. There is no hand-written caption, and so no
  caption that can drift away from the product it sits under.
- A **group** mockup carries an editorial caption ("a three-step
  routine, checked for conflicts"), because the point of a group is the
  *set*. A caption that named one of the three would be a caption about
  a bottle that is not the subject of the picture.

`HeroMedia.caption` is therefore **optional**, and is only ever present
on a group.

### 26. The hero is two columns, and the media column yields first

The hero used to be a single column of copy on a gradient — handsome and
empty. A skincare shop's hero with no skincare in it is a promise, not a
product shot.

So the panel is split: the **copy** on the left, the **product** on the
right, on its own raised plate. The split is a **grid** with
`minmax(0, 1fr)` and `minmax(0, 0.85fr)` — not a fixed half — so the
copy keeps a readable measure and the media yields first when the panel
narrows. On a phone the columns stack.

### 27. Vertical rhythm is structural, not patched with negative margins

Section spacing is normalised by a single `space-y` scale on the page
container. Every section is a **sibling** of the others, each with its
own heading and its own margin below it, and no section is nested
inside another or pulled up with a negative margin.

A negative margin is a lie about the spacing — it cancels one gap by
opening another, and the two fight whenever either scale changes. And
nesting New Arrivals inside Best Sellers was a false statement about the
two grids: they are separately merchandised shelves, each with its own
heading and its own identity, and a shopper scanning for "what is new"
should not have to read past a "best sellers" heading to find it.

The boundary between two sections is drawn by the **hairline** above each
heading (`SectionHeading`), not by a trough of whitespace. Whitespace is
the space *inside* a section; the rule is the *edge* of one.

**The scale is tight — and tightness is what makes the rule necessary.**
`space-y-10` on a phone, `lg:space-y-12` on a desktop, with the heading's
own top padding at 16–20px and the gap below it at 20px.

A boutique storefront is a *continuous editorial page*, not a stack of
air-separated blocks. On a long page the whitespace compounds: by the
fifth section a shopper has scrolled through four troughs of nothing, and
the page stops feeling like a shop and starts feeling like a menu.

So the spacing is compressed — and the **hairline** is what keeps a
compressed page from reading as one undifferentiated list. Tight spacing
plus a drawn rule says "these are separate sections"; tight spacing alone
says "this is one long list". The rule carries the structure, so the
whitespace does not have to.

This is also why the footer's margin above it was cut from 80px to 48px.
The footer is a dark band against a pale page, so the colour change
*already* marks the end of the content; a large white gap above it would
say "the page stopped" a second time, more slowly, and leave a dead
band between the last section and the footer.

### 28. The product card's action button keeps its full label on one line

The button reads **"Add to Cart"** with a shopping bag icon, at every
width — not "Add" with a plus sign. The shopping bag is the icon the
European beauty trade actually uses; a plus sign reads as *more*, not as
*purchasing*.

The label is allowed to **shorten** on the smallest screens ("Add") so it
never wraps, but it is never shortened on the widths where the card has
room for it. The card's price and button sit on one baseline, and the
button is `whitespace-nowrap` — a wrapped label changes the button's
height and breaks the grid's shared baseline.

The `card` button and price sizes exist for this: the grid needs a size
that fits the full label beside a price at 1280px and still fits at
360px.

### 29. A brand is a nameplate, not a thumbnail and not a badge

The Featured Brands section renders each brand as a **wide rectangular
nameplate**: a square well holding the logo on the left, and the brand's
name set as type on the right.

The section has been through two other shapes. It began as a row of
**circular badges** — a mark in a circle with the name as a caption
underneath. That is an *avatar*, and it is unreadable: at 56–64px you
cannot tell CeraVe from Vichy from La Roche-Posay, because the
difference between them *is* the wordmark. A trust signal nobody can
read is not a trust signal.

It then became a **plate** — a tall square tile per brand, which fixed
the size but not the *shape*. A circle is a bad frame for a logo, which
is a rectangle; and a square tile with the name beneath it is still a
picture with a caption, not a label.

A **wide card** solves both. The logo gets a square well sized to
contain it honestly, and the name gets its own column, set in the
page's serif, uppercase and tracked — the convention a European
pharmacy label uses. The card reads as a house's *nameplate* rather
than as a product tile.

**The card is flat.** A hairline border and nothing else — no shadow, no
raised surface, no fill darker than the page. A boutique nameplate is
*printed*, not *mounted*. The moment the brand grid gets the same
shadowed white panel the product grid has, the section stops being "the
houses we stock" and becomes "a fourth grid of tiles", and the page
loses its structure. The shadow arrives on hover, which reads as
*picking the card up*.

Logos use `object-contain` (never `object-cover`): a wordmark cropped to
fill a square loses its edges, and a cropped wordmark is a wrong logo.
A brand with no logo falls back to its **monogram** — never to a broken
image.

The padding belongs to the **well**, and the image carries only a hair.
Padding both stacks two insets and shrinks the mark by roughly a
quarter — which is precisely wrong for a section whose only job is
recognition.

### 29a. The nameplate carries the brand's *size*, not just its name

Under the name is the **real count of sellable products** — the same
"42 products" signal the category grid gives.

A nameplate with a logo and no count says "the shop carries this
brand"; it does not say whether there is one product of it or twenty.
The count is what makes the card informative rather than decorative,
and it is the difference between a section that merchandises and one
that decorates.

The count is a **filtered** count — it excludes archived products,
because a count that tells a shopper the shop carries something it will
not sell is worse than no count at all. This is the same rule the
category grid's count obeys, and it is the reason the count is built on
`ACTIVE_PRODUCT_WHERE` rather than on a raw count.

`Product.brand` is a plain string and not a relation, so Prisma cannot
count it for us — there is no `_count` to ask for. The count is a
`groupBy` over the products' `brand` column, merged in memory with the
brand rows. The two join on the exact string because the brand rows hold
the canonical spelling.

When the admin has written a **description**, it replaces the count —
an admin who wrote a line meant it to be read.

### 30. The seed never writes an upload, so linking a photo is safe

`prisma/seed.ts` creates a product with `images: []` and its update path
(`catalogueFields`) deliberately **does not include** `images`. So a
photograph linked to a product survives a reseed, and a reseed cannot
overwrite one with a blank.

### 31. The home page's section order is a merchandising decision

The order is fixed and deliberate:

    Hero → Top Categories → Shop By Skin Concern
         → New Arrivals → Best Sellers → Featured Brands
         → AI Skin Care Advisor

Each step answers a different question, and the questions come in the
order a shopper asks them.

**Hero** — what is this shop? **Top Categories** — what does it sell?
**Skin Concern** — which of those is *mine*? **New Arrivals** — what is
new? **Best Sellers** — what do other people trust? **Featured Brands**
— whose is it? **Advisor** — none of the above answered it, so let the
shop work it out.

The order is not arbitrary, but it is also not a rule. It is a
**sequence**, and the only constraint is that the advisor must be last —
it is the fallback, and a fallback that sits in the middle of a page
interrupts a decision the shopper was making.

The advisor is a full **section**, not a strip. A strip says "there is
more"; a section says "here is what it does, in three steps, and here
is the button." It is the last thing before the footer, so it is the
last thing the shopper sees on their way out.

### 32. The hero's mockup plate is large, because the hero is the shop's product shot

The plate grew from `max-w-sm` with 12–16px padding to `max-w-md`/`lg:max-w-lg`
with 16–24px padding, and the tile's own padding grew with it.

A bottle rendered small in the corner of a hero reads as an
**illustration**; a bottle rendered large reads as *the product being
offered*. The hero is the one place on the page where the photography is
the argument, and an argument made small is not made.

The padding grows with the plate rather than the photograph growing
inside a fixed plate, because the padding **is** the gap between the
product and its edge — and that gap is part of the composition. A
product that touches the frame is cropped, and a cropped product reads
as damaged rather than as close-up.


### 33. A collapsed admin rail narrows; it never hides the label

The admin sidebar has two widths on a wide screen: **260px** expanded
and **116px** collapsed. The collapsed rail used to be **76px**, and at
that width the section names had nowhere to go — so they were hidden
with `sr-only` and the rail became a column of unlabelled glyphs.

That was wrong for two reasons.

**A hidden label is a missing label.** "Audit Logs" and "Reviews" are
different places. A rail of unlabelled icons is a memory test, not a
menu — and it is the *only* menu an administrator has.

**The collapsed state is persisted.** The preference lives in
`localStorage` under `egb-admin-shell`, so an operator who collapses the
rail once keeps it collapsed for the rest of the session. The control
that undoes it sits at the very bottom of the rail, out of sight. So a
collapsed rail is not a transient state an admin chooses and undoes; it
is a state they can get *stuck* in without noticing. Keeping the label
makes the worst case merely **narrower** rather than **unreadable**.

So the collapsed rail **stacks** the label under the icon as a small
centred caption. The word shrinks; it does not disappear.

The rail is **116px** wide, and the caption is **11px** — not 10px —
because the rail is sized to its contents rather than the contents
sized to the rail. At 100px the caption was set at 10px and clipped by
`truncate`, which is the worst of both outcomes: the word was there,
looked present, and still could not be read. "Audit Lo…" tells the
operator that a section named "Audit Logs" exists; it does not tell
them what the section is called, and it makes the rail look broken
rather than narrow.

So the rule the sidebar is built around is **a label is never clipped** —
not with `truncate`, not with an ellipsis, not with a caption too small
to fit the word. The labels **wrap** instead: the rail is sized to fit
the longest one, and anything longer than that breaks onto a second
line rather than disappearing.

The active marker changes shape to match: a trailing vertical rule in
the expanded row becomes a short centred underline beneath the caption.

The brand mark follows the same rule. "EG" alone could be anything, and
it is the one place that says *where you are*, so the collapsed mark
keeps the word "Admin" under the monogram.

The **mobile drawer** is always expanded. A drawer has no width to
save — it is already off the screen — and the rail's collapsed state is
a desktop concern.

### 34. An admin lands in the console, because the role is in the response

The sign-in API returns the user's role. The form **threw it away** and
navigated to the `next` parameter, which defaulted to `/`. So an
administrator who typed their credentials landed on the **storefront**
and had to type `/admin` into the address bar to reach the console they
were obviously trying to reach.

The rule is now explicit, and it lives in `src/lib/auth/destination.ts`
so it can be tested without a browser:

    ADMIN     →  /admin
    everyone  →  the sanitised `next`, defaulting to `/`

**The role wins over `next`.** A `next` parameter exists to honour a
*customer's* interrupted journey — they were sent to the cart, so they
should land in the cart. An administrator has no such journey; their
destination is the console. A `next` pointing an admin at the storefront
is a leftover, not a request.

The open-redirect guard is unchanged and still applies to everybody
else: a `next` may only ever be a relative path inside this site.
`https://evil.example` and `//evil.example` are both refused, and so is
`/\evil.example` — some browsers normalise the backslash to a forward
slash, making it the same attack with a different spelling.

### 35. The nav scrolls rather than overflowing

The nav is `min-h-0 flex-1 overflow-y-auto` rather than `h-full`. A
fixed height inside a flex column does not shrink, so the last items
overflowed the drawer on a short viewport instead of scrolling. The
drawer is a flex column whose only child that may grow is the nav, and
the nav takes what is left and scrolls what does not fit.

### 36. A product carries its concerns as slugs, and the vocabulary is a table

The "Shop by Concern" axis is now a **fact about the product** rather
than a filter over its ingredients.

That distinction is the whole point. A product already carried
`ingredientTags` — the canonical ingredient IDs the conflict engine
reasons about — but the storefront's concern cards linked to
`?ingredient=<tag>`. So "Acne" was a *filter over ingredients*, and an
admin could not say "this serum is for acne" — only "this serum
contains BHA". Those are not the same claim: a product containing
salicylic acid is not thereby an acne product; it might equally be
marketed for congestion, texture or dullness.

So `Product.concernSlugs` is a `String[]` of the slugs in the
`SkinConcern` table.

**Slugs, and not ids, and not a join table.** A join table would be the
textbook answer, and it is the wrong one here: the vocabulary is small
and already admin-managed, it is read on its own rather than joined for
extra columns, and every product read would carry a join. That is the
same argument that made `Product.brand` a plain string (#16), and the
same argument that kept `ingredientTags` a scalar list.

An **id** would also work, but a slug is better. A concern can be
renamed — "Oil Control" to "Redness", say — and a rename changes the
name and the description but never the slug. A product's stored concern
therefore survives a rename, and the customer's link keeps working. An
id would survive too, but it would be meaningless to anybody reading the
database, and the storefront needs the slug anyway to build its links.

**The vocabulary is a table, not a constant.** This is what makes
"Redness" achievable without a code change: an admin adds it in the
Concerns panel and it appears in the product form immediately. It is
also why the picker's options are *passed in* rather than hard-coded —
a hard-coded list would have to be edited in three places every time a
concern was added, and the two would drift, with the picker offering a
concern the storefront does not have.

**An unknown slug is refused, not dropped.** The service checks each
slug against the table before the write. A silent drop would make the
admin's save *appear* to work while quietly losing the selection,
leaving the product missing from the concern page the admin was
targeting.

**There is deliberately no backfill.** A mechanical backfill from
`ingredientTags` *could* be written — a concern's `tag` is drawn from
the same canonical ingredient vocabulary — but it would be a **guess**.
A product tagged `BHA` is not automatically an "Acne" product. The shop
decides which concern a product addresses, and an admin makes that call
on the product form. So the column starts empty, and the first admin to
save a product fills it in.

A product with no concerns is not broken — it simply does not appear in
a concern-filtered listing, which is the honest state for a product
nobody has categorised yet.

### 37. The cart stores the coupon's **code**, never its amount

A discount is worth a different amount as the cart changes. Removing
the last item from a cart can take a percentage coupon below the fixed
amount it was worth. So the cart stores the **code**, and the amount is
computed from the lines at the moment it is shown or charged.

This is the same rule the checkout already follows for prices: the
client never states what anything costs. A client that sent its own
discount amount would be sending a number it made up.

So the flow is: the customer types a code, the server validates it
against the `Coupon` table and **computes** the discount, and the cart
keeps the code. The checkout re-validates inside the transaction and
**refuses** the order if the coupon is no longer good — it does not
quietly apply a smaller discount, because a customer who was quoted a
total deserves to have the order fail loudly rather than succeed at a
different price.

`usageCount` is incremented in the same transaction that creates the
order, **not** when the code is applied. Counting it at the apply would
let a customer apply a limited coupon, abandon the cart, and exhaust the
campaign without buying anything.

### 38. A discount is a saving, not a deduction — and the two are not the same

`discountAmountPaisa` is the **total the customer saved**: the
free-shipping discount plus the coupon's. It is *not* deducted from the
total, because the free-shipping half of it is already reflected in
`shippingAmountPaisa` — which is the charge the customer actually pays
for delivery, and is `0` when the order qualified.

So the invariant is:

    totalAmountPaisa = subtotalPaisa + shippingAmountPaisa - couponDiscountPaisa

and `discountAmountPaisa` is what the screens report as the saving.

Deducting the whole `discountAmountPaisa` would count the same saving
**twice**. On a ৳3,000 order with free delivery it made the total
৳2,920 instead of ৳3,000 — the customer was charged ৳80 for a
delivery that had been waived. The existing pricing test caught this,
and the legacy order rows in the database confirm the corrected
invariant is the one the shop has always used.

The **free-shipping threshold is judged on the pre-discount subtotal**,
for the same reason. The threshold is a statement about the order's
*value* — "spend ৳3,000 and delivery is free" — not about what the
customer paid after a promotion. If it were judged on the discounted
subtotal, a coupon could push an order *below* the threshold and
**add** delivery to it, so a 20% coupon on a ৳3,100 order would make
the customer pay ৳80 for delivery. That is the opposite of what a
promotion is for.

### 39. The announcement bar reads the clock at request time, not at build time

The banner has to say how long a code has left, and a countdown needs a
clock. But a clock cannot be read in either of the two places that
would be natural:

**During the prerender**, Next.js refuses to bake "now" into a static
page — the timestamp would be frozen at build time, and a code that
expired before the customer arrived would still be advertised as
having four days left.

**During render**, React forbids it outright: reading the clock is an
impure operation, and the same component rendered twice could produce
two different answers.

So the clock is read **once, in the service**, at request time, and
handed back with the codes. The banner renders the countdown against
the very same moment that decided which codes were live — so the
countdown and the contents can never disagree about whether a code is
still good.

The read is marked request-bound with `connection()`, inside the
bar's own `<Suspense>` boundary, so the shell around it stays
prerendered and ships instantly while the bar streams in.

The **fallback reserves the bar's height on every screen size**. A
placeholder hidden on a phone and shown on a desktop would mean the
bar pushed the page down as it arrived on one screen and not the
other, and the page would jump under the customer's finger.

### 40. The concern browse filters on the **slug**, not the ingredient tag

Storing the concerns (#36) was only half the feature. If the storefront
still filtered on `?ingredient=<tag>`, the whole thing would be inert:
an admin tags a product, and no page on the shop changes.

So there is now a **third** catalogue filter, `?concern=<slug>`, and it
is a different filter from `?ingredient=<tag>`:

| Filter | Asks | Matches on |
| --- | --- | --- |
| `?ingredient=BHA` | "What is **in** this product?" | `Product.ingredientTags` |
| `?concern=acne` | "What is this product **for**?" | `Product.concernSlugs` |

Both are needed. The ingredient filter is how the conflict engine
thinks, and it is genuinely useful to a shopper hunting for salicylic
acid. The concern filter is how a shopper **thinks** — they do not know
which ingredient treats their acne, they know what their problem is.

The old behaviour was the second question answered with the first
question's data. A card labelled "Acne" listed every product that
merely *contained* salicylic acid, including ones the shop markets for
congestion or texture. The shopper asked "which of these are for
acne?" and the page could not answer it.

**The slug, not the id, and not the name.** The slug is what the
product stores, it survives a rename, and it is what the links are
built from.

**The concern's `tag` still exists**, and it still means what it always
meant: the canonical ingredient this concern's family is led by. It is
what the conflict engine compares against and what the admin means when
they say "this concern is the BHA one". It is simply **not** what the
browse page filters on, and the schema now says so — the previous
docblock said the concern's link *was* `?ingredient=<tag>`, which was
true and is now false.

**The filter panel's "Skin Concern" group was an ingredient group
wearing a concern's name.** It set `ingredient` and tested the tag, so
it disagreed with the cards that linked to the same page. It now sets
and tests `concern`, and the two agree.

**The nav's concern menu was hard-coded, and two of its four links were
dead.** It listed `?ingredient=HA` and `?ingredient=Peptides` — neither
of which is a canonical ingredient ID, so neither matched anything at
all. The menu now lists the shop's own concerns, read from the same
table the cards read from, so an admin's new concern appears there
without a code change.

**The products page says which concern it is showing.** The filter
panel's chip lives in the desktop sidebar, which is hidden below `lg`,
so a shopper on a phone arriving from "Shop By Skin Concern" would have
seen a filtered grid with nothing saying what it was filtered by.

### 41. The seed matches a **live** product, not the oldest one

The seed keys products by name — `Product.name` is not unique, and
`upsert` needs a unique column — and it used to take the **oldest**
row of that name.

That is wrong in a shop that has archived a product. An admin can
withdraw "The Ordinary Glycolic Acid 7% Toning Solution" and later add
a live one of the same name; the seed then writes its catalogue fields
— its brand, its concern slugs — onto the **withdrawn** row and leaves
the live one untagged. The storefront hides archived products, so the
concern pages came up empty for products the seed had plainly tagged.

So the lookup prefers a **live** row, and falls back to an archived one
only when there is no live row at all. And when there is no live row,
the seed creates a live one rather than restoring the archived one: an
archived product was withdrawn deliberately, and a seed that
un-withdrew it would put a discontinued product back on the shelf
without anyone asking.

This was found by *looking at the data* — every concern page but two
came up empty, and the reason was that the tags had landed on rows the
storefront was hiding.

### 42. The store header is sticky, and it is **`bg-surface`**, not `bg-white`

The main bar — logo, search field, navigation and the cart and account
icons — is now `sticky top-0 z-50 shadow-sm`, so it stays reachable on
a long page.

**The two bars travel as one header, so the second one is offset.** The
category strip sits *beneath* the main bar, and two elements cannot both
claim `top-0`: the second would pin to the viewport edge and paint over
the first. So the strip pins to `top-[4.5rem]` — the main bar's height
— and the two move together as a single header rather than sliding
underneath each other.

**The bar is `bg-surface`, not `bg-white`.** The brief asked for
`bg-white`, and a literal white would work in the light theme. But this
codebase themes through **tokens**: `bg-surface` is `#ffffff` in the
light theme and `#1c1917` in the dark one. A hard-coded `bg-white` bar
would become a bright stripe across the top of a black page the moment
a shopper turned the dark theme on — so the token is used instead, and
the visual result in the light theme is identical to what was asked
for.

### 43. The z-index map is explicit, because **sticky changes what "on top" means**

Making the header sticky turned an implicit z-index arrangement into an
explicit one. A `z-50` child inside the header's own `z-50` stacking
context cannot rise above it — the parent establishes the context, so
the child is painted *within* it, not over it.

So the layers were reconciled:

| Layer | z-index |
|---|---|
| Main store header | `z-50` |
| Category strip | `z-40` |
| Account dropdown | `z-[60]` |
| Category trigger and its panel | `z-[70]` |
| Cart drawer, mobile filter sheet, payment modal | `z-[80]` |
| Product gallery lightbox | `z-[90]` |

The account dropdown is the case worth naming: it used to be `z-50`,
which was correct when it lived outside the header and wrong once the
header became a stacking context of its own. It is now `z-[60]`, which
lifts it clear of the bar it hangs from.

### 44. The homepage carousel is **data**, and the code slides are the fallback

The hero's four slides were a hard-coded array in
`src/components/home/hero-slides.ts`. Four campaigns, decided in code,
shipped with the code. An admin could not add a campaign, change a
headline, or retire a slide without a deploy — and the shop's *opening
line*, the one thing every customer reads first, was not something the
shop could change without a developer.

So the slides moved into the database, and the admin panel manages them.

**The two sources are ordered deliberately.** A shop that has created
banners shows **only** its banners; the code-defined campaigns would
otherwise fight the admin's for the same carousel. But a shop with no
banners — or a storefront whose banner query failed — shows the four
campaigns that ship with the code. The homepage is therefore never
empty and never worse than it was before the panel existed.

**The banner's artwork is the background, never the subject.** The copy
is laid over the picture behind a white-to-transparent scrim, so the
headline stays readable whatever the artwork is. A banner with no
artwork falls back to the gradient wash alone, which is a complete
design in its own right — so the artwork is an enhancement, not a
requirement.

**A banner without a product mockup takes the full width.** The hero's
two-column split is copy on the left and the product on the right. An
admin's banner carries artwork rather than a catalogue mockup, so
splitting the panel would leave its right half empty — which reads as a
rendering fault rather than as a design. The split is applied only when
there is a second column to fill.

**A campaign ends; it is not erased.** `isActive` switches a banner off
without deleting the row, so the audit trail has something to describe.
Deletion removes the row, the artwork and the audit entry together.

### 45. The banner's gradient and glow are **presets**, not free text

Both are Tailwind class strings, and both end up in a `class` attribute
on the storefront. A free-text field for a class string is a way to
smuggle arbitrary styling into the shop's front page.

So they are **selects**: a fixed, curated list of complete gradient
washes and accent colours. The server validates the value against a
strict shape as well — a gradient must *look like* a `linear-gradient`
utility and a glow must *look like* a background-colour utility — so
even a hand-crafted request cannot smuggle a class through.

The list is small because the gradient is not a per-campaign decision.
It is the campaign's *mood*, and there are only a handful of moods a
skincare shop has.

### 46. A banner's links are **paths**, and nothing else

Both calls to action are rendered into an `href` on a `<Link>`. A
banner that could point at `javascript:…`, at another host, or at a
`data:` URI would be a way to take the storefront over from the shop
that owns it.

So the rule is closed: a banner may link to a path within the shop, and
to nothing else. A path starting with `/` is internal; one starting
with `//` is a protocol-relative URL to another host and is refused for
the same reason an absolute URL is.

### 47. The migration was hand-written, because Prisma wanted to **reset the database**

`prisma migrate dev` offered to reset the database when the hero
banner migration was added. Two already-applied migrations had been
edited after they were applied, so Prisma saw checksum drift and
proposed `prisma migrate reset` — which drops the schema and loses
every row in it.

That was refused. The migration was extracted with `prisma migrate diff`
and written by hand with only the statements it needed — the three
enum additions and the `CREATE TABLE` — and applied with
`prisma migrate deploy`. Eighteen migrations, all applied, no reset and
no data loss.

The `orders.couponDiscountPaisa` column was found to be **nullable** in
the live database while the schema declares it `NOT NULL`. That drift is
pre-existing and outside this change, so the hand-written migration
deliberately **omitted** the `SET NOT NULL` statement the diff
proposed — keeping the migration additive and safe. No row holds a null
there, so the change can be made separately and on purpose.

### 48. A banner declares **which** products it shows; the server resolves them

The hero's layout is a split — the copy on the left, the product on the
right — and the product is the proof. The copy is the claim; the bottle
is the evidence. So a banner the admin creates needs the same *product
photography* the code-authored slides had, or it would be a campaign
with a half-empty panel.

A banner therefore carries a **showcase source**: a brand, or a category
slug, or neither. The banner *declares* it; the server resolves it
against the catalogue and attaches the finished mockup to the slide.

Three things follow from that division.

**The declaration is stored as plain strings, not foreign keys.** The
brand is a name the shop stocks and the category is a slug — the same
shapes `Product.brand` and `Product.category.slug` already use. A
foreign key would make the banner depend on a row that may be renamed
or archived, and a banner whose showcase has been renamed would quietly
lose its mockup.

**A brand beats a category.** The mockup shows one product for a brand
and three for a category, and the panel is a two-column split — two
sources would be two mockups and a third column. So the brand wins, and
the category is only consulted when there is no brand.

**Neither is an error.** A banner with no showcase source is a purely
editorial campaign: the copy takes the full width of the panel and the
artwork shows behind it. That is a complete design, not a broken one —
which is why the slider's grid is conditional on the mockup rather than
unconditionally two-column.

The brand is checked against the shop's own registry, so a banner
cannot point at a brand the catalogue has never heard of, and the
value is folded to the registry's spelling ("cerave" becomes
"CeraVe") so the banner's string and the products' `brand` column
agree.

### 49. The seed names a **storage key**, and only fills a picture in when there is none

The seeded catalogue had no photography at all — every row's `images`
was `[]` — so the hero's mockups could not resolve even for the
campaigns that point at brands the shop stocks. The shop's own
photographs were on disk the whole time, under
`public/uploads/products/`.

So each seeded product now names its photograph by **storage key** —
the file name under the uploads root, which is the same key the upload
endpoint hands back.

Two rules keep this honest.

**The seed names a key; it does not upload anything.** The uploads
directory is gitignored, so the seed cannot promise that the file is
present on every machine it runs on. A machine that has the photographs
gets a fully-illustrated catalogue; a machine that does not gets a
catalogue whose rows still exist and still read correctly, with the
typographic placeholder where the picture would be. A key that resolves
to nothing renders the placeholder rather than a broken image, so a
wrong key is a missing picture and never a fault.

**A re-seed does not overwrite a picture an admin uploaded.** On an
existing row the seed fills in the photograph only when the row has
none. A picture an admin uploaded is the admin's, and a seed that
overwrote it would quietly undo their work. The seed's contract is
"this is the catalogue" — it is not "the catalogue's pictures are the
only pictures".

This is the same rule the rest of the seed already follows for the
banner copy: re-seeding overwrites the seed's own content, and leaves
everything else alone.


### 50. The admin panel and the shop are **two applications**, and they do not share a shell

The admin dashboard used to be rendered *inside* the storefront.

The shop's chrome — the header with its search bar, the announcement
bar, the category strip, the cart drawer, the footer and the bottom nav
— was mounted in the **root layout**. Next.js nests every layout inside
the one above it, so `/admin/*` inherited all of it: the customer's
search bar sat above the operator's dashboard, the cart drawer hung off
the admin pages, and the shop's footer closed every admin page.

That was not merely untidy. It was a **layout collision**. The storefront
header is `sticky top-0 z-50`; the admin rail was `z-40`. The higher
z-index won, so the shop's header painted *over* the admin sidebar and
the operator's menu was masked on every admin page.

Two z-indexes in two components, each correct on its own, is exactly
how a layout collision happens. Raising the admin's z-index would have
"fixed" the symptom and left the real fault — two applications sharing
one shell — exactly where it was.

So the shop's chrome moved into `src/app/(storefront)/layout.tsx`. A
**route group** is transparent to the URL (`(storefront)/products` is
still `/products`) but a real boundary for the layout tree: pages inside
it inherit the shop's layout, and pages outside it inherit the root
document shell and nothing else.

The admin panel and the shop are two applications wearing the same URL
space. They should not share a shell, and now they do not.

**A side effect worth noting:** the admin's logout button no longer
needs the storefront's cart provider. It reads the cart context
*optionally*, so the one component serves both the storefront's account
menu and the admin top bar — and the admin panel never has to mount a
cart it has no use for.

### 51. The admin shell is a **flex row**, not a fixed rail beside a padded column

The rail used to be `fixed inset-y-0 left-0 z-40`, and the content
column carried a matching `lg:pl-[260px]` to make room for it.

That is two pieces of arithmetic that have to agree: the rail's width,
the padding, and the collapsed width, and the padding again. When they
disagree, the rail and the content stop being two parts of one layout
and become two elements fighting for the same pixels — which is
precisely how the storefront's header came to mask the admin menu.

The shell is now a **flex row**. The sidebar is a flex item with
`shrink-0` and an explicit width; the content column is `flex-1`. There
is no padding to keep in step with a width, and nothing is taken out of
the flow, so the sidebar **cannot** overlap the content — not by
z-index, not by luck, but by construction.

The rail is `sticky top-0 h-dvh` rather than `fixed`: it keeps its
place in the row (so it still reserves its own track) while staying in
view as the page scrolls. Sticky and fixed look similar and behave
completely differently, and the difference is the whole point.

The content column carries `min-w-0`. A flex item's default
`min-width` is `auto`, which means it refuses to shrink below the size
of its own content — so a wide table or a long unbroken string would
push the content out of the row and the sidebar off the left edge of
the screen.

### 52. The layout tree is a **filesystem**, so the isolation is tested against it

The isolation above is a structural property, and structural properties
regress silently. The admin panel would drift back inside the
storefront the next time someone moved a page into the wrong group.

So `tests/admin/layout-isolation.test.ts` reads the **source tree**:
which directories live inside the `(storefront)` group, what each
layout imports, and whether the shell uses `fixed` or a hand-matched
padding. Those are fast, need no database, and fail the moment the
layout is broken again.

The rendered page is the real proof, but it needs a running server and
a signed-in administrator. The source assertions are the guard that
runs in an ordinary `vitest run`; the rendered check is what confirms
it.

Note that these assertions read the file's **code**, with its comments
stripped. A comment that *mentions* a class name is not the class being
used — and the old padding hack and the brand mark's `truncate` are
both discussed in prose.

### 53. A malformed percent-escape is **"not a page we recognise"**, not a server error

The proxy matches the pathname to decide whether a request is for a
product page or an order page, and it decodes the id segment to hand
it to the existence check.

`decodeURIComponent` **throws** a `URIError` when the segment contains a
percent sign that is not followed by two hex digits — `%`, `%zz`,
`%E0%A4`. Those segments are ordinary HTTP traffic: a mistyped link, a
crawler probing for escaping, a truncated bookmark.

An uncaught `URIError` in the proxy is a **500**. The request dies before
the page renders, so a customer who mistyped a product link got a
server error rather than a "we could not find that" screen — and a
crawler probing for escaping got a 500 on every attempt, which is the
opposite of what a hostile probe should see.

The decode is now guarded, and a malformed segment reads as `null`:
the same answer the matcher already gives for a path that does not
match at all. The proxy then makes no existence check, and the page
renders its own not-found UI. A malformed id is not a product id, and
treating it as an unknown route is both correct and harmless.

The `try` is deliberately narrow — it wraps the decode and nothing else
— so a genuine bug elsewhere in the function still throws rather than
being swallowed.

Note the distinction: **the framework** answers a malformed URL with
`400 Bad Request` before the proxy runs at all, and that is the right
answer. The guard matters for the paths that reach the proxy with a
segment the framework accepts but `decodeURIComponent` does not.

### 54. The hero is a **poster**, not a shelf — so the clutter is removed, not hidden

The homepage hero used to be split in two: the copy on the left, and on
the right a raised white plate holding the shop's product photography —
one bottle for a brand slide, a **row of three thumbnails** for the
advisor slide, each in its own box with its own shadow.

The complaint was that the right-hand side was cluttered, and it was.
The second column was not decoration; it was a *catalogue*. Three
product tiles with names and prices, sitting in the most valuable eight
hundred pixels on the page, competing with the headline. A shopper
glancing at the panel could not tell whether they were reading an
advertisement or looking at a shelf.

The fix was to **remove** the column rather than to restyle it. A hero
is a poster, and a poster has one subject: the words. The panel's
right-hand side is now the ground the copy sits on, and the wide, empty
half is what makes a poster look like a poster.

#### The removal went all the way down

The showcase concept was baked into four layers at once, so removing it
meant removing all four together — otherwise the plate would have been
able to half-resurrect itself from a stale layer:

| Layer | What was removed |
| --- | --- |
| The slider | `HeroMockup`, `MockupTile`, `MockupLabel` |
| The types | `HeroMedia`, `HeroMediaProduct`, `mediaSource`, `media` |
| The server | `src/lib/format/hero-media.ts` (the resolver), whole file |
| The database | `showcaseBrand`, `showcaseCategory` columns, and the migration that dropped them |

The columns were **dropped**, not left dormant. A column that still
exists is a column somebody will eventually use.

And the API **refuses** a showcase source rather than ignoring it. This
is the codebase's existing idiom — the same one the checkout schema
uses for card details — because these schemas are not `.strict()`, so an
unmentioned key is *stripped in silence* rather than rejected. A quiet
guarantee would be enforced only by whoever wrote the `JSON.stringify`;
the refusal makes it a property of the **boundary**, where it cannot be
forgotten.

#### The hero carries its own ink

The hero panel is a light poster in **both** themes. Its gradients are
pale washes and its artwork sits behind a white scrim, so the ground
under the copy is always light — in the dark theme as much as in the
light one.

That makes the hero the one place on the site where the ordinary tokens
are wrong. `text-foreground` is near-white in the dark theme, and
near-white type on a near-white ground is unreadable. So the hero
declares `--hero-ink`, `--hero-ink-muted` and `--hero-accent` in
`:root`, and the `.dark` block **does not re-point them** — the same
rule the stylesheet already applies to the fill scale
(`--neutral-800`, `--neutral-900`).

The carousel's *controls* sit below the panel, on the ordinary page
canvas, and keep `text-foreground-muted`. The hero's ink rule applies to
the panel, not to the page.

#### The scrim is two layers, and both are white

The artwork is arbitrary — an admin's photograph, a campaign's key
visual — and the copy has to stay readable over *any* of them.

A flat `bg-white/60` veil knocks the picture back to a texture: it is
still there, still gives the panel depth and a sense of light, but it
can no longer compete with the words. A directional wash on top then
takes the ground the rest of the way to white on the left, where the
copy sits, and fades out towards the right.

Both are **white**, not `surface`. A `surface` scrim would turn dark in
the dark theme and put dark type on a light gradient. And both are
`pointer-events-none`, so they never intercept a click on a call to
action.

#### The shape is pinned

A slide's vocabulary is now exactly the copy and the ground:
`id`, `eyebrow`, `title`, `body`, `cta`, `secondaryCta`, `trust`,
`gradient`, `glow` (and `image` for a database banner). Anything else on
the panel is clutter competing with the headline, so the key set is
asserted exactly — in the formatter, in the validator, and in the
service.

And because the property being protected is a property of the *shape* of
the hero, `tests/home/hero-cleanliness.test.ts` reads the **source
tree**: it fails the moment someone puts a product plate back, which is
exactly the edit that would reintroduce the clutter. The rendered page
is the real proof, but it needs a running server; the source assertions
are the guard that runs in an ordinary `vitest run`.

#### The showcase columns never appear in the migration history

The two columns were added by a migration and dropped by another one,
and both were uncommitted. The pair cancelled out entirely, so the
migration history was rewritten to **never mention them**: the table's
original migration creates the table without those columns, and the
add/drop pair is gone.

This matters because the migration history is a record of what the shop
*has*, and a history that said "the hero gained a product plate, and
then lost it" would be describing a feature that never shipped. The
truth is simpler and better: the hero never had one.

The history is also **replayable** — it was verified by applying all
eighteen migrations to a scratch database, which reached exactly the
schema the dev database has, with no showcase columns. A migration that
only works because the dev database happened to be in a particular
state is a migration that fails in production.

### 55. The announcement bar is the shop's **first sentence**, so it is governed, not decorated

The shop needed a place to say one thing unprompted — a delivery
promise, a campaign, a new range — and a place where the owner could
switch that thing on and off without a developer.

That is the whole feature. What follows is the set of rules that keep
it from becoming a strip of coloured nothing.

#### The bar renders nothing when there is nothing to say

The switch is the admin's, but the text is theirs too, and the two can
drift apart. A marquee that is on but empty is a strip of coloured
nothing at the top of every page — and it looks like something broke,
which is worse than no bar at all.

So the emptiness is checked in **three** places, each of which can
only see what it can see:

| Layer | What it can see | What it does |
| --- | --- | --- |
| The **schema** | The request | Refuses an empty `marqueeText`. An empty string is not a way to clear the announcement — the switch is. |
| The **service** | The request *and* the stored row | Refuses to switch the marquee **on** when the text that would be in force afterwards is empty. |
| The **public read** | The stored row | Returns the empty settings for a row that is enabled-but-empty. |
| The **component** | Only its props | Returns `null` for empty text. |

The service is where the *rule* lives, because the rule is about the
**stored** state: a request that switches the marquee on without
naming the text is switching on whatever is already saved, and only the
service can see what that is. The other three layers are the defence
in depth behind it.

The converse is deliberately allowed: switching the marquee **off**
while the text is still there is how an admin pauses a campaign, and
the text is preserved so switching it back on restores the message
rather than losing it.

#### The seamless loop is two **equal** copies, not two identical ones

The track holds two copies of the message and the animation translates
it by exactly one copy's width. When the first copy has scrolled fully
out of view, the second is precisely where the first started.

"Identical" is not enough for that to be true. The two copies are made
**equal** — each is a `flex-1` item of the track, so they always take
the same width however long the message is — and that is what makes the
`-50%` translation land precisely on the seam. The translation is a
**percentage of the element's own width** rather than a pixel value,
because the width is not known until the text has been laid out.

The track is also never narrower than the frame:
`min-width: max(100%, max-content)`. Without it, a short message would
leave a gap on the right of the strip — the track would be 120 pixels
wide inside a 1200-pixel window.

#### The motion is CSS, and it stops for the people who asked it to

The scroll is a `transform` on a single element, driven by a keyframe.
A JavaScript loop would put a timer on every page of the store, would
keep running while the tab is hidden, and would fight the browser's own
compositing for no benefit.

`motion-safe:` switches the animation off entirely for visitors who
have asked their system for less motion — a marquee that scrolls
forever is exactly the kind of motion that setting exists to stop.

And the scroll **pauses when the link inside it is focused**, so a
keyboard user who has tabbed to the announcement is not chasing a
moving target. That pause is a `group-focus-within` variant, and the
variant only matches a **descendant** of the element carrying the
`group` marker — so the marker sits on the outer frame, which is the
animated element's *ancestor*. A `group` marker on the wrong side of
the animated element compiles cleanly and silently does nothing, which
is the worst way for it to fail.

#### The duration scales with the message

The animation translates by a percentage, so a fixed duration would
make a long message move faster than a short one — and a long message
moving quickly is unreadable, which defeats the point. So the duration
is a CSS variable, stepped by length: 30 seconds for a short
announcement, 48 for a long one. The steps are coarse on purpose; the
readability only depends on which band the message falls into.

#### The link is optional, and it is closed

When there is a destination, the message is a link; when there is not,
it is plain text — a link that goes nowhere is worse than no link,
because it looks clickable and does nothing.

The destination is a **path within the storefront** and nothing else,
the same closed rule the hero banner's calls to action follow. The
marquee's `href` is rendered on *every* page of the shop, so a
marquee that could point at `javascript:…` or at another host would be
a way to take the storefront over from the shop that owns it.

The duplicate copy is `aria-hidden`, so a screen reader reads the
announcement **once**; the first copy carries it, and its link is
focusable.

#### The bar is read at request time, not at build time

An announcement switched on after the last build would not appear on a
prerendered page, and one switched **off** would keep appearing on
every page until the next build. Both are unacceptable for the one line
of copy the shop writes without being asked.

So the read is marked request-bound with `connection()`, behind a
`<Suspense>` boundary, and the fallback is `null` rather than a
placeholder — the marquee's height is not knowable in advance, and
reserving a strip that then turns out to be empty would be the very
thing the empty bar is supposed to avoid.

It sits **above the header**, because it is the shop's first sentence
and the header is the shop's name. The name is permanent; the sentence
is this week. And it is **not sticky**: an announcement that follows
the customer down the page becomes furniture.

#### The admin's control is a real switch, and it sends only what changed

The visual is CSS drawn on top of an `sr-only` checkbox, so the
control is reachable by keyboard, announced with its checked state by
every screen reader without a line of ARIA, and participates in a form.
A `<button role="switch">` would submit nothing.

The form is a **partial** update, for the same reason the advisor
configuration's is: the marquee has a switch and a text, and the
natural admin gesture is to flip the switch without retyping the
message. A whole-row save would also save whatever stale copy of the
text the form happened to be holding.

And the switch is **not** saved on its own. Toggling it marks the form
dirty; the write happens on Save, with the text, in one request. The
switch is exactly the control that can be flipped *before* the
announcement is written, and a save that publishes half an intention
is worse than one that waits.

---

### 56. The announcement's colours are **two hex triplets**, and the pair must be legible

The bar's ground and its type used to be chosen in the component —
`bg-neutral-900` with white type — and unchangeable. The shop wanted to
paint it, so the two colours became columns: `marqueeBgColor` and
`marqueeTextColor`.

#### A colour is a colour, and everything that is not one is refused

The value comes from the database and goes **straight into a `style`
attribute**. That makes it untrusted input on its way to the browser: a
value that is not a colour is a way to inject something else.

So the value is normalised before it is used, in **three** places:

| Layer | What it does |
| --- | --- |
| The **schema** | Accepts `#rrggbb` and `#rgb`, in either case. Refuses everything else. |
| The **service** | Rejects a pair that is too faint to read. |
| The **public read** | Normalises the stored value again, falling back to the default. |

The public read normalises **again** on purpose: the database is not a
validator. A row written by hand, by a script, or by an older version of
the admin route could hold anything, and the bar must still be painted.
A value that is not a colour falls back to the default rather than
leaving the bar unpainted.

The column is a `VarChar(7)`, which is a second line of defence behind
the normaliser — the database itself will not hold a long injection
string in a colour field.

#### One colour, one spelling

`#FFF` and `#ffffff` are the same colour, and the database must not hold
both — otherwise the admin's audit trail would show a colour change that
did not happen. So the stored form is always **lowercase six digits**.

The three-digit form is *accepted* on the way in, because a colour picker
and a human both produce it, and refusing it would be pedantry. The
expansion happens in the normaliser.

#### The pair has to be **readable**, and the threshold is the strict one

The admin may pick a pale rose ground with white type — a valid pair of
colours and an unreadable bar. The bar is on **every page** of the
shop, saying something nobody can read.

So the pair is measured, and the threshold is WCAG's **4.5:1** — the
*body-text* ratio — rather than the 3:1 large-text one. The marquee is a
thin strip of a small moving line of marketing copy. It is not a heading,
and it is not large.

The check is made against the pair that would be **in force afterwards**,
not against the request. A request that changes only the ground is
changing the pair, and only the service can see what the type already
is. That is why the rule lives in the service and not in the schema.

The client shows the ratio **live**, while the admin is choosing. That is
a courtesy, not an enforcement: the client does not know what the other
half of the pair *already saved* is, so the server's judgement on the
stored pair is the authority.

#### Presets are **pairs**, because a ground and a type are only legible as a unit

A separate control for the ground alone would allow the admin to paint
the bar in the ground of one preset and the type of another — which is
how you get a rose ground with white type at 2:1. So clicking a swatch
sets **both** colours, and every preset has been checked for legibility.

#### Everything that sits on the ground follows the ground

The edge fades, the separator and the focus ring's offset are all
painted against the bar's background. A fade built from a fixed
design-system token would leave a visible band of the wrong colour on a
bar the admin has repainted — the most visible possible way for the
colour feature to look broken.

So the fades are painted with the ground colour itself; the separator is
the type colour at a third of its strength; and the focus ring's offset
is the ground, so the ring sits *in* the bar rather than around it.

The default remains the shop's darkest fill (`#1c1917`) with white type —
the **fill** step of the neutral ramp, the part that deliberately does
not re-point in the dark theme. So a bar left at its default is the same
warm near-black in both themes.

---

### 57. The static utility strip is **gone**, because the shop has one strip

The header used to carry a dark utility strip of its own, above it,
holding "Cash on Delivery available nationwide" and a telephone number.

Two strips above the header were one too many. They were the same kind
of thing fighting for the same attention, and — this is the part that
actually mattered — the old strip **could not be changed without a
developer**, while the marquee, the strip that *could* be changed, sat
above it saying something else.

So the promises the strip used to carry are the marquee's job now, and
the shop's chrome has one strip rather than two.

---

### 58. The footer's contact details are **the shop's own words**, and they live in the database

The footer's support email, telephone, opening hours and store address
used to be strings in the footer component. That made them wrong the
moment the shop's mailbox changed — and they are the details a customer
calls or writes to when they have paid for something they cannot see, so
being wrong about them is not a cosmetic problem.

They are now four columns on the same `site_settings` row the marquee
comes from, because they are the same kind of fact: what the shop says
about itself.

#### A missing detail is a **missing line**

A shop that has not told us its opening hours shows **no hours line**.
It does not show "Opening hours: —".

An empty line in a footer reads as a mistake, and a shop whose contact
details are half-configured looks like a shop nobody answers. The
absence of a line is honest; a placeholder is not.

So every one of the four fields may be empty, and an empty one means
"the footer does not show this line".

#### The read is **streamed**, because the footer is on every page

A bare database read in the storefront shell would opt the **whole**
storefront out of the prerender — the home page, the catalogue, every
product — so that one row of contact details could change.

So the read is marked request-bound with `connection()` and sits behind
its own `<Suspense>` boundary. The footer's chrome stays prerendered and
ships instantly, and only the contact lines stream in.

And the read is wrapped in its own `try`/`catch`: the footer is on every
page, and a footer that threw would take the whole storefront down for a
detail nobody is reading yet.

#### The address keeps its line breaks

The address is free text, and the shop may have written it across
several lines. It is rendered with `whitespace-pre-line`, because an
address read as one run-on line is an address nobody can copy into a
delivery app.

#### The telephone dials the digits, whatever way the shop wrote it

The display string is the shop's — "01819-000000", "+880 1819-000000" —
and the `tel:` href is built from the **digits and the plus sign alone**.
Everything else is discarded, so the number reads the way the shop wrote
it and still dials; and a string that tried to smuggle in a scheme
cannot, because the scheme's letters are not digits.

---

### 59. The guest order-tracking endpoint is **public**, and it is bounded by a secret

The footer's "Track an order" link pointed at a URL that did not exist.
It was a dead link in the one part of the page where a customer goes
when something has gone wrong — which is the worst place for a dead
link.

The customer who most needs to know where their parcel is — the one who
ordered as a guest, or who never made an account — is by definition
**not signed in**. So the endpoint is public by necessity, not by
convenience: a session requirement would make it answer only to the
customers who do not need it.

The route is `/api/order-tracking`, not `/api/track` — that path is the
storefront's traffic beacon, it has been there since the traffic work,
and reusing it would mean two unrelated endpoints fighting over one path
with two unrelated contracts.

#### The contact detail is the secret, and the order number alone is not enough

An order number is printed on a parcel, quoted over the phone and pasted
into a chat window. So the caller must also supply a **contact detail
that is on the order**: the account's email address, or the delivery
phone number.

Either one is enough, because the shop does not know which the customer
remembers, and requiring both would refuse to help a customer who
remembers only one.

The phone is compared on its **national digits**, because the shop
stores the same number two ways: the checkout normalises it to
`+8801712345678`, and an admin-created telephone order carries whatever
the operator typed. A string comparison would fail to match the *same*
number in two spellings.

#### The order number is **normalised**, not validated

The number travels by SMS and is retyped. "EGB-20261027-A1B2C3",
"egb 20261027 a1b2c3" and "EGB20261027A1B2C3" are the same number, and
a form that refused two of them would be refusing to help.

So the canonical form is looked up, and the endpoint never tells the
customer their number is malformed — "that is not an order number" and
"we could not find that order" are the same answer here, and one of them
is a useful signal to an attacker probing the shape of the shop's order
numbers.

#### Every failure is the **same** failure

Three failures are possible: the number is mistyped, the number is real
but belongs to nobody here, and the number is real and the contact
detail is wrong.

All three produce the **same** answer — a `404` with the same message.
If they produced different answers, the endpoint would be an enumeration
oracle: an attacker could tell a mistyped number from a real one, and
would only have to solve the second problem to harvest the shop's order
numbers.

#### The limit is counted in the **database**, and only failures count

The endpoint is a **search**, so it needs a cap. Ten failures an hour
against one order number is enough for a customer who has genuinely
forgotten their order number, and small enough that a script cannot
grind a contact detail against a known number for free.

The count comes from the **database** — a ledger of attempts — rather
than a process-local counter, which would be reset on every restart and
would not be shared between instances. That is exactly when a cap is
needed.

Only the **failures** count. A success has already proved the caller
knows the contact detail, so it is not a guess — and counting it would
mean a customer who checks their order five times in an hour eventually
locks themselves out of their own order.

The limit is read **before** the lookup. Checking it afterwards would
mean the cap is enforced on the answer rather than on the work: an
attacker gets their guesses for free and is only told to stop once they
have guessed.

#### The ledger moves identically for a real number and a fake one

A failure against a number that **belongs to nobody** is recorded too,
against the number that was tried.

If the counter only moved for numbers that exist, the limit itself
would become an oracle: a candidate number that starts answering
`RATE_LIMITED` would be telling the attacker it is real.

The ledger records no contact detail — only the number, the success flag
and the timestamp — and it is pruned to a 24-hour retention window at
most every fifteen minutes, so the prune never puts an unbounded write on
the hot path of a public endpoint.

#### A malformed number is neither recorded nor counted

A number that is not shaped like an order number fails without touching
the database.

The shop's numbers have one shape, and that shape is public knowledge —
it is printed on every parcel — so a string that does not have it is
not a candidate for a real order.

The alternative, recording it against a shared "malformed" bucket, would
hand an attacker a denial of service for free: ten malformed requests
an hour would lock out **every** customer whose number did not parse,
and the shop's own customers mistype numbers more often than an
attacker does.

#### The page is **static**, and the answer arrives over `fetch`

The page does not read the order on the way in. That is not a matter of
taste: a page that read the order would have to either take the order
number from the URL — which puts it in the address bar, in the browser
history and in the referrer of every link the customer clicks
afterwards — or read the session, which defeats the purpose of a guest
page.

So the order number is typed, and the answer arrives over `fetch`.

#### The page says what the statuses **mean**

`PROCESSING` is what the database calls it; "Preparing" is what it
means. The vocabulary lives in `src/lib/format/order-status.ts` and is
shared with the signed-in order surfaces, so a customer who checks their
order here and then signs in sees the same words.

The timeline is four steps, and a **cancelled order has none**: it is
not on the journey, and rendering the timeline as if it were would tell
the customer their parcel is "on the way" when it was cancelled.

---

### 60. The test suite **borrows the shop's settings**, and gives them back

The integration suite's cleanup deleted the `site_settings` row in
`afterAll`. That was wrong, and it was wrong in a way that only showed
up later.

**It destroyed the shop's live configuration.** The admin's announcement,
the shop's support telephone, the opening hours, the store address —
all gone, because somebody ran the test suite. Nobody asked for that,
and no test asserted on it. The same mistake was made with the advisor's
configuration, whose disclaimer is the compliance text every customer
sees.

**And it was not idempotent.** After the first run the row did not
exist, so the storefront rendered its empty defaults. The second run
started from a different place than the first did — which is how a
suite starts failing for reasons nobody can explain, and why "run it
again" is the wrong advice for a test that fails once.

So the rule is now: **a test borrows the shop's row and gives it back.**

The helpers in `tests/integration/singletons.ts` **snapshot** the row
before anything touches it and **restore** it afterwards — the same
values, and the **same id**, so the shop's own row comes back rather
than a copy of it wearing its settings. A database that had no row ends
with no row, because "the shop has never configured anything" is a real
state and the restore has to be able to reproduce it.

#### The baseline is the shop's own row, with the values zeroed

The tests still need a known starting state: "the marquee is off and
has no text", "the ground is the default ink", "there is no contact
detail configured". Without one, a test's outcome depends on whatever
the shop happens to have configured — which is how a suite passes on one
developer's machine and fails on another's.

So the row is **reset** between tests, and the shop's own row is put
back at the end. The two are different things and the order matters:
*reset* for a known baseline, *restore* for the shop's sake. The reset
keeps the row's id too, so the baseline is the shop's row rather than a
replacement for it.

#### A test's cleanup is scoped to what the test created

The same rule applies to the audit log, which is the shop's record of
who changed what.

Two files were clearing **every** entry of a type — one of them
deleting all `order_item` entries, which would have erased the history
of every reminder the shop had ever sent, and all SMS logs besides.
Both are now scoped to the entities the test created, plus the one
fixed id the sweep writes under (`"sweep"`, because a sweep is a run
rather than an item).

And the entries the singleton tests write are removed by **actor**: the
test's own admin is what identifies them, which leaves the shop's own
history for the same row untouched.

#### The property is tested on its own

`tests/integration/singleton-restoration.test.ts` proves the restore
behaves — that the row comes back with every field, that it comes back
**under its original id**, that a database with no row ends with no
row, and that restoring twice gives the same result.

It is a **separate file** on purpose. The site-settings file proves the
*service* behaves; this file proves the *suite* behaves. Together in
one file, one file's `beforeEach` would mask the other's mistake —
which is exactly what happened before.

---

## The Gemini provider (Google AI Studio)

### #A — Gemini is a *third provider*, not a separate service

The brief asked for Gemini to be integrated as a NestJS service. There
is no NestJS in this repository — the whole advisor stack lives in
`src/lib/ai/`, behind a Next.js route — and the SRS lists NestJS only
as an *option* alongside Next.js API Routes, not as a decision that was
ever taken.

So the integration went where the architecture actually is: **as a third
implementation of the existing `AiProvider` interface**, alongside the
mock and the OpenAI provider.

The alternative — a separate NestJS microservice — would have cost more
than it bought:

  • It would have needed its **own Prisma client** against the same
    database, so the "one source of truth" the codebase is built on
    would have become two.
  • The **conflict engine** (`src/lib/conflicts/engine.ts`) is pure and
    shared. A second service would either have duplicated it — and the
    two copies would drift — or called back over the network for it.
  • The **allow-list validation** lives in the service layer. A second
    service would have had to re-implement the one rule that matters
    most: a provider must never widen its own permissions.
  • The storefront already talks to the advisor through
    `/api/advisor/chat`. A second origin would have meant a second
    auth story, a second CORS story and a second rate-limit story.

A provider is the right seam because **a provider is a thing that
phrases advice**. Everything else — which products are eligible, which
ingredients conflict, what the disclaimer says — is decided in code and
is provider-agnostic. Adding Gemini therefore changes *one file*
(`src/lib/ai/gemini-provider.ts`) and one branch in the registry.

### #B — The switch is `AI_PROVIDER`, not a new service boundary

`AI_PROVIDER` now takes `mock`, `openai` or `gemini`. The selection
lives in `src/lib/ai/index.ts` and each real provider is reached
through a **dynamic `import()`** inside its branch.

That is not a micro-optimisation. The whole point of the mock provider
is that the project runs with **no API key and no network**, so that
anybody can clone it and see it work. If `src/lib/ai/index.ts` statically
re-exported the Gemini provider, the `@google/genai` SDK would be
evaluated in mock mode too — and the "no external dependency" promise
would be a lie that only shows up in a deployment.

So the Gemini provider is re-exported **as a type only**. `export type`
is erased at compile time: the names cross the module boundary without
the module being evaluated. The runtime class is reached through the
dynamic import.

### #C — The Gemini response is untrusted, exactly like the OpenAI one

The model can return a product id that was never a candidate. That is
true of Gemini for the same reason it is true of OpenAI: a language
model is a text generator, and "only recommend from this list" is a
request rather than a guarantee.

So the Gemini provider filters its own recommended ids against the
allow-list **before returning**, and the service layer filters them
**again** after that, and re-attaches the code-decided conflicts
regardless of what the model said. The duplication is deliberate — the
same reasoning as the prompt rules and the code rules in §5.4. A prompt
rule is a request; a code rule is a guarantee.

### #D — The model name is recorded separately from the provider name

`AdvisorMessage.provider` and `AdvisorMessage.model` used to hold the
same string. They answer different questions: **"who billed us"** and
**"which model wrote this"**. `gemini` and `gemini-2.5-flash` are not
the same fact.

A model quietly downgraded from `flash` to `lite` is exactly the kind
of change an audit trail exists to catch, and a column that recorded
only the provider name could not catch it. The route now writes the real
model name, and `AdvisorMessage.meta` carries it too.

### #E — An empty Gemini response is a safety block, not an outage

Gemini returns **no candidate at all** when the prompt or the image
trips a safety filter. The advisor's entire domain is a photograph of
somebody's face, so this is a *normal* outcome rather than a failure —
and it deserves a distinct error rather than a generic "empty
response", because the two mean different things to whoever is on call.

The provider therefore checks `promptFeedback.blockReason` before
concluding that the response was empty, and reports the two cases
differently.

### #F — The photo is analysed at high resolution

`mediaResolution` is set to `MEDIA_RESOLUTION_HIGH`. The question being
asked of the image is "what is happening on this person's skin" —
texture, the edge of a blemish, the difference between redness and a
brown mark. A low-resolution thumbnail throws exactly those details
away, and an advisor that cannot see the blemish is an advisor that
answers the wrong question.

### #G — The retry lives in the provider, and it is bounded

Gemini's flash tier returns `503 UNAVAILABLE` with *"this model is
currently experiencing high demand"* fairly often. The live smoke test
caught one reaching the customer as a hard error, on a request that
would have succeeded a second later.

So the provider retries — three attempts, exponential backoff from
300ms — and it retries **only** the failures that mean "try again":
`429`, `500`, `503`.

A `404` is deliberately **not** retried. A closed model will still be
closed on the second attempt, and retrying it only makes the customer
wait longer for the same error. The same goes for a `401` — the key is
wrong, and no amount of retrying fixes a key.

The attempt cap is what keeps this bounded: the delays total roughly
900ms, so the chat route's 30-second ceiling still holds, and a bad day
at Google cannot turn into a customer waiting indefinitely.

### #H — The default model is `gemini-3.5-flash`, not `gemini-2.5-flash`

The obvious default was `gemini-2.5-flash`, and it was the default
until a live call against a real key returned `404`:

> This model models/gemini-2.5-flash is no longer available to new
> users.

The model is still **listed** by `models.list`, which is what makes this
worth writing down: a model can appear in the catalogue and still be
closed to the account making the call. The unit tests could never have
caught it — they inject a stubbed SDK client and never reach the
network.

So the default is now `gemini-3.5-flash`: a stable, non-preview
release that is available to new users. The `-preview` suffix matters —
a preview model can be withdrawn with no notice, which is not a
property a deployment wants in the model that answers its customers.

**This is why `scripts/verify-gemini.ts` exists.** It makes one real
call and checks the advice comes back, in the right language, with the
recommended ids intact. It is the only test in the suite that reaches
the network, and it is the only one that can catch a model the
account cannot use.

---

## The conversational advisor

### #I — Whether a turn carries products is decided in **code**, not in the prompt

The advisor used to dump a three-product routine on a customer who had
typed "Hi". The cause was a single unconditional line at the end of the
system prompt:

> Answer briefly: two or three short paragraphs, then a short list of
> recommended products with one line of reasoning each.

That instruction applied to every turn, so it applied to a greeting as
much as it applied to a real question.

The fix is **not** a softer prompt. It is a different kind of answer:
*should this turn recommend anything at all?* is a **decision**, and by
decision #7 — "code decides, the model phrases" — a decision cannot be
delegated to a prompt. A prompt rule is a request; a code rule is a
guarantee.

So the decision is made in `src/lib/ai/intent.ts`, deterministically, and
handed to the provider as a fact, exactly as the language is (#the
`language.ts` module exists for the same reason).

The four intents:

| Intent | What the customer did | May recommend |
|---|---|---|
| `GREETING` | Said hello. Nothing else. | **No** |
| `CONCERN` | Described their skin, a problem, or a goal. | Yes |
| `QUESTION` | Asked something specific. | Yes |
| `ORDER` | Asked about delivery, payment, a coupon. | **No** |

A `CONCERN` and a `QUESTION` both may recommend, but they recommend for
different reasons: a concern turn earns a routine, a question turn earns
an *answer first*. Collapsing them is how "what about the retinol?" gets
answered with a fresh three-product routine.

### #J — A turn that may not carry products **drops** the provider's ids; it does not replace them

This is the subtle one, and getting it wrong would have been worse than
the original bug.

The service layer has a fallback: a provider that names a product
outside the allow-list has those ids dropped and the **deterministic
candidate set** substituted. That fallback is correct for an advice
turn — the customer gets *something* relevant.

But on a greeting turn, running the fallback would **invent a routine
nobody asked for**. A customer who typed "hi" would receive three
products, generated not by the model but by the guard rail itself. The
guard rail would have become the bug.

So `selectRecommendedIds` checks *"may this turn carry products?"*
**first**, and returns an empty list. The provider's ids are dropped,
not replaced.

The order of those two rules is the whole decision. It is asserted
directly in `tests/ai/service.test.ts` — "does not replace a greeting's
products with the deterministic set".

### #K — The **turn instruction** is appended to the prompt, like the language rule

The persona and the hard rules live in the stored system prompt. The
**language rule** and the **turn instruction** are appended by the
provider, because they are facts about *this* request and the stored
prompt cannot know them.

Appending them also means an admin's prompt override cannot lose the
behaviour. An override replaces the persona, but it must not be able to
make the advisor dump a routine on a greeting — the conversational
behaviour is the product, and a prompt field is not allowed to switch it
off. Same reasoning as the language rule.

The turn instruction is also restated in the **brief**, next to the
customer's question. The system instruction says what kind of turn this
is; the brief says what the turn *is*. A model reading both has no room
to misread it.

### #L — The mock provider is conversational too

The mock is what most people actually run, and it is the platform's proof
that the whole pipeline works with no API key and no network.

If the mock dumped a routine on "hi" while Gemini greeted the customer
back, the demo would contradict the product. So the mock honours the
same turn contract: a greeting turn greets and asks, a concern turn
answers and recommends, an order turn answers the order question.

The mock has no model, so it cannot improvise — the *phrasing* comes
from templates and the *decision* comes from the same `intent` the real
providers are given. It stays deterministic: the intent kind is part of
the seed material.

### #M — A photo is a **concern**, even when the message is "Hi"

A customer who attaches a picture of their face and says "hi" wants the
picture looked at. Treating that as a greeting — and therefore telling
them to describe their skin instead — would be exactly backwards.

So an attached photo makes the turn a `CONCERN` unconditionally. This is
the one place where the message alone does not decide the intent, and it
is decided in the service layer rather than in the detector, because the
service layer is where the image is known.

### #N — The Bangla normalisation keeps its **combining marks**

The first version of the intent detector normalised text with
`[^\p{L}\p{N}\s]` — letters, numbers, whitespace. That strips the
**marks** (`\p{M}`), and Bangla depends on them: the virama (্) and
the vowel signs are marks, not letters.

Stripping them turns "ত্বকে" into "তকে" and "হ্যালো" into "হযাল", so
the Bangla vocabulary matched nothing. The Bengali tests caught it on
the first run.

The class is now `[^\p{L}\p{M}\p{N}\s]`, and the Bangla vocabulary is
matched as **substrings** rather than whole tokens — because Bangla is
agglutinative, "ত্বকে" and "ত্বকের" both contain "ত্বক", and a
whole-token match would miss every inflected form of every word.

### #O — The advisor asks **one** question, and only for what it does not know

`AdvisorIntent.missing` carries what the advisor still needs: the skin
type, then the concerns. It is derived from the **skin profile**, not
from the conversation, so a customer who has already set their skin type
is never asked for it again.

Asking a customer for something they already told you is the single most
annoying thing a chat advisor can do, and it is the fastest way to make
a conversational advisor feel like a form.

One question per turn, for the same reason: a customer asked four things
at once answers none of them.

### #P — The advisor speaks in **prose**, and the schema is gone

The Gemini request used to carry `responseMimeType: "application/json"` and
a `responseJsonSchema` that said `{"content": "...", "recommendedProductIds":
["..."]}`. The OpenAI request carried the same idea as
`response_format: { type: "json_schema" }`.

The schema was there to make the ids recoverable. But a schema tells the
model *how to shape its answer*, and a model told to shape its answer
writes a shaped answer — the customer's actual question answered in
whatever room is left over inside the `content` field. Every reply had the
same shape, which is the robotic quality this refactor exists to remove.

So the schema is gone. Neither provider constrains the response format any
more, and the advisor writes prose.

The prose is not the only channel. The ids travel on their own:

* a **marker line** the model appends — `[RECOMMENDED: prod_x, prod_y]` —
  which is parsed out and removed before the customer sees it; and
* a **function call** the model emits, which Gemini supports natively and
  which carries the ids as structured arguments.

Both are parsed in `src/lib/ai/free-text.ts`, and both are **untrusted**:
the service layer still validates every id against the allow-list. The
parser extracts; it never widens.

Two channels rather than one, because a live probe showed that Gemini in
`AUTO` function-calling mode will sometimes return the function call
*without* prose — `response.text` comes back `undefined` and the SDK warns
that the response has non-text parts. A single channel would lose the
reply on those turns. The marker was followed reliably (2/2 trials), so
the two together cover each other.

### #Q — The marker is **removed twice**, and neither removal is optional

The marker is stripped in the provider, by `parseFreeTextReply`, and then
stripped again in the service layer, by `stripRecommendationMarker`.

The second removal is not redundancy for its own sake. The provider is one
of three, and a new provider — or the mock — could forget. The service
layer is the last thing between the model's output and the customer, and
the invariant it protects is absolute: **a customer must never see
`[RECOMMENDED: …]`**. A net at the boundary is worth more than a
convention that is trusted at every layer.

This is also why the mock provider does **not** emit a marker. The mock's
content goes straight to the customer, so a marker there would be visible
in the UI. The mock returns its ids through `recommendedProductIds`, as it
always did.

### #R — The client sends its transcript, and the **stored** one wins

The server reads the conversation's turns from the database. That is the
authoritative record. But the client is looking at the transcript, and it
knows it *now* — including the message the customer has just sent, which
the database has not been told about yet.

So the client sends its transcript alongside its message, and the two are
merged in `mergeHistory`.

The merge rule is: **the stored transcript wins, unless the client's is
demonstrably ahead of it.** "Ahead" is measured by counting the turns,
because a turn count is the one thing both sides agree on. The client is
ahead when its transcript **starts with** the stored one — the extra
turns are always at the end, because the extra turn is the message that
has just been sent.

A client that does not start with the stored transcript is describing a
*different* conversation — it clicked a link to another chat, or it is
describing this one inaccurately. Its turns are dropped, and the stored
transcript stands alone.

A **prefix** match rather than a suffix one, and this was not the first
attempt. The suffix version compared the client's turns against the
stored ones from the end, which mis-joins the two the moment the client
has an extra turn at the front. And the prefix version that came after it
compared from the front but *appended* the client's tail to the stored
list, which duplicates turns whenever the two diverge. The correct
alignment is: the client's transcript **extends** the stored one, so the
merged list is simply the client's list.

The client's transcript is untrusted input, so it is bounded by a schema
(`advisorHistorySchema`, twenty turns, strict shape) rather than by the
database. A malformed client history is **logged and dropped**, not
rejected — the server can read the transcript by itself, and a client
that sends a broken history should still get an answer rather than a 400.

### #S — The integration suite **pins the mock**, so it never spends the quota

`tests/integration/advisor.test.ts` exercises the real service layer
against a real PostgreSQL. It does not need a real model: the properties
it proves — the intent detection, the guard rails, the candidate builder,
the profile updates — are all properties of the service layer, and the
mock honours the same turn contract the real providers do.

Without pinning, the suite followed whatever `AI_PROVIDER` the
developer's `.env` happened to set. On a machine configured for the live
Gemini provider, every one of those tests made a **real API call** —
spending the free-tier quota (twenty requests a day) and failing the
whole suite with a 429 the moment that quota ran out.

So the suite sets `AI_PROVIDER=mock` in `beforeAll` and restores the
machine's setting in `afterAll`. The live providers are covered by their
own unit tests, which stub the SDK, and by
`scripts/verify-conversation.ts`, which calls the real model on purpose.

---

## The OpenRouter provider (a router in front of the providers)

### #T — OpenRouter is a **provider**, not a service

The same reasoning as #A applies, and for the same reason. OpenRouter
is an HTTP endpoint that speaks the OpenAI chat-completions dialect, so
it integrates as **a fourth implementation of the `AiProvider`
interface** — `src/lib/ai/openrouter-provider.ts` — plus a branch in the
registry.

It is not a separate service, and it could not be: it carries no
catalogue, no conflict rules and no allow-list. It takes a prompt and
returns prose. That is exactly a provider's job.

### #U — The reason for OpenRouter is **rate limits**, and the routing is the fix

The shop was hitting rate limits on a single provider's shared key, and
every one of those `429`s reached the customer as a failed advisor turn.
That is the problem this provider exists to solve.

OpenRouter is a **router**: one endpoint in front of many upstream model
providers. The shop sends one request; OpenRouter picks which upstream
provider serves it. So the fix for "one upstream provider is full" is not
a retry loop — it is **routing the request to a provider that has
capacity**, which is what OpenRouter does.

Hence the request carries:

```json
{ "provider": { "allow_fallbacks": true } }
```

With fallbacks off, an upstream `429` becomes a failed advisor turn. With
them on, the customer never finds out.

### #V — `require_parameters` and `sort` are deliberately **left unset**

Both were tempting, and both are wrong for this deployment.

`require_parameters: true` restricts routing to providers that support
*every* parameter in the request. The instinct is that it protects the
image: a provider that does not understand the image content part might
serve the request and quietly drop the photograph, and the advisor would
answer a photo question without having seen the photo.

But **image support is a modality, not a parameter**. OpenRouter routes
on the model's own declared input modalities without being asked. So the
flag buys no image safety — and it costs the one thing this provider
exists for: a wide pool of upstream providers to fall back to. The
`require_parameters` restriction would shrink exactly the pool that
absorbs a rate limit.

`sort` would pin the routing to a single priority — `throughput`,
`price` or `latency` — which *replaces* the router's own judgement. The
default routing is what already accounts for a provider's recent `429`
rate, shrinking its share of traffic until it recovers. Pinning the sort
would override precisely the behaviour that routes around the rate
limits.

So the routing preferences are `allow_fallbacks: true` and nothing else.
The restraint is the point.

### #W — The dialect is written **once**, in `openai-compatible.ts`

OpenRouter speaks the OpenAI chat-completions dialect. The request
shape, the message roles, the image format and the reply shape are
identical to OpenAI's; the differences are the URL, the headers and the
routing preferences.

So the protocol — the message building, the prompt assembly, the user
brief, the image format and the reply parsing — lives **once**, in
`src/lib/ai/openai-compatible.ts`, and both providers differ only in how
they address the endpoint.

The alternative was to copy the OpenAI provider and change the URL. That
would have produced **a second copy of the advisor's behaviour**, and
the two copies would have drifted. The day the language rule or the
marker convention changed in one, the other would still be sending the
old prompt — and the difference would show up as a model that suddenly
stopped recommending products, on one provider only, with no obvious
cause.

The OpenAI provider was refactored onto the shared module in the same
change, so the two are provably in lockstep: a test asserts that both
providers send byte-identical messages for the same request.

### #X — The retry covers what the router cannot

OpenRouter already routes around a rate-limited upstream provider, but it
does not re-run a request that failed *at the router's own level* — a
`429` on the account's own quota, or a `502` from a provider that was
mid-flight. Those are **transient**: the same request, sent a second
later, usually succeeds.

So the provider retries `429`, `408`, `500`, `502` and `503` — three
attempts, exponential backoff (300ms, then 600ms) — and does **not**
retry a `401` or a `404`, which will never succeed. The retries stay
inside the chat route's 30-second ceiling.

The `404` case gets its own message, naming `OPENROUTER_MODEL`, because
that is the fix: the deployment is pointed at a model OpenRouter does
not serve. A model id is a deployment setting, not a constant, and the
set of models OpenRouter serves changes — so `scripts/verify-openrouter.ts`
is the check that catches it, loudly, before a customer does.

### #Y — The optional headers are **omitted**, not sent empty

`HTTP-Referer` and `X-Title` are how OpenRouter attributes the app to
the shop on its dashboard. They are not credentials, and neither is
required.

They are omitted entirely when unknown, rather than sent as an empty
string. An absent header is a thing the server can interpret; an empty
one is a value it has to guess at. `HTTP-Referer` is read from
`NEXT_PUBLIC_SITE_URL` — the shop's own setting, already used for the
SMS order links — and `X-Title` from `OPENROUTER_TITLE`, defaulting to
the shop's name.

### #Z — The `openrouter` provider is re-exported as a **type only**

The same rule as #B. The provider module is reached through a dynamic
`import()` inside the `AI_PROVIDER === "openrouter"` branch, so nothing
OpenRouter-specific is evaluated in mock mode.

The OpenRouter provider loads no SDK — it uses the platform's `fetch`
— so the cost of loading it eagerly would have been small. The rule is
kept anyway, because a rule that holds for the expensive providers and
is relaxed for the cheap one is a rule that will be relaxed for the
next expensive one too. `export type` is erased at compile time, so it
carries the names without pulling the module in.

### #AA — The OpenRouter model must be **multimodal**, and the live probe is what found it

This is the most important thing the OpenRouter work uncovered, and it
was not visible from the documentation.

OpenRouter filters the upstream endpoints by image support
**automatically**. The routing funnel in the error metadata names the
step that failed, and a photo sent to a text-only model comes back as a
hard `404`:

> No endpoints found that support image input

A live probe (`scripts/probe-vision.ts`) confirmed it against both kinds
of model:

| Model | Text question | Photo question |
|---|---|---|
| `deepseek/deepseek-chat` (text-only) | answers | **404 — no endpoints found that support image input** |
| `deepseek/deepseek-v4.1-flash-1017` (multimodal) | answers | answers, and reads the image |

The consequence is not "the photo analysis is a bit worse". It is **the
photo analysis is broken**, on every attempt, for any customer who
attaches a photograph — which is the advisor's headline feature.

Two things follow from this.

**The default model is multimodal.** `DEFAULT_OPENROUTER_MODEL` is
`deepseek/deepseek-v4.1-flash-1017`, not the cheaper text-only
`deepseek/deepseek-chat`. The saving is not worth a broken feature, and
the "flash" tier is already the cheap one.

**The error names the setting.** A text-only model and a model that does
not exist are **both** `404`, and they need different fixes — "pick a
model that reads images" versus "check the model id". So the provider
inspects the error body for OpenRouter's own wording
(`support image input`, `Filter by Image Support`) and raises a
message that names `OPENROUTER_MODEL` and says the model cannot read
images. Without that, an operator would go looking for a typo in the
model id while the real problem was a missing capability.

This is also the argument for why the image-unsupported check is worth
its own branch rather than living in the generic `404` handler: the
status code alone cannot distinguish them, and the diagnosis is the
whole value of the message.

### #AB — `scripts/probe-vision.ts` earned its place

The probe script is throwaway by intent — it is a diagnostic, not a
test — but it is the thing that produced #AA, and it is worth keeping
because the answer it gives is **not** stable: which models are
multimodal changes as OpenRouter's catalogue changes, and a deployment
that moves `OPENROUTER_MODEL` needs a way to check the new id without
discovering the problem in front of a customer.

It is the complement to `scripts/verify-openrouter.ts`: the verify
script checks the *configured* model end to end, and the probe checks
the *capability* of a candidate model before it is configured.

### #AC — The request must state its **own ceiling**, or OpenRouter refuses it

This one was found by a live call, and it is the most consequential
thing in this section, because it makes the advisor fail **completely**
rather than degrade.

A chat-completions request may leave the reply length to the model. On
OpenRouter that has a cost: the provider reserves credit against the
model's **maximum context window** before it runs the request, not
against the tokens the reply will actually use. A live call with no
`max_tokens` was refused outright:

> This request requires more credits, or fewer max_tokens. You requested
> up to 131072 tokens, but can only afford 34923.

The advisor's reply is a few hundred tokens. The reservation was for the
whole context, and the request was refused for it — which means the
shop was asking OpenRouter to reserve 131072 tokens to send 1700.

So the request states `max_tokens`, and the number is set from
**measured** usage rather than from a guess:

| turn               | prompt tokens | completion tokens |
|--------------------|---------------|-------------------|
| greeting           |          1607 |                 99 |
| concern (Bengali)  |          1633 |                534 |
| question (English) |          1624 |                536 |
| long question      |          1686 |                676 |

Bengali is token-heavy and the completion figure grows with the question,
so the ceiling is set well above the longest observed reply while
staying far below the model's context window. A reply that hits the
ceiling is truncated — a far better outcome than a request that never
runs at all.

The `402` is also given its own message, because it is neither a rate
limit nor a fault in the request: it is the account's balance, and
retrying will not change it.

### #AD — The product ids travel on **three** channels, not one

The advisor needs the product ids back from the model. The original
answer was the marker line — the model appends `[RECOMMENDED: …]` and
the provider strips it. That worked, mostly, and the "mostly" is the
problem.

A live conversation check caught the marker being **dropped**: the model
recommended both products in prose and never wrote the line, so
`recommendedProductIds` came back empty and the shop attached **no
product cards at all**. The advice was still good; the products were
invisible.

Measured against the live API, on the conversation turn — the turn where
the customer has described their skin and a recommendation is genuinely
called for:

| channel | recovered |
|---------|-----------|
| the marker line | 6 / 8 runs |
| the tool call   | 0 / 8 runs |
| **the names**   | 8 / 8 runs |

So there are now three channels, consulted in order of how much the
model had to cooperate:

1. **The tool call.** The model was given a `recommend_products`
   function and asked to call it; the ids are its structured arguments.
2. **The marker line.** The convention the model has always been given.
3. **The names in the prose.** The model *mentioned* the products it put
   in front of the customer, and their names are in the candidate list.

The first two are **statements** — "I recommended these". The third is
an **observation** — "this product was mentioned" — and a model can
mention a product without recommending it:

> "Skip the retinol for now, and start with the cleanser."

Treating that mention as a recommendation would put a product card in
front of a customer who was just told to avoid it. So the third channel
is consulted **only** when the other two have both come back empty, and
only when the marker was **absent altogether** — a marker that says
`[RECOMMENDED: none]` is the model explicitly saying "I recommended
nothing", and falling through to the names after it would contradict it.

The conflicted products are excluded from the name channel too, because
a conflicted product is one the model has been asked to **warn about**:
naming it is the warning, not a recommendation.

All three channels are untrusted in exactly the same way, and the
service layer still validates every id against the allow-list.

### #AE — A tool call **without prose** is retried, not returned

Adding the tool channel introduced a failure the marker channel could
not produce: a model that answers with the function call and **no text
at all**.

```json
{ "content": null, "tool_calls": [{ "function": { "name": "recommend_products" } }] }
```

Left alone, that is worse than a missing product card — the customer
gets **no reply**. And it arrives as a perfectly healthy `200`, so no
status-code check can see it.

So the request says, in as many words, that the prose is the answer and
the call is only the bookkeeping. With that rule in place, prose came
back on every measured run.

And when it still does not — because it is a sampling accident, and the
same model writes the prose on the next attempt — the turn is
**retried**, on the same bounded budget as the HTTP retries.

The retry is keyed on the **presence of the call**, not on the ids it
carried. That distinction was a live bug: a greeting turn produces a
call with an **empty** id list — the model correctly saying "I
recommended nothing" — and keying on the ids meant that turn was not
retried and failed with "The AI provider returned an empty response".

### #AF — `scripts/probe-channels.ts` measures the channels **through the provider**

A probe that hand-rolls its own request measures the *probe*, not the
shop. What matters is what the provider actually returns, so the probe
goes through the provider and reports the ids the shop would attach.

It is the third diagnostic in the family, and each answers a different
question:

| script | question |
|--------|----------|
| `probe-vision.ts` | can this model read images? |
| `probe-tools.ts` | does this model emit tool calls? |
| `probe-endpoints.ts` | how many upstream providers can serve it, and do they support tools? |
| `probe-channels.ts` | which channel is actually carrying the ids? |
| `probe-credits.ts` | how much credit is left on the key? |

`probe-endpoints.ts` earns its place because of #AD: adding `tools` to
the request could in principle **shrink the pool** of upstream providers
able to serve it, and a smaller pool is a smaller set of providers to
fall back to when one of them is rate-limited. It measured 48/48
endpoints supporting tools, so the tool channel costs the routing
nothing.

### #AG — a diagnostic that cannot fail for the reason it reports is worse than no diagnostic

`probe-tools.ts` and `probe-vision.ts` posted to OpenRouter **without**
`max_tokens`. On a key with no purchased credit that produced a `402`,
and both probes printed it as evidence about the *model*:

- the tools probe said "this model may not support tools";
- the vision probe said "the model id is probably wrong".

Both were false. The model was fine. The request was oversized in the
eyes of the credit reservation (#AC), and the probe mistook a billing
failure for a capability finding.

A diagnostic that reports the wrong cause sends the reader to fix the
wrong thing — here, to swap out a model id that was working. So the
probes now state their own ceiling, and a `402` is reported as what it
is: **unknown, not a verdict**.

The general rule: a probe must be able to distinguish "the thing I am
testing failed" from "the probe itself could not run". The second case
is not evidence about the thing.

`probe-credits.ts` had the mirror-image bug. OpenRouter did not populate
`remaining_credits`, so it printed `?` and the reader could not tell a
zero balance from an unreadable answer. It now computes the balance and
says plainly what a zero balance means — a paid model would be refused
with a `402`, while a `:free` tier is still served without one.


---

## Email sign-in by one-time password

| # | Area | Decision |
|---|------|----------|
| 61 | Transport | Nodemailer over Gmail SMTP — `smtp.gmail.com:587`, STARTTLS **required** (`requireTLS: true`) |
| 62 | Credentials | `EMAIL_USER` / `EMAIL_PASS` (a Google **app password**, never the account password), optional `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_FROM` |
| 63 | Missing credentials | A **hard failure**. There is deliberately **no mock driver** for email, unlike the SMS gateway |
| 64 | The code | Six digits, from `crypto.randomInt`, uniform over the whole range |
| 65 | Storage | The code is **never stored**. Only a salted SHA-256 hash reaches the database |
| 66 | Lifetime | Ten minutes, stored as an absolute instant; single-use (the row is deleted on verification) |
| 67 | Attempt limit | Five wrong guesses per code, counted on the row |
| 68 | Resend cooldown | Sixty seconds, counted on a **separate attempt ledger** — not on the OTP row |
| 69 | The attempt ledger | Records the address and the time. It does **not** record whether the address had an account |
| 70 | Enumeration | The response distinguishes "no account at this address" from "code sent", and the cooldown is what makes that answer safe |
| 71 | Verification failure | **One** failure. A mistyped code, an expired code, an unknown code, a used code and an exhausted code are all the same `401` |
| 72 | Endpoints | `POST /api/auth/send-otp` and `POST /api/auth/verify-otp`, both public in the proxy |

### The rule that governs the whole feature

**The email is a credential, and it must never be silently dropped.**

The SMS gateway has a mock driver: it writes to a table instead of sending, so a developer never messages a real customer by accident. That is the right default for SMS, and it is the **wrong** default for email.

The email carries a one-time password — the thing that proves a customer owns an inbox. An email that is silently dropped is not a degraded experience; it is a sign-in that appears to work and then does not. So there is no mock driver, and a missing credential is a hard failure that surfaces as a `503` saying exactly that. A deployment that cannot send email must **say so**, not look healthy while delivering nothing.

The health endpoint reports `email: "configured" | "not-configured"` for the same reason: a customer discovering the broken sign-in at the sign-in screen is much worse than an operator discovering it on a dashboard.

### Why the code is hashed, and why with SHA-256

A row in `email_otps` is a live credential for as long as it has not expired. It sits in the same database as customer addresses, orders and reviews, and a dump of it is a list of credentials that work. Storing the six digits in the clear would make that dump directly replayable.

So the code is stored as a SHA-256 hash, salted with the row's own id.

**The salt is the row id** because it is unique by construction, already in the table, and it means two customers issued the same six digits do not have the same stored value. Without it, the table would double as a precomputed lookup of "which account does 123456 belong to?". The salt is **not** a secret and does not need to be — its job is to stop precomputation and to stop two equal codes from being equal on disk, not to make the hash irreversible.

**SHA-256 rather than bcrypt is deliberate, and it is the opposite of the password rule.** A password hash is deliberately slow, because a password is a secret the user chose and an attacker may try for years. A one-time code is not that: it has six digits and ten minutes of life. The search space is a million, and the salt defeats the rainbow table, so the only thing a slow hash would buy is server CPU on every verification — a cost paid by the shop, to protect a credential that is dead within the hour anyway.

### Why the row is deleted rather than flagged

A verified OTP is worthless. Leaving it behind — even as a consumed row — keeps a replayable hash in the table for as long as the row survives, and gives an attacker one more thing to take.

The deletion is also **conditional** — it only fires if the row is still there. Two concurrent requests carrying the same valid code would otherwise both read the row, both match, and both sign in. The conditional delete makes exactly one of them the winner.

### Why the attempt ledger is a separate table

This was a real bug, caught by the integration suite.

The obvious place for the resend cooldown is the OTP row: "when was the last code sent to this address?" — and that is exactly what the row knows. But an address that has **no account** never gets an OTP row, because there is nothing to sign in to.

And that address is precisely the one an attacker would probe. A cooldown that only applies to real customers is not a cooldown at all — it is a limit that excludes exactly the traffic it exists to stop. The enumeration oracle would be wide open: probe a thousand addresses as fast as the network allows, and the ones that answer `404` are the ones with no customers, while the ones that answer `429` are the ones that do.

So the *attempts* are recorded separately, in `email_otp_attempts`, and every request writes a row whether or not it produced a code. The cooldown is then a question about that table, and it answers identically for an address with an account and one without.

### What the attempt ledger deliberately does not hold

The address and the time. **Not** whether the address had an account, and **not** whether a code was sent.

A table that recorded the outcome would be a table that says which addresses belong to customers — which is the very thing the endpoint must not reveal, and which a dump of this database would then hand over wholesale. The integration suite asserts that the row written for an address with an account and the row written for one without have the **same shape**, so the distinction cannot be added later by accident.

### Why the response distinguishes "no account" from "code sent"

The obvious design is one uniform answer, and it would be wrong for the customer. A customer who asks for a code at an address the shop does not know needs to be told so — otherwise they sit in front of a form waiting for an email that will never arrive.

So the endpoint answers `404` for an unknown address and `200` for a known one, and the **cooldown** is what keeps that answer from being a cheap enumeration oracle: one address may be probed once a minute, so harvesting the customer list takes a very long time.

The two answers cost the attacker the same — one request, one minute apart — and the rate limit is counted in the database, so it holds across every instance of the deployment and survives a restart. A process-local counter would be reset on every restart and would not be shared between instances, which is exactly when a cap is needed.

### Why every verification failure is the same failure

A mistyped code, an expired code, a code that was never issued, a code that has already been used, and a code that has run out of attempts all produce **one** answer: `401`, with the same message, and no details.

If they produced different answers, the endpoint would tell an attacker how close they were. "This code exists but has expired" is a fact about a customer's account; "this code has five attempts left" is an invitation to try them.

The same reasoning applies to the *attempt counter*: the counter is a row update rather than a read-modify-write, so two concurrent wrong guesses both land and neither is lost. The naive version loses a count under a race, and a race is exactly when an attacker is trying.

### The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| A missing mail credential is a hard failure | `src/lib/email.ts` → `readSmtpConfig` | A dropped OTP is a sign-in that appears to work and does not |
| STARTTLS is required, not optional | `src/lib/email.ts` → `requireTLS: true` | Gmail refuses the credentials in the clear; an app password is a bearer secret |
| The transport is built lazily | `src/lib/email.ts` → `getTransport` | The storefront must still boot when the mail settings are absent |
| A malformed port is reported, not corrected | `src/lib/email.ts` → `readPort` | A deployment that meant 465 and got a typo should be told |
| The code is never stored | `prisma/schema.prisma` → `EmailOtp.codeHash` | A dump of the table must not be a list of codes that work |
| The code is single-use | `src/lib/auth/otp.ts` → `verifyOtp` | A verified code is worthless, and keeping it widens the leak window |
| The code expires after ten minutes | `EmailOtp.expiresAt` | The deadline is a property of the record, so it survives a restart |
| Five wrong guesses kill the code | `EmailOtp.attempts` | Six digits is a search space, not a wall |
| The cooldown covers unknown addresses too | `email_otp_attempts` | A limit that excludes the traffic it exists to stop is not a limit |
| The attempt ledger records no outcome | `EmailOtpAttempt` has only `email` and `createdAt` | A dump of the database must not be the customer list |
| One failure, not five | `src/app/api/auth/verify-otp/route.ts` | Different answers would tell an attacker how close they were |
| The endpoints are public | `src/proxy.ts` → `PUBLIC_PATHS` | Requiring a session to obtain a session makes the flow impossible |

### The bugs found and fixed while implementing it

**The cooldown did not apply to unknown addresses.** The first implementation counted the cooldown on the OTP row, so an address with no account — never given a row — was never cooled down. The integration test "cools the resend down for an address with no account too" caught it, and the fix was the separate attempt ledger described above.

**`randomInt` has a 48-bit range limit.** The OTP row's id was generated with `randomInt(0, Number.MAX_SAFE_INTEGER)`, and `Number.MAX_SAFE_INTEGER` is 53 bits — so the call threw `RangeError` on every request. The id is now generated with `randomBytes(16)`, which is 128 bits and has no such limit.

**`SEND_FAILED` fell through to a generic `500`.** The route translated `NOT_CONFIGURED` into a `503` but let a refused message become an `INTERNAL_ERROR`. A `500` says "the shop has a bug", and neither of these is a bug: both are now `503`, with different messages — one naming the deployment fault, the other telling the customer to try again shortly.

---

## Step 24 decisions (account verification & the dual-purpose code)

| # | Area | Decision |
|---|------|----------|
| 73 | Account state | `User.emailVerifiedAt DateTime?`. `null` means "not yet verified". A `Boolean` cannot tell "never asked" from "said no" |
| 74 | Registration | Creates the account **unverified** and mails a `SIGNUP` code. It issues **no session** |
| 75 | The purpose | `EmailOtp.purpose` (`OtpPurpose`: `SIGNUP` / `SIGNIN`). A code issued for one purpose **never** works for the other |
| 76 | The gate | The check lives where the **session is issued** — the password login and the OTP verification. A session that was never issued cannot be used |
| 77 | The refusal | An unverified account is refused with a `403`, and the refusal comes **after** the password check |
| 78 | The default purpose | `SIGNIN`. A request that does not say what the code is for is asking to sign in |
| 79 | The cooldown | Still **purpose-agnostic** — one mailbox, one mail budget, however many flows share it |
| 80 | The marked account | Pre-existing accounts are marked verified by a **script**, not by a migration |

### The rule that governs the whole feature

**Registration does not sign you in. Verification does.**

Registration proves almost nothing. It proves the person typing can reach an inbox — but only if they can read the mail that is about to arrive. A mistyped address, an address belonging to somebody else, an address harvested from a forum: each produces an account that receives the customer's order confirmations, their SMS alerts and their one-time passwords, and none of them is the customer.

Issuing a session at registration would make the shop believe it can reach the customer when it cannot. The verification step is where that belief is earned. So the account is created with `emailVerifiedAt: null`, a six-digit code is mailed, and the response says the account is waiting for that code. **No cookie is written.**

### Why the purpose is stored on the row

A signup code is otherwise a **valid sign-in code**. The verification lookup reads the row for the address, and the code hashes to the same value regardless of why it was issued — so an intercepted signup verification mail would hand the attacker an account permanently.

The difference is load-bearing, so it is in the data: `purpose` is a column, the lookup is scoped by it, and the row for the other purpose is **not merely rejected — it is not even read**. There is nothing to compare the submitted digits against.

The two purposes also have **different preconditions**, and each refuses the other's case:

- **SIGNUP** is for an account that has not been verified. An account that is already verified has nothing left to prove, so the request cannot be honoured.
- **SIGNIN** is for an account that exists and is usable. An account that has not been verified yet cannot be signed into, so mailing it a sign-in code would be mailing a code for a door that is not open yet.

Both refusals are reported as `sent: false, knownAddress: true` — the address *is* known; the request just cannot be honoured for it. The caller chooses the words, because "this account is already verified" and "this account still needs verifying" need different messages.

### Why the verification gate sits where it does

The gate is a check on `emailVerifiedAt === null`, and it lives in the two routes that **issue a session**:

- `POST /api/auth/login` — after the password check.
- `POST /api/auth/verify-otp` — after the credential check.

Not in `requireUser`, and not in a middleware. A session is only ever minted after the check, so a session that was never issued cannot be used, and every authenticated request does not pay for a database round-trip to re-ask a question that was answered when the session was created.

### Why the refusal comes after the password check

It is tidier the other way round: check the account's state first, and skip the expensive hash. But tidier here means an **enumeration oracle**. An attacker who does not know the password would learn which addresses are merely awaiting verification — a fact about the account's state, obtained without proving anything.

So the order is: password first, then the gate. A wrong password on an unverified account answers `401` with the same message as a wrong password on a verified one. The `403` is only ever seen by somebody who has already proved they know the password, so there is no enumeration left to protect.

### Why the cooldown stays purpose-agnostic

The resend cooldown is keyed by **address alone**, not by address-and-purpose. A customer who asks for a sign-in code and then asks for a signup code is still held to one request a minute.

If the cooldown were per purpose, the two flows would be two independent mail budgets for one mailbox — which is exactly the way to get an address suspended by Gmail, and the customer is the one who pays for it.

### Why pre-existing accounts are marked by a script, not a migration

A migration that sets `emailVerifiedAt` for every existing row would be the tidier way to do it, and it would silently mark **every** account in every deployment as verified — including the ones that registered with somebody else's address and never proved anything.

So it is a script (`scripts/mark-existing-users-verified.ts`), run deliberately, once, on the database that needs it. A deployment that has real registrations and wants the gate enforced decides which accounts to mark. The decision is an operational one, and it is made by a person who can see the accounts.

### Why the mail names the purpose

A customer who just registered has a verification code in their inbox; a customer who is signing in has a sign-in code. They look identical and mean different things, and a customer who cannot tell them apart will type the wrong one and conclude the shop is broken.

So the subject says which it is — "Your Euro Glam BD verification code" or "Your Euro Glam BD sign-in code" — and the body matches: a verification code *completes* something, a sign-in code *opens* something. The "if this was not you" line differs accordingly, because an unwanted signup verification means somebody registered with their address, and an unwanted sign-in code means somebody is trying to get in.

### The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| Registration issues no session | `src/app/api/auth/register/route.ts` | The account is unproved; a cookie would be a session for an address the shop cannot reach |
| The account is created unverified | `register/route.ts` → `emailVerifiedAt: null` | The inertness must not depend on a database default |
| The role is never read from the request | `register/route.ts` → `UserRole.CUSTOMER` | Otherwise anyone could self-register as an admin |
| A failed mail does not undo the registration | `register/route.ts` | A customer whose mail server had a bad minute must not lose their address |
| The purpose is scoped in the lookup | `src/lib/auth/otp.ts` → `verifyOtp` | A signup code must not be a sign-in code |
| The purpose is scoped in the deletion | `otp.ts` → `requestOtp` | Asking for one code must not destroy the other flow's pending code |
| The gate is where the session is minted | `login/route.ts`, `verify-otp/route.ts` | A session that was never issued cannot be used |
| The refusal comes after the password check | `login/route.ts` | Otherwise the gate is an enumeration oracle |
| The verification is a conditional write | `src/lib/auth/verification.ts` → `updateMany` | Two concurrent requests cannot both claim the first verification |
| The code is deleted on use | `otp.ts` → conditional `deleteMany` | A used code is worthless, and the row must not survive it |
| An administrator may not verify by role | `src/lib/auth/guards.ts` → `requireCustomer` | The storefront is for customers; the console is behind `requireAdmin` |

### The bugs found and fixed while implementing it

**The cart refused an administrator with a `403`.** `requireCustomer` demanded the `CUSTOMER` role, so an administrator browsing the storefront was told "This action is only available to customer accounts" — on **their own cart**. Every route that called it scoped its query by the caller's own id (`getCart(user.id)`, `listOrders(user.id, …)`, `placeOrder(user.id, …)`, `openSslCommerzSession(user.id, orderId)`), so ownership was already enforced by the query. The role check locked administrators out of the storefront for no security benefit. The admin-on-behalf-of-another distinction lives under `/api/admin/*`, behind `requireAdmin`.

**The advisor chat answered `500` for every provider failure.** `handleApiError` had no branch for `AiProviderError`, so every provider outage became a generic `INTERNAL_ERROR` — even though `AI_PROVIDER_ERROR: 502` was already in the error-code union. It now answers `502` with a retryable message, and the provider's own message, model name and key never reach the client.

**The login and register errors were not bugs.** The `401` on login and the `409` on a duplicate registration are both deliberate and documented: a uniform failure response so the endpoint cannot be used to enumerate accounts, and a conflict on an address that is already taken. The `500`s in the dev log were `curl` artifacts — a shell history expansion corrupting the JSON body — not application faults.

---

## Step 25 decisions (inventory, cost tracking & profit accounting)

| # | Area | Decision |
|---|------|----------|
| 25 | Cost columns | `Product.purchasePricePaisa` and `Product.sellingPricePaisa`, both **`Int?`** poisha. The request asked for `Float`; the schema's own header forbids it (see "Derived engineering rules"), and a float cost would put the drift directly on the profit figure — the number the feature exists to produce. |
| 26 | Missing cost | `NULL` means **"not known"**, never zero. A line whose cost is unknown is **excluded** from the profit arithmetic, and the count of excluded lines is reported alongside the figure. |
| 27 | Units sold | `Product.soldCount` is a **point-of-sale convenience counter**, not an accounting record. It moves in the *same* SQL statement as the stock decrement, and it is decremented when an order is cancelled. |
| 28 | Order-line cost | `OrderItem.purchasePricePaisa` **snapshots** the cost at the moment of sale, for the same reason `pricePaisa` already does. A supplier price rise tomorrow must not rewrite the profit of a sale made today. |
| 29 | Line-level discount | `OrderItem.discountAmountPaisa` holds the **coupon's** share of the order, allocated to the line. The product's own sale discount is **not** repeated there, because `OrderItem.pricePaisa` is already the price the customer paid per unit. |
| 30 | Profit formula | `profit = (pricePaisa − purchasePricePaisa − discountAmountPaisa) × quantity`, computed **per line**. One shared formula lives in `src/lib/admin/profit.ts`; the inventory row and the dashboard both call it. |
| 31 | Coupon allocation | Proportional to each line's share of the subtotal, with the **last line taking the remainder**, so the parts always sum to exactly the coupon's discount. |
| 32 | Revenue scope | Cancelled orders contribute nothing — the goods came back and the money was never taken. The same rule the growth metrics and the funnel already use, so the revenue on the dashboard, the analytics page and the profit panel are the same number. |
| 33 | Margin against zero | `null`, rendered "—". A percentage against a zero base is a division by zero wearing a percentage's clothes. |
| 34 | Fulfilment counters | **Already correct** — `getDashboardStats()` reads each status with its own `db.order.count()`. They were never static; the request's assumption was wrong. |

### Why the cost columns are `Int` and not `Float`

The request that prompted this feature asked for a `Float` purchase price and a `Float` selling price. The schema's header and DECISIONS.md both forbid it:

> Money is `Int` in the smallest unit (poisha), never `Float`. … `Float` is excluded because binary floating point cannot represent decimal amounts exactly and sums drift.

A float cost would put these two columns outside the one money convention this codebase holds to — and the drift it introduces would land directly on the **profit** figure, the number this feature exists to produce. A margin computed from a float cost is a margin that does not reconcile against a supplier invoice to the paisa.

So they are integer poisha, like every other money column. The reasoning is recorded at the head of the migration, where the next person to open it will read it.

### Why a missing cost is excluded rather than counted at zero

A line with **no recorded purchase price** is left out of the profit arithmetic.

The alternative — treating a missing cost as zero — would report a product that cost the shop ৳800 as having earned ৳1,200 of profit. The shop's actual profit would be overstated by exactly the cost it never recorded, and the figure would look precise.

So the profit reported is the profit on the lines whose cost is **known**, and the count of excluded lines is reported beside it. A margin computed over four lines out of two hundred is a different claim from a margin computed over all of them, and the panel says which one it is.

This is the same principle as the rest of the console's treatment of unknowns: **"not known" and "zero" are different values**, and a screen must never silently substitute one for the other. It is why the inventory row renders a dash for an unrecorded cost rather than ৳0, and why the product form's cost fields are blankable.

### Why `soldCount` is a counter and not a count

The obvious alternative is `COUNT(order_items)` joined on the product, which gives the same number. But the inventory screen needs that number for **every** product on the page, and a per-product count is a per-product query.

So the counter is maintained at the point of sale, where the quantity is already in hand: incremented when an order is placed, **decremented when the order is cancelled**.

Two properties make it safe:

- It moves in the **same SQL statement** as the stock decrement, so the two counters cannot disagree — a crash between two statements would leave the shop saying it sold stock it still has on the shelf.
- It is explicitly **not** the source of truth for money. The profit numbers are computed from the order items rather than from this column, so a counter that drifted would misreport a popularity ranking but could **never** misreport the shop's money.

### Why the cost is snapshotted onto the order line

`OrderItem.purchasePricePaisa` records the product's cost **at the moment of the sale**, for the same reason `pricePaisa` already is: the catalogue's cost moves — suppliers change their prices, the shop renegotiates — and a profit figure for a sale made last quarter must not silently change when the current supplier price does.

### Why the line-level discount holds only the coupon's share

A line's discount can come from more than the product's own `discountPricePaisa`: a coupon is applied to the order as a whole, and splitting that coupon across the lines is an **allocation rule**, not a fact about the product.

The product's own discount is **not** repeated in `OrderItem.discountAmountPaisa`, because `OrderItem.pricePaisa` is already the price the customer paid — it is written as `discountPricePaisa ?? pricePaisa` at the moment the order is placed, so it is already net of the product's discount.

Counting the product's discount a second time would double-count it, and the margin would be understated on every discounted sale — which is most of them.

### Why the coupon's allocation gives the remainder to the last line

The coupon's giveaway is split across the lines **proportionally to each line's share of the subtotal**, with the last line taking the remainder.

The remainder rule is what makes the parts sum to **exactly** the coupon's discount. Without it, a ৳100 coupon over three equal lines would lose a poisha to each `Math.floor`, and the sum of the parts would not be the coupon — so the order's line-level discounts would not add up to the order's coupon discount, and nobody could reconcile the two.

The last line takes the remainder because it is the only line where a one-poisha discrepancy is invisible: every other line's allocation is exact by construction, and the final line absorbs what is left.

### Why the revenue and the profit are **not** reconciled to each other

The dashboard's **Revenue** tile is the order value of everything not cancelled — shipping included. It answers "how much money came in".

The **Profit & margin** panel answers a different question: "how much of that survived the cost of the goods?". It is computed per order line, over the lines whose cost is known, and it reports how many lines it left out and why.

The two are deliberately **not** reconciled. Reconciling them would mean silently excluding the shipping and the uncosted lines from the headline number — and a headline number that quietly means something other than what it says is worse than two numbers that are each exactly what they claim to be.

### The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| The cost is never defaulted to zero | `src/lib/admin/catalog.ts` → `createData` | A product recorded as costing nothing reports a 100% margin |
| A `null` cost clears the recorded cost | `catalog.ts` → `updateProduct` | "Not known" is a deliberate edit; an absent field leaves it alone |
| A cost above the price is refused | `ProductFormDialog.tsx` | It is a loss on every sale, and far more likely to be the wrong box |
| The cost is snapshotted at the sale | `src/lib/orders/service.ts` → `placeOrder` | A supplier price rise must not rewrite history |
| The coupon is allocated with a remainder | `orders/service.ts` → `placeOrder` | The parts must sum to exactly the coupon |
| The counter moves with the stock | `orders/service.ts`, `admin/order-creation.ts` | Two counters in two statements can disagree |
| The counter comes down on cancellation | `src/lib/admin/orders.ts` → `changeOrderStatus` | A cancelled order was never sold |
| A line with no cost is excluded | `src/lib/admin/profit.ts` → `getProfitMetrics` | Counting it at zero would overstate the profit |
| The excluded count is reported | `profit.ts` → `excludedLines` | The reader must see what the figure covers |
| The margin is `null` against zero | `profit.ts` → `computeMarginPercentage` | A percentage against zero is a division by zero |
| The profit panel fails on its own | `src/app/admin/page.tsx` | A slow profit query must not take the morning check down |
| The fulfilment counters are read live | `src/lib/admin/stats.ts` → `getDashboardStats` | A static counter is a lie the operator acts on |

## Step 26 decisions (the admin settings, profile & preferences)

| # | Area | Decision |
|---|------|----------|
| 35 | Settings entry point | The settings live behind an **account menu** in the admin **header** — the admin's own name and avatar — rather than only in the sidebar. The sidebar is a *navigation* list; "my account" belongs next to the name that identifies it. The sidebar entry stays, so both routes work. |
| 36 | The two kinds of setting | The page is split into **the admin's own** details and **the shop's** configuration. The first belongs to one person; the second belongs to every customer. Conflating them would let a "support phone" edit change what every customer sees. |
| 37 | The profile's own service | `src/lib/admin/profile.ts` — separate from `site-settings.ts`, and writing to the **`users`** row rather than the `site_settings` row. |
| 38 | The id comes from the session | The profile's id is the **session's**, never a query parameter or a body field. The `where` clause names `actor.id`, and the patch type has no `id` member at all, so no request can write to somebody else's row. |
| 39 | The email is not editable | The email address is the account's **identity** — the sign-in key and the destination of every password reset — and the shop owns an email-verification flow. Until a self-service change can prove the new address, the field is **refused**, not accepted-and-ignored. |
| 40 | The role is not editable | A role change is a **privilege grant**, and a grant is somebody else's decision — made on the Users page, by another administrator, and recorded there. A self-service role field would let any admin promote themselves. |
| 41 | The SMS consent is not editable | `User.smsOptIn` is the only flag that authorises an SMS send, and it is a decision about **being messaged** rather than about what number to be messaged at. |
| 42 | Forbidden keys are refused, not stripped | The forbidden fields are declared as `z.unknown().optional()` and refused through `superRefine`. A Zod object that does not mention a key **strips** it in silence — so a schema that merely omitted them would report success for a change that had not happened. |
| 43 | The profile's own audit action | `ADMIN_PROFILE_UPDATED`, distinct from `SITE_SETTINGS_UPDATED`. A profile edit affects one person; a shop-settings edit affects every customer. The audit explorer filters on the action, so they have to be distinguishable there. |
| 44 | The phone number is recorded as a flag | The audit entry says "the phone number changed" — never the number. The trail is browsable by every admin and is copied into exports and backups. |
| 45 | Preferences live in the browser | The theme and the sidebar's collapsed state live in `localStorage`, not on the account. A cookie would force every route to be request-time, and a presentation preference belongs to the screen, not to the person. |
| 46 | Preferences apply immediately | No save button. A control that waited for a save would show the admin one theme while the page used another — and a card whose controls apply instantly but which still ends with a "Save changes" button teaches the admin to expect a step that is not there. |
| 47 | The preferences form writes through the shared store | The form and the sidebar's own toggle both write through `writeAdminShellPrefs`, so the form cannot set a value the sidebar never reads. |

### Why the settings are in the header as well as the sidebar

The request was for a Settings button in the admin **header or profile section**, and the reason it is not *only* in the sidebar is worth recording.

The sidebar is a **navigation list**: it enumerates the sections of the admin console, and each entry is a place to *do the shop's work* — fulfil orders, moderate reviews, adjust stock. Settings was already in that list.

But settings is not quite the same kind of entry. Two of the things now on the settings page are about the **person using the console** rather than about the shop: their own name and telephone number, and the way their console looks. Those belong next to the admin's name in the header, which is the one piece of the interface that already says *who is signed in*.

So the header carries an **account menu** — the avatar and the name — with the settings link, a direct link to the profile section, and the way out inside it. The sidebar entry stays, because an admin who thinks of settings as a *section* should still find it in the section list.

### Why the profile is a separate service from the site settings

They look alike — an admin, on a settings page, changing a name and a phone number — and they are genuinely different acts:

| | The shop's settings | The administrator's profile |
|---|---|---|
| Belongs to | the shop | one person |
| Seen by | every customer | nobody else |
| Stored in | `site_settings` | `users` |
| Audited as | `SITE_SETTINGS_UPDATED` | `ADMIN_PROFILE_UPDATED` |

A single service handling both would have made `supportPhone` and `phone` look alike in a diff, and the two would be one confused field. A "support phone" edited in the wrong form would change the number every customer sees; an admin's personal number edited in the shop's form would change nothing they expected.

### Why the forbidden fields are refused rather than silently dropped

This is the one place where the obvious implementation is quietly wrong.

Zod's `z.object()` **strips** keys it does not know. So a schema written as:

```ts
z.object({ name: ..., phone: ... })
```

would accept a body naming `role: "ADMIN"`, discard the field, and report success. The admin would see "Your profile has been saved" for a change that had not happened — which is exactly the failure mode the codebase's own rule forbids:

> **Invalid input is rejected, never silently ignored.**

So the forbidden keys are **declared** as `z.unknown().optional()` and refused through `superRefine`, following the same pattern the hero banner uses for its retired showcase keys. The message names the field, because "that request is not allowed" is not something an admin can act on — "your role cannot be changed here" is.

### Why the phone number is audited as a flag

The audit log's own schema comment says it plainly:

> Only status flags and order statuses are ever stored here — never a shipping address, never a price, never a phone number.

That rule is about the **content** of the trail rather than about who may read it: the trail is browsable by every admin, and it is copied out of the database into exports and backups. A number that *changed* is worth recording — "who edited the contact number on this account, and when" is a real question. The number itself is not.

So the entry records `"set"` rather than the digits.

### Why the preferences are stored in the browser

The theme and the sidebar's collapsed state are **presentation** preferences. Two reasons they live in `localStorage` rather than on the account:

- A cookie would have to be read in the root layout, which makes every route request-time and fails `next build` (decision #46 — the root layout must not read the session).
- A presentation preference belongs to the **screen**, not to the person. Tying it to an account would mean every device an admin signs in on shares one layout.

The consequence is that these settings follow the **browser**. A different browser, or a different machine, gets the default. That is the right trade for this kind of preference.

### The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| The profile's id comes from the session | `src/lib/admin/profile.ts` → `updateAdminProfile` | A request must not be able to name whose row to write |
| The `passwordHash` is never selected | `profile.ts` → `ADMIN_PROFILE_SELECT` | Excluding it at the query is stronger than stripping it later |
| The email, role and consent are refused | `src/lib/validation/admin.ts` → `superRefine` | A stripped key would report success for a change that never happened |
| The role and consent are never written | `profile.ts` → `data` | A privilege grant and a consent decision are somebody else's |
| The phone is recorded as a flag | `profile.ts` → the audit diff | The trail never holds a phone number |
| A no-op save writes no audit entry | `profile.ts` → `Object.keys(after).length > 0` | A save that changed nothing is not an action worth auditing |
| The profile card fails on its own | `src/app/admin/settings/page.tsx` | A slow profile read must not take the shop's settings down |
| The menu closes on Escape and on a click outside | `src/components/admin/shell/AdminProfileMenu.tsx` | A menu that traps the pointer has to be reloaded out of |
| The preferences write through the shared store | `PreferencesSettingsForm.tsx` → `writeAdminShellPrefs` | The form and the sidebar must not disagree |

## Step 27 decisions (the customer's own profile settings)

| # | Area | Decision |
|---|------|----------|
| 48 | The customer's settings page | A dedicated `/account/settings`, separate from `/account`. The account page is the customer's **dashboard** (their orders, and a read-only summary); the settings page is where those details are **edited**. Two pages, two jobs — mixing a summary with a pile of forms makes it unclear what is a fact and what is a form waiting to be submitted. |
| 49 | The customer's own service | `src/lib/account/profile.ts` — separate from the admin's `src/lib/admin/profile.ts`. A customer editing their own name is not an administrator action, and the two have different rules about what may be changed. |
| 50 | The id comes from the session | The profile's id is the **session's**, never a query parameter or a body field. The `where` clause names the caller's id, and the patch type has no `id` member at all, so no request can write to somebody else's row. |
| 51 | The email is not editable | The same reasoning as the admin profile (decision #39). The email is the account's **identity** — the sign-in key and the destination of every order confirmation — and the shop owns an email-verification flow. A self-service change would have to prove the new address before it could be trusted, so the field is **refused**. |
| 52 | The role is not editable | A role change is a **privilege grant**, and a grant is somebody else's decision. A self-service role field would let any customer promote themselves to an administrator. |
| 53 | The SMS consent is not editable | `User.smsOptIn` is the only flag that authorises an SMS send, and it is a decision about **being messaged** rather than about what number to be messaged at. It is set once, on the storefront's own consent flow. |
| 54 | The password hash is not editable | A body carrying a `passwordHash` would be a request to set a hash directly. Nothing in the system may do that; the password is changed through its own route, and only after the current password is verified. |
| 55 | The email verification timestamp is not editable | An unverified account is an account whose address nobody has proved. The customer cannot tick that box themselves. |
| 56 | Forbidden keys are refused, not stripped | Same as decision #42. The forbidden fields are declared as `z.unknown().optional()` and refused through `superRefine`. A Zod object that does not mention a key **strips** it in silence — so a schema that merely omitted them would report success for a change that had not happened. |
| 57 | The saved address is one `Json` column | `users.defaultAddress`, holding exactly the shape `shippingAddressSchema` already validates. The saved address and the checkout address share **one** definition of the shape, so they cannot drift apart and a saved address can never fail to satisfy the checkout. |
| 58 | An order's address is a snapshot | `Order.shippingAddress` is never rewritten. The saved address changes where the **next** order goes and nothing else — the courier works from the order's own snapshot, and the invoice for a March order still shows the address as it was in March. |
| 59 | One saved address, not an address book | A customer who moves re-types their address; they do not accumulate a history of them. A saved-address book would need selection, deletion, a default marker and a tie-breaker rule — all of it machinery for a problem this shop does not have. |
| 60 | The saved address pre-fills the checkout | The checkout's address form is pre-filled from the account, so a customer who has already said where they live does not type it again. It is a **pre-fill**, not a lock: every field stays editable, and the address the customer submits is what the order carries. |
| 61 | The password change has its own route | `POST /api/account/password`, not a field on `PATCH /api/account/profile`. A password change is not a partial update — it is an action with its own preconditions and its own failure mode. Folding it in would put `currentPassword` and `newPassword` beside `name` and `phone` in one body, and a form holding both could save a password change it never asked for. |
| 62 | The current password is required | A password change that does not ask for the current password lets anybody who walks up to an unlocked device change it and lock the real owner out. The current password is the proof that the person making the request is the person who owns the account — and it is what stops a shared shop counter or a family laptop from being a permanent takeover. |
| 63 | The current password is verified against the hash | With `verifyPassword`, never a string comparison. The check is a real cryptographic verification, not a guessable equality test. |
| 64 | The new password is compared to the old one on the plaintext | Two bcrypt hashes of the same password are different strings, so comparing the hashes would never match and the rule would be dead code that looked alive. |
| 65 | The password change does not sign the customer out | The customer is already signed in on the device they are using, and changing their own password is a deliberate act on their own account. Signing them out of the very screen they are using would be an odd reward for a security action. |
| 66 | No admin audit entry | The admin audit trail answers "what did an administrator do?". Recording every customer's keystroke in a log every admin can browse would be a privacy problem, not a feature. The change is written to the customer's own row, which is where the record of their details belongs. |
| 67 | The settings link is in the storefront account menu | The header's account dropdown — the one place in the shop that says *who is signed in* — carries **Settings** beside **Your orders** and the sign-out control. The `/account` page carries it as well, so both ways of looking for it work. |
| 68 | The forbidden fields are shown, not hidden | The email address and the SMS reminders appear on the page in a read-only state, each with the reason it cannot be edited here. A customer who cannot find the email field assumes the shop has hidden it; one who sees it greyed out, with the reason, knows it is fixed and why. |

### Why the customer's settings are a separate page, not a tab of `/account`

The `/account` page already exists and already shows the customer's name, email and refill-reminder status. The obvious move is to add the editable fields there.

But the account page's job is **"where is my order?"** — the order history leads, and the details follow in a sidebar as a read-only summary. That summary is doing real work: it tells a customer what the shop currently believes about them, without asking them to change anything.

Putting an editable form on the same page would blur that. A customer looking at "No mobile number on file" would find a form next to it, and the page would stop being a summary and become a form with an order list attached. Two pages, two jobs: `/account` is what the shop knows about you, `/account/settings` is what you tell the shop.

The link between them runs **both ways** — the account page links to the settings, and the settings page has the account page in its breadcrumb — so neither is a dead end.

### Why the shipping address is a `Json` column and not seven columns

The address already has a shape: `shippingAddressSchema` in `src/lib/validation/commerce.ts` validates it at the checkout. The saved address is *the same address*, and the point of saving it is that the customer should not have to type it again.

If the saved address were seven separate columns, there would be a second definition of the shape — a second set of lengths, a second set of validation messages, a second thing to keep in step with the checkout. The two would drift, and the drift would show up as a saved address that the checkout then refuses.

So the column is one untyped JSON object, and **both** places validate it with **one** schema. The saved address can never fail to satisfy the checkout, because it was built by the checkout's own definition.

The `notes` field is the exception, and it is **refused** rather than dropped. A delivery note ("please call before arriving") belongs to a particular delivery, not to a home address that will be reused for years — it belongs on the order, and it is already there.

### Why the address is one, not a list

A saved-address book needs: a list, a default marker, a delete action, a "set as default" action, and a rule for what happens when two rows both claim to be the default. That is a lot of machinery for a customer who has one home and one delivery address.

The real behaviour of the customer who moves is to re-type the address, not to accumulate them. One saved address is what the checkout actually needs, and one is a thing a customer can reason about without a help article.

### Why the password change is its own route and its own form

The password is the one field on the account page whose change is an **action** rather than an **update**:

- It has a **precondition** — the current password must be quoted.
- It has a **failure mode** a profile edit does not have — "your current password is not correct" is not a validation error about a field; it is a refusal of the whole request.
- It has a **hash** to compute, which is slow enough to be worth doing once, deliberately, rather than as a side effect of saving a name.

Folding it into `PATCH /api/account/profile` would put `currentPassword` and `newPassword` in the same body as `name` and `phone`. A form holding all of them would be a form that could save a password change the customer never intended — and a customer who edited their name would, without noticing, be running a password change they had not confirmed.

So it is `POST /api/account/password`, with its own form, and the two forms never save together.

### Why the current password is required

Without it, a password change is a **takeover**. Anybody who walks up to an unlocked device — a shop counter, a family laptop, a shared office — can set a new password and lock the real owner out permanently. There is no recovery path, because the recovery path is email, and the email is now attached to the account the attacker controls.

Requiring the current password turns the change into something only the owner can do. It is the same reason the customer must be verified before signing in at all (decision #5, and Step 24): the shop never lets an unproven party hold the account.

The check is done with `verifyPassword` against the stored hash — a real cryptographic verification, not a string comparison. A comparison would be both weaker and, against a hash the client cannot see, simply wrong.

### Why the customer profile writes no admin audit entry

The admin audit trail answers a question about the **shop's operators**: who changed a product's price, who refunded an order, who altered the announcement banner. Every entry is written by an administrator, and every entry is browsable by every administrator.

A customer editing their own name is not that. Writing it there would mean the trail — which every admin can browse and which is copied into exports and backups — became a log of every customer's contact details and keystrokes. That is a privacy problem, not a feature.

The change is written to the customer's own row, which is where the record of their details belongs. The admin trail stays about the shop.

### Why the settings link is in the storefront account menu

The requirement was a Settings entry beside "Your orders" and the sign-out control, and the header's account dropdown is the right place for it because that dropdown is the **only** place in the storefront that says *who is signed in*.

"Where do I change my details?" is asked by somebody who is looking at their own name. The person looking for that answer is already in the menu that identifies them, so that is where the answer belongs.

The `/account` page carries a link as well — both in the "Your details" card and in "Quick links" — so the customer who goes to their account page and reads "No mobile number on file" is one click from fixing it, rather than left at a dead end.

### The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| The profile's id comes from the session | `src/lib/account/profile.ts` → `updateCustomerProfile` | A request must not be able to name whose row to write |
| The `passwordHash` is never in the profile select | `profile.ts` → `CUSTOMER_PROFILE_SELECT` | Excluding it at the query is stronger than stripping it later |
| The email, role, consent, hash and verification date are refused | `src/lib/validation/account.ts` → `superRefine` | A stripped key would report success for a change that never happened |
| The role and the consent are never written | `profile.ts` → `data` | A privilege grant and a consent decision are somebody else's |
| The delivery note is refused on a saved address | `account.ts` → `savedAddressSchema.superRefine` | A note belongs to an order, not to an address that is reused for years |
| The current password is verified against the hash | `profile.ts` → `changeCustomerPassword` | A string comparison is not a verification |
| The new password is stored hashed | `profile.ts` → `hashPassword` | Never in the clear, never under a client-supplied key |
| A no-op patch is refused | `src/app/api/account/profile/route.ts` | A 200 that appears to have done something is worse than a 400 |
| The address form patches, never replaces | `account-settings-forms.tsx` → `dirty` | Correcting a typo in the name must not blank the phone number |
| The password form clears its fields after a change | `password-form.tsx` | The new password must not be left on a screen somebody walks away from |
| The account API is not public | `src/proxy.ts` → `PUBLIC_API_PREFIXES` | The proxy rejects an anonymous call before it reaches the database |
| The saved address pre-fills but does not lock the checkout | `checkout-form.tsx` → `savedAddress` | The customer always has the last word about where a parcel goes |

## Step 28 decisions (the Cloudinary storage driver)

The storage adapter interface was written for the local filesystem, with the explicit promise that the driver could be swapped without touching a call site. The Cloudinary driver is that swap.

| # | Area | Decision |
|---|------|----------|
| 69 | The driver is selected by `STORAGE_DRIVER` | `getStorageDriver()` in `src/lib/storage/index.ts` reads the environment and returns the local or the Cloudinary driver. Every storage function defaults to it, so **no call site names a driver**. The switch is a configuration change, not a code change. |
| 70 | The driver is imported statically | Not a dynamic `import()`. A dynamic import splits the module graph at runtime, and Next.js cannot then know the Cloudinary SDK is reachable from the server bundle — the failure surfaces as a missing import *at request time* instead of at build time. Static imports keep the build honest. |
| 71 | An unknown driver name is a hard failure | `STORAGE_DRIVER=s3` throws rather than falling back to `local`. A deployment that believes it is writing to Cloudinary while writing to the filesystem is a failure that stays hidden until the files go missing — a typo must be loud, not silent. |
| 72 | The key is persisted, not the URL | The driver returns `<scope>/<yyyy>/<mm>/<random>.<ext>` — the same shape the local driver produces. The public URL is derived at render time by `getUrl()`. This is the adapter's documented invariant, and it is the whole reason the swap is a config change: storing a URL would bake the driver into every database row. |
| 73 | The folder and the public id are separate | Cloudinary's `folder` option is a prefix it **prepends**, and the resulting public id includes it. Passing a public id that already begins with the folder stores the object at `euro-glam-bd/euro-glam-bd/…`, where no later lookup finds it. |
| 74 | The public id carries no extension | Cloudinary appends the format to the public id, so a public id ending in `.png` is stored as `….png.png`. The extension is stripped before the upload and restored afterwards, and the format lives in a separate Cloudinary field. |
| 75 | The key is derived from what Cloudinary reports | `put()` compares the public id Cloudinary returns against the key it asked for, and refuses the upload when they differ. A mismatch means every later lookup would miss the object, so it is a failure rather than a silent misfiling. |
| 76 | `delete()` really deletes | The Cloudinary driver calls `uploader.destroy`. An empty `delete()` would have made the cleanup job silently collect nothing while reporting success on every run. |
| 77 | `delete()` is idempotent | An already-absent object resolves successfully, because the cleanup job calls it repeatedly for keys it has already tried to remove. |
| 78 | `exists()` tells the truth | The old implementation returned `true` unconditionally — it always lied. It now performs a real lookup and returns `false` for an absent object. A `404` is an answer, not an error. |
| 79 | The 404 is read from `error.error.http_code` | The Cloudinary SDK nests the HTTP status one level down. The check reads both levels, because a future SDK version may flatten it. |
| 80 | The filename is CSPRNG-random | 16 bytes of `randomBytes`, rendered as 32 hex characters — the same 128-bit guarantee the local driver makes. The original implementation used `Math.random()` and a `Date.now()`-based public id, neither of which is safe against collision or guessing. |
| 81 | The configuration is read at call time | Not at module load. `cloudinary.config()` at module scope captures `undefined` in a build that does not use this driver, and makes the module unimportable in a test that stubs the environment. |
| 82 | A missing credential is a hard failure | `readConfig()` names the missing variables and refuses to write. A silent fall back to the local driver would let a production deployment believe it was writing to Cloudinary while writing to an ephemeral filesystem. |
| 83 | The extension comes from the detected MIME type | Never from the client's filename, exactly as the local driver does it. |
| 84 | The resource type is decided from the MIME type | Cloudinary keeps images and videos in separate namespaces, so an object uploaded as a video is not found by a lookup for an image with the same public id. The type is decided the same way in every operation. |
| 85 | The scope is still an allow-list | The Cloudinary driver rejects anything outside `STORAGE_SCOPES`, exactly as the local one does. |
| 86 | Malformed keys are refused before the API | A key must be four segments with none of them `.` or `..`. The local driver asserts the same shape on the filesystem; here it stops a crafted key reaching an HTTP request. |
| 87 | The `cloudinary` package is a real dependency | It was missing from `package.json` entirely, so the module did not resolve and the build failed. A driver that cannot be imported is not a driver. |
| 88 | `res.cloudinary.com` is an allowed remote pattern | `next/image` **throws** — it does not warn, and it does not fall back — when a remote image's hostname is not in `images.remotePatterns`. The throw happens during the render, so it takes the whole page with it, not just the one picture. The `onError` fallback in `ProductImage` cannot catch it: the component never renders. |
| 89 | The remote pattern is scoped to our own folder | `pathname: "/**/euro-glam-bd/**"`, not a bare `hostname` entry. A bare entry would allow the optimiser to be pointed at *any* image on Cloudinary's CDN — an open proxy for somebody else's traffic. |
| 90 | The storefront URL is derived from the configured driver | `imageUrl()` in `src/lib/format/image.ts` reads `STORAGE_DRIVER` and produces a Cloudinary URL or a `/uploads` path. It cannot import the driver: that module pulls `node:fs` into the browser bundle, which is a build error at best. |
| 91 | The driver and the client derive the **same** URL | `getUrl()` builds the URL by hand rather than through `cloudinary.url()`. The SDK's builder emits a **signed** URL (`?_a=<signature>`) derived from the API secret, which the browser bundle cannot reproduce without leaking the secret. The two derivations have to agree, because the image optimiser caches by URL — a mismatch would be two separate cached copies of the same picture. |
| 92 | The Cloudinary configuration must be **applied**, not merely read | `getUrl()` called `readConfig()` without `applyConfig()`. `cloudinary.url()` builds the delivery URL from the SDK's own configuration, so without a cloud name it has nothing to put in the hostname and throws. The bug was invisible while every call site happened to upload first — which configured the SDK as a side effect. |

### Why the driver was not simply switched on

The driver was implemented, configured, and — as it turned out — **unreachable**. `src/lib/storage/index.ts` had no `STORAGE_DRIVER` switch at all: every function defaulted to `getLocalStorageDriver()`, and the Cloudinary module was never imported by anything. Setting `STORAGE_DRIVER="cloudinary"` in `.env` changed nothing, and nothing said so.

That is the failure this step exists to prevent, and it is worth naming precisely: **the configuration was correct and the behaviour was still wrong**. Nothing about `STORAGE_DRIVER="cloudinary"` is wrong as a *setting*; it was simply never read by anything.

### Why the key is a key and not a URL

The adapter's interface documentation states the invariant plainly: *storage keys are persisted, not URLs*. `Product.images` and `AdvisorImage.storageKey` hold keys like `advisor/2026/10/ab12….webp`, and the URL is derived at render time.

The first version of the Cloudinary driver broke this: it returned `uploadResult.secure_url` as the key. That works, and it is exactly the trap. The moment a URL is persisted, the driver is baked into every row that holds one, and a future migration stops being a config change and becomes a data rewrite — the thing the interface was designed to avoid.

The driver now returns a key with the local driver's exact shape, so a key means the same thing whichever driver produced it.

### Why the Cloudinary details were established against the live API

Three of the decisions above (73, 74, 79) are not things that can be read off a documentation page and trusted. They are the result of uploading real objects to the configured Cloudinary account and watching where they landed:

- The `folder` option **prepends**, and the resulting public id **includes** the folder. Passing both stores the object at `euro-glam-bd/euro-glam-bd/…`.
- Cloudinary **appends the format** to the public id, so a public id that already ends in `.png` becomes `….png.png` — and the public id it reports back has no extension at all, because the format is a separate field.
- The HTTP status of a 404 is at `error.error.http_code`, one level below the top of the thrown error.

Each of these was found by a failed lookup and then a look at what Cloudinary had actually stored. A guess here would have produced a driver that uploaded successfully and could never find its own files again — which is worse than a driver that refuses to work.

### Why `next.config.ts` had to change

The driver was correct and the storefront would still have been broken.

`next/image` **throws** when a remote image's hostname is not listed in `images.remotePatterns`. It does not warn, and it does not fall back to a placeholder. The throw happens during the render, so it takes the **whole page** down rather than just the one picture — and the `onError` fallback in `ProductImage` cannot catch it, because the component never renders at all.

So with the Cloudinary driver selected, every product page would have failed to render, with an error like `Invalid src prop … hostname "res.cloudinary.com" is not configured under images in your next.config.js`.

The pattern is scoped to the project's own folder:

```ts
remotePatterns: [
  {
    protocol: "https",
    hostname: "res.cloudinary.com",
    pathname: "/**/euro-glam-bd/**",
  },
],
```

A bare `hostname` entry would also work, and would also allow the optimiser to be pointed at *any* image on Cloudinary's CDN — an open proxy for somebody else's traffic. The pathname confines it to this shop's own uploads.

### Why the client derives the URL rather than asking the server

`Product.images` holds storage keys, not URLs, so something has to turn a key into a URL at render time. There were two candidates:

- **Ask the server.** The server knows the driver and could render the URL. But the same derivation has to happen in the admin console, in the product card, in the cart, in the hero banner — a server round trip for each would be a request per image on every page.
- **Derive it on the client.** `imageUrl()` in `src/lib/format/image.ts` reads `STORAGE_DRIVER` and produces the right shape directly.

The client-side derivation is the one that was chosen, and the constraint that shaped it is that this module is imported by **client components**. It therefore cannot import the driver — `src/lib/storage/index.ts` reaches the local driver, which imports `node:fs`, and pulling that into the browser bundle is a build error at best. So the URL is derived from the driver's *name*, read from the environment at call time.

### Why the two derivations have to produce the same string

The driver and the client both derive a URL from the same key. If they produced different strings, the same picture would be fetched under two URLs — and the image optimiser caches by URL, so the shop would hold two cached copies of every image, and the cache would never serve the second one.

The first version of the driver's `getUrl()` used `cloudinary.url()`, which emits:

```
https://res.cloudinary.com/<cloud>/image/upload/v1/<public_id>?_a=<signature>
```

The client cannot reproduce that. The `?_a=` signature is derived from the API secret, and reproducing it in the browser bundle would mean shipping the secret to the client.

Both the `v1/` version segment and the `?_a=` signature are optional — the asset serves without them, which was confirmed against the live CDN — so the driver's `getUrl()` now builds the plain form by hand:

```
https://res.cloudinary.com/<cloud>/image/upload/<folder>/<key-without-extension>
```

That is the same string the client derives, and a test asserts it.

### The configuration bug the conformance test found

`getUrl()` called `readConfig()` but never `applyConfig()`. `cloudinary.url()` builds the delivery URL from the SDK's own configuration, so with no cloud name applied there was nothing to put in the hostname, and it threw `Must supply cloud_name`.

The bug was invisible to the driver's own tests, because every one of them called `put()` first — and `put()` applies the configuration as a side effect. The call that had no prior upload was the one that broke.

This is what the adapter conformance test (`tests/storage/adapter-conformance.test.ts`) is for. It exercises every driver through the interface alone, with no knowledge of the other's behaviour, and it called `getUrl()` on a freshly constructed driver. It found the bug on its first run.

### The guard rails

| Rule | Where it lives | Why |
|------|-----------------|-----|
| The driver comes from the environment | `src/lib/storage/index.ts` → `getStorageDriver` | No call site names a driver, so the switch is a config change |
| An unknown driver name throws | `index.ts` → `getStorageDriverName` | A typo must be loud, not a silent fall back to the local filesystem |
| The key is persisted, not the URL | `cloudinary.ts` → `put` | A persisted URL would make a future migration a data rewrite |
| The public id has no folder and no extension | `cloudinary.ts` → `keyToPublicId` | Cloudinary supplies both, and duplicating either misfiles the object |
| The stored public id is verified | `cloudinary.ts` → `put` | A mismatch means every later lookup would miss the object |
| The filename is CSPRNG-random | `cloudinary.ts` → `buildKey` | `Math.random()` and `Date.now()` are not safe against collision |
| A missing credential throws | `cloudinary.ts` → `readConfig` | A silent fall back would hide an ephemeral filesystem in production |
| `delete()` actually deletes, and is idempotent | `cloudinary.ts` → `delete` | The cleanup job calls it repeatedly; an empty method collects nothing |
| `exists()` returns the truth | `cloudinary.ts` → `exists` | A method that always returns `true` always lies |
| A 404 is an answer, not a failure | `cloudinary.ts` → `isNotFound` | The status is nested at `error.error.http_code` |
| The scope is an allow-list | `cloudinary.ts` → `put` | The same rule the local driver enforces |
| A malformed key never reaches the API | `cloudinary.ts` → `resolveKey` | Four segments, none of them `.` or `..` |
| The image and video namespaces stay apart | `cloudinary.ts` → `resourceTypeFor` | Cloudinary stores them separately, so the type must be decided consistently |
| The CDN host is an allowed remote pattern | `next.config.ts` → `images.remotePatterns` | `next/image` throws on an unlisted host, taking the whole page down |
| The pattern is scoped to our folder | `next.config.ts` → `images.remotePatterns` | A bare hostname entry would make the optimiser an open proxy |
| The client derives the URL from the driver name | `src/lib/format/image.ts` → `imageUrl` | The driver cannot be imported into a client bundle — it pulls in `node:fs` |
| The driver and the client agree on the URL | `cloudinary.ts` → `getUrl` | The optimiser caches by URL; a mismatch is two cached copies of one picture |
| The URL is unsigned | `cloudinary.ts` → `getUrl` | The signature needs the API secret, which the browser must never see |
| The configuration is applied, not just read | `cloudinary.ts` → `getUrl` | The SDK builds the URL from its own configuration |
| Every driver honours the same contract | `tests/storage/adapter-conformance.test.ts` | A driver that breaks the interface breaks every caller |




