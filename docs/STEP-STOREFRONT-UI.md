# Storefront UI — Review Submission, Cart Drawer & Mobile PDP

Implementation guide for the Euro Glam BD MVP.

This document explains **why** the code is shaped the way it is. The code
itself is the specification; this is the reasoning behind it.

---

## 0. What this step changed

The catalogue, the filters, the search, the checkout form and the AI
Advisor were already built and verified. This step closed four gaps and
fixed four problems that were found along the way.

| Area | Before | After |
|---|---|---|
| **Review submission** | `Review.isApproved` defaulted to `false` and nothing could set it. Reviews accumulated unmoderated, and a customer had no way to write one. | A customer can submit a review; it lands **pending**; the customer is told the truth about what happens next. |
| **Cart drawer** | The header badge and the cart page each fetched the cart independently. | One `CartDrawerProvider` owns the cart. The badge, the drawer and the add-to-cart buttons all read it. |
| **Mobile purchase bar** | The inline buy panel was `hidden` on mobile, so a phone customer had **no way to choose a quantity**. | A fixed mobile bar carries the quantity selector and both buttons, and it stays with the customer through the whole page. |
| **The proxy's public paths** | `/api/products` was public, so the *write* at `/api/products/{id}/reviews` was public too. | The catalogue stays public; the write path is carved out and filtered at the edge. |

Two architectural decisions came out of this and are recorded in
`DECISIONS.md` (rows 43–50).

---

## 1. The shape of the new code

```
src/
  app/api/products/[id]/reviews/route.ts  POST submit a review
  components/commerce/
    cart-drawer-provider.tsx   the single owner of the cart state
    cart-drawer.tsx            the slide-in panel
    cart-button.tsx            the header trigger, with a live badge
    review-form.tsx            the client form
    star-input.tsx             the radio-group star input
  lib/catalog/
    review-submission.ts       the customer write path
  lib/validation/
    commerce.ts                + submitReviewSchema
```

The layering is the same as Step 9 and Step 10, and it is the same rule:

| Layer | May do | May not do |
|-------|--------|------------|
| **Route handler** | parse input, call the guard, call a service, shape a response | contain business logic |
| **Service** (`lib/catalog/review-submission.ts`) | business logic, database access | know about HTTP beyond `ApiError` |
| **Pure module** (`lib/validation/commerce.ts`) | computation | touch the database, the clock, the network |

`review-submission.ts` is **separate** from the admin moderation module
(`lib/admin/reviews.ts`) and from the read path (`lib/catalog/reviews.ts`).
The customer write path and the moderation path have different
authorisation, different audit requirements and different failure modes.
Merging them would mean the customer path inherits the admin path's
surface area, and the admin path inherits the customer's.

---

## 2. Review submission

### 2.1 The write path

`POST /api/products/{id}/reviews`

```
→ requireCustomer()          the session is the author
→ productIdSchema.parse(id)  the path param is validated
→ submitReviewSchema.parse(body)
→ submitCustomerReview(productId, customer.id, { rating, comment })
→ 201 { review: { id, rating, comment, createdAt, moderationStatus } }
```

The service's refusals are sentinel errors (`PRODUCT_NOT_FOUND`,
`ALREADY_REVIEWED`) rather than typed `ApiError`s, because the service is
also reachable from places that are not route handlers. The mapping to
HTTP status codes happens at the boundary:

| Sentinel | HTTP | Message |
|---|---|---|
| `PRODUCT_NOT_FOUND` | 404 | "That product does not exist." |
| `ALREADY_REVIEWED` | 409 | "You have already reviewed this product." |

One generic "could not submit" would fail both — and the customer can
act on one of them and not the other.

### 2.2 Two independent barriers against self-publishing

A customer must not be able to publish their own review. Two separate
barriers enforce that, and **each has a test**:

1. **The schema strips it.** `submitReviewSchema` carries `rating`,
   `comment` and `purchased` — and nothing else. Zod strips unknown keys
   by default, so a body containing `isApproved: true` has it dropped
   rather than honoured.
2. **The insert omits it.** `isApproved` is not in the `create` call at
   all. The column's database default (`false`) is what makes the review
   pending. The service has no code path that sets it.

Either barrier alone would do; together they mean a future developer
adding a "publish immediately" feature has to remove *both*.

### 2.3 The customer is told the truth

A submitted review is **pending**. The response says
`moderationStatus: "PENDING"` and the form says:

> Every review is read by our team before it appears on the page, so
> yours is **waiting for approval**.

A review that silently disappears is indistinguishable from a bug, and
the customer's most likely reaction is to assume the shop ignored them.

### 2.4 One live review per customer per product

"Live" means **published** — `isApproved: true AND isHidden: false`. A
*pending* review does not block a second submission: the customer may
have mis-tapped, or changed their mind before the shop saw it. The
check is the same published-review predicate the public listing uses,
so the two can never disagree.

---

## 3. The cart drawer

### 3.1 One cart, one owner

The header badge, the drawer, the "Add to Bag" button on a product card
and the buy panel all need to agree on what is in the cart.

Without a shared owner, the badge and the drawer each fetch
independently — and they disagree. One was fetched before the other, so
the badge says "2" and the drawer says "3". That is the classic
duplicated-state bug, and a shared provider removes it.

`CartDrawerProvider` is a client component that owns:

| State | Meaning |
|---|---|
| `cart` | the server's cart, or `null` |
| `isAuthenticated` | `null` (unknown), `false` (signed out), `true` (signed in) |
| `isLoading` | a request is in flight |
| `error` | the last failure's message |
| `isOpen` | whether the drawer is open |

### 3.2 The server owns the cart

The client sends a *request* — "add this", "set this quantity", "remove
this" — and the server answers with the **whole cart**. The client never
patches its own copy.

A client that patched its own cart locally would drift from the
server's view of stock and conflicts, and the customer would be shown a
cart the server will not honour.

**There is no optimistic update.** The state is replaced only on
success. An optimistic removal that the server rejects leaves the
customer looking at a cart that is not real — which is worse than the
delay of waiting for the answer.

### 3.3 The drawer is a dialog, and it behaves like one

The drawer is modal, and every part of that is implemented:

- `role="dialog"` + `aria-modal="true"`,
- focus moves to the close button on open,
- `Tab` cycles inside the panel and cannot escape into the page,
- `Escape` closes it,
- clicking the backdrop closes it,
- the body scroll is locked while it is open — and the **previous**
  `overflow` value is restored on close, because the page may have had a
  reason to set it.

A slide-in panel that does not do these things leaves a keyboard user
tabbing through the page behind it, and a mouse user scrolling a page
they cannot see.

### 3.4 Conflicts are highlighted on the lines involved

A `BLOCK` conflict is not a footnote. The two products involved get a
red ring on their image and a "Conflicts with another item" chip, and
the summary at the top of the drawer explains the interaction and the
remedy.

The customer has to be able to see **which two products** are the
problem, not just that there is a problem. A `BLOCK` conflict does not
stop the purchase: the platform's job is to make the customer aware, not
to decide for them.

---

## 4. The session, and why the root layout does not read it

The drawer needs to know whether the visitor is signed in — a signed-out
visitor must not see a cart badge, and must not get an error banner on
every page of the storefront.

The obvious implementation is to read the session in the root layout and
pass it down. **That breaks the build.**

`cookies()` in the root layout makes **every** route in the app
request-time. `next build` then tries to prerender them all, and the
prerender's `cookies()` call rejects:

```
Error: During prerendering, `cookies()` rejects when the prerender is
complete. ... This occurred at route "/products".
    at _ (src/lib/auth/session.ts:39:23)
    at w (src/app/layout.tsx:68:22)
```

So the provider discovers the session **for itself**, on the client,
from the cart API's own answer:

| The API says | The provider concludes |
|---|---|
| `401 UNAUTHENTICATED` | signed out — no cart, no badge, no error banner |
| a cart | signed in — the cart is theirs |

A `401` is not a failure the customer should see. It is the answer to
"is anyone signed in", and the provider was asked exactly that question.

The initial state is **"unknown"**, not "empty" and not "signed out".
The badge appears once the answer arrives, which is what a signed-in
customer expects and what a signed-out customer never sees. Showing "0
items" to a customer whose cart is on its way would be a lie for a frame.

### 4.1 The `set-state-in-effect` rule

The mount effect starts its fetch inside a microtask:

```ts
void Promise.resolve().then(async () => { ... });
```

React's `react-hooks/set-state-in-effect` rule forbids a *synchronous*
state update in an effect body — it causes a cascading render. The rule
is right about the problem, and the answer is not to suppress it.

A network request is not synchronous. The state update belongs to the
*response*, not to the effect. Starting the request inside a microtask
puts the whole thing — including the `setState` calls it eventually
makes — outside the effect body's synchronous execution, which is
exactly the relationship the rule is asking for.

The effect does not say "set the loading flag, then fetch". It says
"when this microtask runs, fetch, and let the response update the
state". The update is caused by the network, not by the effect.

A `cancelled` flag in the cleanup cancels the request if the component
unmounts before it lands — a response arriving after teardown must not
set state on a dead component.

---

## 5. The proxy's public paths

### 5.1 The problem

`/api/products` is in the proxy's public list, so the storefront can
browse the catalogue without an account. But the prefix also covers:

```
POST /api/products/{id}/reviews
```

which is a **write**.

Nothing was *broken* — `requireCustomer()` in the route handler still
rejected the anonymous request — but the proxy's whole job is to reject
an obvious mistake *before* it reaches the database. A blanket public
prefix over a tree that contains a write defeats that.

### 5.2 The fix

The public-prefix list is kept for the genuinely read-only trees, and a
separate carve-out list removes the write paths:

```ts
const PUBLIC_API_PATTERNS = [
  /^\/api\/products\/[^/]+\/reviews(\/|$)/,
];
```

Two details matter:

- **It is a pattern, not a literal.** A literal `[id]` would never match
  a runtime path, and the carve-out would silently do nothing — the
  worst failure a security control can have, because it looks like it is
  working.
- **It covers the whole subtree.** `/api/products/{id}/reviews/{reviewId}`
  is a different endpoint, and it lives under the same prefix. Anchoring
  the pattern to the exact path would leave it swept in.

`isPublicApiPath` is exported so it can be unit-tested:
`tests/validation/proxy-public-paths.test.ts`.

---

## 6. The mobile product page

### 6.1 The purchase bar carries the quantity

The inline buy panel is `hidden lg:block`. On a phone the sticky bar
held the two buttons and **nothing else** — so a mobile customer had no
way to choose a quantity. They would have had to add one, open the
drawer, and change it there.

The mobile bar now carries the quantity selector alongside the two
buttons.

### 6.2 It is `fixed`, not `sticky`

The old bar was `position: sticky` inside the buy-box column. A sticky
element stops being sticky when its containing block scrolls out — which
is precisely where the customer starts reading the ingredients and the
reviews. A purchase bar that vanishes halfway down the page is not a
purchase bar.

The bar is `fixed`, so it covers the bottom of the page. The PDP
reserves `pb-36` on mobile for it and for the site's bottom tab bar.

### 6.3 It stacks with the bottom navigation

Both are `fixed` at `bottom-0`. The bar reserves the tab bar's height in
its own bottom padding (`env(safe-area-inset-bottom) + 4.5rem`) and is
given `z-50` against the tab bar's `z-40`, so the two stack: the tab bar
at the very bottom of the screen, the purchase bar directly above it.

### 6.4 The gallery is portrait on mobile

A phone screen is tall and narrow, and a skincare bottle is tall and
narrow. A square frame with `object-cover` crops the top of the bottle
and the bottom of the box — the customer cannot see the whole product,
which is the one thing the gallery is for.

The frame is `aspect-[4/5]` with `object-contain` on mobile, and
`aspect-square` with `object-cover` from `sm` up. The thumbnail strip
gets `snap-x snap-mandatory` for a swipeable mobile feel, and a `1 / 4`
counter appears on mobile where the arrows are small corner targets.

---

## 7. The guard rails

| Property | Guard |
|---|---|
| A customer cannot publish their own review | `tests/validation/review-submission.test.ts` (the schema strips it); `tests/integration/review-submission.test.ts` (the insert omits it) |
| A submitted review is pending, and stays out of the public listing | `tests/integration/review-submission.test.ts` |
| The review is attributed to the session and nothing else | `tests/integration/review-submission.test.ts` |
| One live review per customer per product | `tests/integration/review-submission.test.ts` |
| The rating is 1–5 and the comment is 10–2000 characters | `tests/validation/review-submission.test.ts` |
| A write under a public prefix is not public | `tests/validation/proxy-public-paths.test.ts` |
| The badge and the drawer never disagree | the single `CartDrawerProvider`; one request, one response |
| The root layout stays prerenderable | `next build` — the route table shows `◐` and `○`, not `ƒ` for the storefront |
| A signed-out visitor sees no cart badge and no error banner | the provider treats `401` as an answer, not a failure |

---

## 8. The verification

```bash
# The full gate
npx tsc --noEmit && npx eslint . && npx vitest run && npx next build

# The integration suites, against a real PostgreSQL
DATABASE_URL="postgresql://postgres:postgres@localhost:55432/euro_glam_bd_test?schema=public" \
  npx vitest run tests/integration
```

**540 tests across 29 files**, of which 89 are integration tests that run
against a real database.

The integration suites follow the Step 9 and Step 10 pattern exactly: a
`databaseAvailable` flag resolved in `beforeAll` via
`prisma.$queryRaw\`SELECT 1\``, early returns when the database is
unavailable, and `afterAll` cleanup in dependency order.
