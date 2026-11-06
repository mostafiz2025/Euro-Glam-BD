# Step 11 — Admin Dashboard, Logout & Route Protection

## Context

Steps 1–10 built the platform: a public catalogue, a cart with
ingredient-conflict checking, a transactional checkout, and a backend
admin surface (review moderation, order fulfilment, SMS reminders) that
was reachable only over an API.

What was missing was the part an operator actually uses.

1. **There was no dashboard.** Every statistic existed in a service, and
   every one of them was reachable only by calling an API by hand. The
   admin surface was a set of endpoints, not a place.
2. **The admin surface had no pages.** `/api/admin/*` was protected, but
   `/admin/*` did not exist — so the proxy's protection of the admin
   prefix was protecting nothing the customer could actually *see*.
3. **There was no logout.** A signed-in admin had no way to end the
   session from the interface. The token simply expired.
4. **The session was never discovered client-side.** The cart provider
   inferred it from the cart API's answer, but the header had no account
   menu, so there was nowhere to put a logout button even if there had
   been one.

The outcome is an admin surface an operator can use without opening a
terminal: four pages, each one rendering the numbers **server-side** from
the same service the API calls, and a logout that genuinely ends the
session rather than merely navigating away from it.

### The non-negotiable constraint

The root layout must not read the session.

`cookies()` in the root layout makes **every** route request-time, and
`next build` then fails — the prerender's `cookies()` call rejects. This
is recorded as decision #46. So session discovery is done **client-side**,
from the cart API's own answer, exactly as the cart provider already
does it. The storefront stays prerenderable and the drawer stays correct.

---

## 1. Route protection — two layers

The admin surface has **two** halves, and they answer "no" differently:

| Half | Path shape | Answer for a non-admin |
|---|---|---|
| The API | `/api/admin/*` | `403` with the standard error envelope |
| The pages | `/admin/*` | A redirect to `/forbidden` |

They cannot be one predicate, because "not JSON" and "not HTML" are
different answers.

### 1.1 The proxy — the fast filter

`src/proxy.ts`:

```ts
const ADMIN_API_PREFIX = "/api/admin";
const ADMIN_PAGE_PREFIX = "/admin";

export function isAdminApiPath(pathname: string): boolean {
  return pathname === ADMIN_API_PREFIX || pathname.startsWith(`${ADMIN_API_PREFIX}/`);
}

export function isAdminPagePath(pathname: string): boolean {
  return pathname === ADMIN_PAGE_PREFIX || pathname.startsWith(`${ADMIN_PAGE_PREFIX}/`);
}
```

The prefix is anchored to a **path segment**, so `/administrator` and
`/admin-tools` are not the dashboard. Locking a page that has nothing to
do with administration would be a bug, not caution.

The new page branch runs **before** the storefront branch:

```ts
if (isAdminPagePath(pathname)) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const claims = await verifyToken(token);

  if (!claims) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  if (claims.role !== "ADMIN") {
    const url = request.nextUrl.clone();
    url.pathname = "/forbidden";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}
```

The `next` parameter is URL-encoded, so a path with a query string
cannot smuggle one into the redirect.

### 1.2 The layout — the authority

The proxy reads the role from the **token**. A token is a claim about
the past; the database is a claim about the present. An admin demoted an
hour ago still carries an `ADMIN` token, and the proxy would let them
through.

So the authoritative gate is `src/app/admin/layout.tsx`, which re-reads
the user from the database:

```tsx
export const instant = false;

export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  await connection();

  const user = await getOptionalUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/admin")}`);
  }

  if (user.role !== "ADMIN") {
    redirect("/forbidden");
  }

  return (/* … */);
}
```

Because the layout is a **server** component, the redirect happens before
any admin markup reaches the browser. A customer never sees the
dashboard shell and then a failed query beneath it — they see the
`/forbidden` page, full stop.

`metadata` sets `robots: { index: false, follow: false }`, so the admin
surface is never indexed.

### 1.3 Why both layers

A control that only works in one layer silently stops working when the
other layer changes.

When the admin surface was API-only, guarding `/api/admin` was enough.
The moment pages were added under `/admin`, a proxy that only knew about
the API prefix stopped protecting anything the customer could actually
*see*: the dashboard shell rendered, the navigation rendered, and only
the queries beneath it failed. The layout is what closes that hole; the
proxy is what catches the obvious mistake first.

---

## 2. The admin dashboard

### 2.1 Four pages

| Page | Route | What it answers |
|---|---|---|
| Overview | `/admin` | The shop's morning check |
| Inventory | `/admin/products` | What is on the shelf |
| Reviews | `/admin/reviews` | What is waiting for a decision |
| Orders | `/admin/orders` | Where every order sits |

`src/components/admin/admin-nav.tsx` links to all four and marks the
active one with `aria-current="page"`. The Overview link is active only
on the exact path, so `/admin/orders` does not light up "Overview".

### 2.2 The numbers come from the server

The pages call the services **directly**:

```tsx
const stats = await getDashboardStats();
```

They do not fetch `/api/admin/stats` over HTTP. A server component
fetching from its own application is a network round-trip to itself —
and because the route calls the *same* service, the two cannot disagree.

### 2.3 Zeros are a claim, not a fallback

```tsx
const stats = await getDashboardStats().catch((error: unknown) => {
  console.error("[admin] Dashboard statistics failed:", error);
  return null;
});

if (!stats) {
  return <AdminErrorState message="We could not load the dashboard numbers. …" />;
}
```

The failure case renders an error state, **not** zeros.

Zero is a claim about the shop. "We could not load the numbers" is a
claim about the connection. Conflating them is how a real outage turns
into a panic — or, worse, into a false all-clear that nobody checks.

The empty state and the error state are deliberately **different
components** (`AdminEmptyState` vs `AdminErrorState`). "No reviews are
waiting" and "We could not load the reviews" must not look the same.

### 2.4 The buttons come from the server's tables

The review moderation actions and the order status actions are built
from the **same closed tables** the services enforce:

```tsx
import { reviewState } from "@/lib/admin/reviews";
import { permittedOrderTargets, permittedPaymentTargets } from "@/lib/admin/orders";
```

So the admin is never offered a move that will be refused. A review in
`PENDING` offers only "Approve"; an `APPROVED` one offers only "Hide";
a `HIDDEN` one only "Restore". An order in `SHIPPED` offers only
"Deliver" — because `SHIPPED → CANCELLED` is not a legal transition and
the button would only ever produce a `409`.

### 2.5 The primitives

`src/components/admin/primitives.tsx` holds the shared vocabulary:

| Component | Purpose |
|---|---|
| `AdminCard` / `AdminCardHeader` | A titled panel, with an optional action slot |
| `StatTile` | A headline figure, with a `tone` of `neutral`/`warn`/`danger`/`good` |
| `StatusBadge` | A status pill, keyed by status string, with a neutral fallback |
| `AdminEmptyState` | "There is nothing here" |
| `AdminErrorState` | "We could not load this" |

### 2.6 The inventory page

The filter chips are `<Link>`s that preserve the current search, so they
are shareable and crawlable — and they are links, not buttons, because
they navigate.

The page parses `searchParams` with `adminProductQuerySchema.safeParse`.
A failed parse renders an error state ("That filter is not one we
recognise") rather than silently falling back to "all products" — a
silently-ignored filter shows the admin a list that does not match the
URL they are looking at.

The table renders on desktop and a card list on mobile, from the same
array — two layouts, one source of truth.

### 2.7 The stock adjustment form

`src/components/admin/stock-adjustment-form.tsx` takes a **signed
delta**: "+10 or -3", never "set to 42". The success message is
surfaced in the collapsed state with `role="status"`, so a screen reader
announces it without the form stealing focus.

---

## 3. The inventory service

### 3.1 A signed delta is relative

```ts
const newQuantity = current.stockQuantity + delta;

if (newQuantity < 0) {
  throw ApiError.conflict(
    `That adjustment would leave the stock at ${newQuantity}. There are only ${current.stockQuantity} units on the shelf.`,
    { productId, currentQuantity, requestedDelta: delta, resultingQuantity: newQuantity },
  );
}
```

A relative adjustment cannot clobber a concurrent change. If a customer
checks out while the admin is adjusting, the delta is applied to whatever
the quantity is *now*, and the units the customer reserved stay reserved.

### 3.2 A negative result is refused, not clamped

Silently setting the stock to zero would hide the admin's mistake.
Refusing it tells them the shelf does not hold that many.

And the refusal writes **nothing at all** — no stock change and no audit
entry, because both happen inside the one transaction that rolled back.

### 3.3 The conditional update

```ts
const updated = await tx.product.updateMany({
  where: { id: productId, stockQuantity: current.stockQuantity },
  data: { stockQuantity: newQuantity },
});

if (updated.count === 0) {
  throw ApiError.conflict("Someone else changed this product's stock while you were adjusting it. Reload and try again.");
}
```

The condition is the quantity the read observed, so a row changed
**between** the read and the write produces a `409` rather than a silent
overwrite.

Note what this does **not** do: it does not make two concurrent deltas
conflict. A signed delta is **commutative**, so two admins both adding
five correctly compose to "add ten", and the second transaction reads
the first's result and adds to it. That is the desired behaviour, and it
is what `tests/integration/admin-products.test.ts` proves.

### 3.4 The audit entry

```ts
await writeAuditEntry(tx, {
  actor,
  action: PRODUCT_ACTIONS.stockAdjusted,
  entityType: "product",
  entityId: productId,
  before: { stockQuantity: current.stockQuantity },
  after: { stockQuantity: newQuantity },
  reason: reason ?? null,
});
```

`writeAuditEntry` takes a `TransactionClient` and has deliberately **no**
overload accepting the root `db` client — so writing an audit entry
outside a transaction is awkward by construction. A stock change without
a record of who made it is worse than no change, because it looks
complete.

### 3.5 The stock bands are nested, not partitioned

`productStockWhere` produces four shapes:

| Filter | Shape | Meaning |
|---|---|---|
| `ALL` | `{}` | Everything |
| `IN_STOCK` | `{ stockQuantity: { gt: 0 } }` | **Buyable** |
| `OUT_OF_STOCK` | `{ stockQuantity: { lte: 0 } }` | Not buyable |
| `LOW_STOCK` | `{ stockQuantity: { gt: 0, lte: 5 } }` | A warning band |

An operator asks two different questions: *"what can a customer buy?"*
and *"what needs reordering?"*. A product with three units belongs to
**both** answers — it is buyable *and* it needs reordering.

Making the bands disjoint would mean `IN_STOCK` excluded low-stock
products, so the chip labelled "In stock" would omit products the
customer can actually buy. The filter and the count must use the same
shape, so the two would have to agree — and agreeing on a lie is worse
than overlapping.

So the invariants are:

- `lowStock <= inStock` — low stock is nested inside in stock.
- `inStock + outOfStock === all` — buyable and not-buyable *do* partition
  the catalogue.

The three-way sum `inStock + lowStock + outOfStock` is **not** the
total, and a test that asserted it was was asserting a property the
design does not have.

### 3.6 The counts and the pagination answer different questions

`counts.*` is computed over the **whole** table, so an admin can see
"8 low stock" and navigate to them even while looking at an unrelated
filtered list. `pagination.total` counts only what the current filter
matched. Neither is derived from the other, and both are useful.

---

## 4. The logout

### 4.1 The contract

A logout that does not actually end the session is the worst kind of bug
in an authentication system, because it *looks* like it works. The user
clicks "Sign out", the app navigates to the login page, and everything
appears to be fine — while a valid session token is still sitting in the
browser, and the next person to use the device is still signed in.

So the property under test is the **cookie**, not the navigation. The
navigation is the browser's job; the cookie is the server's.

Four parts:

| Part | Where | What it does |
|---|---|---|
| Clear the cookie | `POST /api/auth/logout` | Empty value, `maxAge: 0`, matching attributes |
| Reset the cart | `CartDrawerProvider.reset()` | Drops the cart, the error, the drawer, the session flag |
| Refresh the router | `router.refresh()` | Re-renders the server components so the header stops showing the signed-in state |
| Redirect | `router.replace("/login?next=%2F")` | `replace`, not `push`, so Back does not return to a page that now requires a session |

### 4.2 The route

`src/app/api/auth/logout/route.ts` exports **`POST` only**. A `GET`
logout is a logout a prefetcher or an `<img>` tag can trigger by
accident.

The cookie is cleared through `clearSessionCookie()`, which calls the
**same** `cookieOptions()` helper the login route uses — with `maxAge`
of `0` instead of the TTL:

```ts
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", cookieOptions(0));
}
```

The attributes match by *construction*, not by discipline. A cookie
cleared with different attributes is a *different cookie* to the
browser, and the original survives — with the session still in it.

The route answers with the standard envelope, so the client can tell
success from failure:

```json
{ "ok": true, "data": { "success": true } }
```

It is idempotent: logging out twice clears a cookie that is already
gone, which is a no-op, not a failure.

### 4.2.1 What the logout cannot do

The JWT itself cannot be revoked. It remains valid until its `exp`
passes, and a copy taken before the logout would still work. That is the
standard trade-off of stateless tokens.

If immediate revocation is required later, the token must be tracked
server-side — a session table, or a short TTL plus a refresh token. For
an MVP with a 7-day TTL this is an accepted trade-off; shortening
`AUTH_JWT_TTL_SECONDS` is the lever if the risk changes.

### 4.3 The client

`src/components/admin/logout-button.tsx` is a **button**, not a link,
because it runs a `POST`. It disables itself while pending, and it
surfaces a failure in an `sr-only` `role="alert"` region.

```tsx
const payload = (await response.json()) as ApiEnvelope<{ success: boolean }>;

if (!payload.ok) {
  setError(payload.error.message);
  setIsPending(false);
  return;
}

reset();
router.replace("/login?next=%2F");
router.refresh();
```

### 4.4 The cart reset

`CartDrawerProvider` gained a `reset()`:

```ts
const reset = useCallback(() => {
  setCart(null);
  setError(null);
  setIsOpen(false);
  setIsAuthenticated(null);
}, []);
```

The session goes to `null` ("not known") rather than `false` ("known to
be signed out"), so the provider re-discovers it from the next cart API
answer rather than asserting a fact it has not checked.

A second `reset()` is harmless, and the state does not leak the previous
user's cart to the next one.

### 4.5 Where the button lives

`src/components/layout/account-menu.tsx` is a client component that
discovers the session from `GET /api/cart` — a `401` means signed out,
a cart means signed in. It closes on outside pointerdown and on
`Escape`, returning focus to the trigger.

Signed in, it offers "Your account", "Your orders" and **Sign out**.
Signed out, it offers "Sign in" and "Create an account".

The same `LogoutButton` appears on `/account`, inside the Quick links
card.

---

## 5. The tests

| Suite | Needs a DB | Proves |
|---|---|---|
| `tests/validation/proxy-admin-paths.test.ts` | No | Both halves of the admin surface are covered; `/administrator` and `/admin-tools` are not; the two halves do not overlap. |
| `tests/auth/logout.test.ts` | No | The cookie is cleared with an empty value, `maxAge: 0`, matching `httpOnly`/`sameSite`/`path`; the standard envelope; idempotency. |
| `tests/admin/product-stock.test.ts` | No | The band `where` shapes and their disjointness; the adjustment schema (zero rejected, fractional rejected, ±10 000 bounds, reason length cap). |
| `tests/integration/admin-products.test.ts` | Yes | Atomicity; a refusal writes nothing; exactly-zero is allowed; a delta composes with a concurrent change; two concurrent deltas compose; the bands nest correctly. |

The logout test mocks `next/headers` (a recording `cookies()`) and
`next/server` (`connection`, which only resolves inside a request scope),
then imports the **real** `POST` handler. The assertions are about the
recorded cookie writes.

The integration suite follows the Step 9 pattern: a `databaseAvailable`
flag resolved in `beforeAll` via `prisma.$queryRaw\`SELECT 1\``, early
returns when unavailable, and `afterAll` cleanup in dependency order.

### The concurrency tests are the interesting ones

```ts
it("composes two concurrent adjustments rather than losing one", async () => {
  const results = await Promise.allSettled([
    adjustProductStock(actor, productId, 5),
    adjustProductStock(actor, productId, 5),
  ]);

  expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
  // 10 + 5 + 5. The two adjustments composed; they did not overwrite.
  expect(row?.stockQuantity).toBe(20);
  expect(audits).toHaveLength(2);
});
```

This test was originally written the other way round — asserting that one
winner and one `409`. Two diagnostic scripts showed the truth: a signed
delta is commutative, so both succeed and compose to the correct total.
The service was right; the test and the service's doc comment both
encoded the same wrong assumption, and both were fixed.

---

## 6. Files

### Created

| Path | Purpose |
|---|---|
| `src/app/admin/layout.tsx` | The authoritative gate — re-reads the role from the database |
| `src/app/admin/page.tsx` | The overview |
| `src/app/admin/products/page.tsx` | The inventory list |
| `src/app/admin/reviews/page.tsx` | The moderation queue |
| `src/app/admin/orders/page.tsx` | The fulfilment desk |
| `src/app/forbidden/page.tsx` | The "that area is for staff" page |
| `src/components/admin/primitives.tsx` | The shared UI vocabulary |
| `src/components/admin/admin-nav.tsx` | The section navigation |
| `src/components/admin/logout-button.tsx` | The logout control |
| `src/components/admin/stock-adjustment-form.tsx` | The signed-delta form |
| `src/components/admin/review-moderation-actions.tsx` | The legal moderation actions |
| `src/components/admin/order-status-actions.tsx` | The legal order transitions |
| `src/components/layout/account-menu.tsx` | The profile menu with the logout |
| `src/lib/admin/products.ts` | The inventory service |
| `src/lib/admin/stats.ts` | The dashboard statistics service |
| `src/app/api/admin/products/route.ts` | The inventory list API |
| `src/app/api/admin/products/[id]/stock/route.ts` | The stock adjustment API |
| `tests/validation/proxy-admin-paths.test.ts` | The proxy's admin routing decision |
| `tests/auth/logout.test.ts` | The logout route |
| `tests/admin/product-stock.test.ts` | The band shapes and the adjustment schema |
| `tests/integration/admin-products.test.ts` | The inventory service against a real database |

### Modified

| Path | Change |
|---|---|
| `src/proxy.ts` | The `/admin/*` page branch; `isAdminApiPath` / `isAdminPagePath` |
| `src/lib/admin/audit.ts` | The `PRODUCT_ACTIONS` lookup |
| `src/components/commerce/cart-drawer-provider.tsx` | `reset()` |
| `src/components/layout/header.tsx` | The `<AccountMenu />` replaces the bare account link |
| `src/app/account/page.tsx` | The logout button |
| `package.json` | `vitest` added to `devDependencies` |

### Not touched

| Path | Why |
|---|---|
| `src/lib/auth/guards.ts` | `requireAdmin()` already exists and is correct |
| `src/lib/api/errors.ts` | `handleApiError` already maps every error this step throws |
| `src/app/layout.tsx` | Reading the session here would make every route request-time and break `next build` |

---

## 7. Verification

```bash
# 1. Typecheck and lint
npx tsc --noEmit && npx eslint .

# 2. The full suite, with a reachable PostgreSQL
DATABASE_URL="postgresql://postgres:postgres@localhost:55432/euro_glam_bd_test?schema=public" \
  npx vitest run

# 3. The build
npx next build
```

Expected: **583 tests passing**, a clean typecheck and lint, and a build
in which the four admin pages are `ƒ` (dynamic, request-time) and
`/forbidden` is `○` (static).

The throwaway PostgreSQL used in Step 9 (`initdb` + `pg_ctl` on port
55432, data dir `.tmp-pgdata/`, already gitignored) is reused for the
integration tests.
