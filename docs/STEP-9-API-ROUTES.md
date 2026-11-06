# Step 9 — API Routes & Transactional Checkout

Implementation guide for the Euro Glam BD MVP.

This document explains **why** the code is shaped the way it is. The code
itself is the specification; this is the reasoning behind it.

---

## 0. The shape of the whole thing

```
src/
  app/api/
    products/route.ts          GET  public catalogue, search, filters
    products/[id]/route.ts     GET  one product with rating + related
    categories/route.ts        GET  all categories with product counts
    categories/[slug]/route.ts GET  one category and its products
    cart/route.ts              GET  the cart + conflicts
                                POST add an item  (201)
    cart/items/[itemId]/route.ts
                                PATCH set a quantity
                                DELETE remove a line
    cart/clear/route.ts        DELETE empty the cart
    orders/route.ts            GET  order history
                                POST checkout   (201)
    orders/[id]/route.ts       GET  one order
  lib/
    api/errors.ts              ApiError + the single error path
    api/types.ts               the response envelope
    auth/guards.ts             requireCustomer()
    validation/commerce.ts     every Zod schema at the boundary
    pricing.ts                 money: the only place totals are computed
    catalog/service.ts         catalogue queries
    cart/service.ts            cart domain service
    orders/service.ts          the transactional checkout
    conflict-engine.ts         the rule-bearing conflict entry point
```

Three layers, and each has one job:

| Layer | May do | May not do |
|-------|--------|------------|
| **Route handler** (`app/api/**/route.ts`) | parse input, call a service, shape a response | contain business logic |
| **Service** (`lib/*/service.ts`) | business logic, database access | know about HTTP status codes beyond `ApiError` |
| **Pure module** (`lib/pricing.ts`, `lib/conflicts/`) | computation | touch the database, the clock, the network |

The rule that keeps this from rotting: **a route handler has no `if`
statement about business rules**. It validates, delegates, and returns.

---

## 1. The response envelope

Every endpoint answers with the same shape, success or failure.

```ts
{ ok: true,  data: … }
{ ok: false, error: { code, message, details? } }
```

The client never has to guess whether a 200 means "found" or "empty", and
never has to parse a bare object to find out what went wrong. `error.code`
is a **stable machine-readable string** (`VALIDATION_ERROR`, `CONFLICT`,
`NOT_FOUND`, …) — the `message` is for humans and may be reworded; the
code is a contract.

See `src/lib/api/types.ts`.

---

## 2. Validation — the only way in

**Every** request body and query string is parsed by a Zod schema before
it reaches a service. There is no "we'll validate that later" path.

### 2.1 Query strings are strings

`URLSearchParams` gives you strings. `page=3` is the string `"3"`, not
the number `3`. The schemas coerce explicitly:

```ts
page: z.coerce.number().int().min(1).default(1),
limit: z.coerce.number().int().min(1).max(60).default(20),
inStock: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
```

An invalid filter is **rejected**, not silently ignored. If a client sends
`sort=cheapest-ever`, the answer is 400 — not a default sort the client
did not ask for. Silently ignoring bad input is how a client ends up
showing the wrong products and nobody can work out why.

### 2.2 Normalisation happens once, at the boundary

```ts
category: categorySlugSchema.optional()   // lower-cases, validates shape
ingredient: z.string().trim().toUpperCase() // canonical upper case
```

The slug is lower-cased, the ingredient tag is upper-cased, the phone
number is normalised to `+880…`. After the schema, the database only has
one spelling of each of these to deal with, so a unique constraint on
`email` cannot be defeated by `Aisha@x.com` vs `aisha@x.com`.

### 2.3 The client cannot state a price

This is the most important validation rule in the codebase:

```ts
export const checkoutSchema = z.object({
  shippingAddress: shippingAddressSchema,
  paymentMethod: z.enum(["COD"]).default("COD"),
  confirmConflicts: z.boolean().default(false),
  note: z.string().trim().max(500).optional(),
});
```

There is **no price field**. A client that sends `totalAmountPaisa: 1`
has it dropped by the schema — the key does not exist in the parsed
output, so it cannot reach the order. This is verified by a test:

```ts
it("ignores a client-supplied price", () => {
  const body = checkoutSchema.parse({ shippingAddress, totalAmountPaisa: 1 });
  expect(body).not.toHaveProperty("totalAmountPaisa");
});
```

---

## 3. Money

**Money is integer poisha.** 1 BDT = 100 poisha. Never a float, never a
decimal, never a client-supplied number.

```ts
export const FLAT_SHIPPING_PAISA = 8000;
export const FREE_SHIPPING_THRESHOLD_PAISA = 300000;

export function effectivePricePaisa(product: PricedProduct): number {
  return product.discountPricePaisa ?? product.pricePaisa;
}
```

Three things worth noting:

1. **The `??`, not `||`.** A discount of `0` is a real price of zero — a
   genuinely free item. `||` would treat it as "no discount" and charge
   full price. This is why the test
   *"a zero discount is a real discount, not a missing one"* exists.

2. **One module.** `src/lib/pricing.ts` is the only place a total is
   computed. Not in a route handler, not in a service, not in the
   checkout. If the shipping rule changes, there is one line to change.

3. **Free shipping is inclusive of the threshold** (`>=`), and does not
   apply to an empty cart (`subtotalPaisa > 0 &&`), because free
   delivery on a ৳0 order would be free delivery for nothing.

---

## 4. The catalogue

`GET /api/products` is public. It supports search, category, ingredient,
new-arrival, best-seller, in-stock, a price range, six sort orders and
pagination.

### 4.1 The price filter is on the *effective* price

A product with a discount is priced at `discountPricePaisa`. Filtering on
the raw `pricePaisa` would show a product whose list price is over the
customer's ceiling but whose discounted price is under it — the product
the customer actually wants, hidden from them.

Prisma cannot compare two columns against each other, so this becomes
two explicit price paths:

```ts
conditions.push({
  OR: [
    { discountPricePaisa: { not: null }, discountPricePaisa: range },
    { discountPricePaisa: null,           pricePaisa: range },
  ],
});
```

> **This exact code had a bug.** The two paths were originally collected
> into `where.AND`, which joins them with **AND**. A product would then
> have to be discounted *and* not discounted simultaneously — so every
> price-filtered query returned an **empty catalogue** with a 200
> response. See `DECISIONS.md` §"Bugs found and fixed", bug 2. The rule
> that came out of it:
>
> - **Independent filters** → a list, combined with `AND`.
> - **Alternative filters** → a nested `OR` inside one entry of that list.
>
> Also note that `where.OR` is a single slot. Assigning to it twice drops
> the first assignment — which is why the search clause moved into the
> conditions list rather than staying at the top level.

### 4.2 Search is escaped

```ts
const escaped = escapeSearchTerm(query.search);   // % _ \ are escaped
```

Prisma parameterises the value, so this is not about SQL injection. It is
so that a customer typing `50%` gets products matching the literal text
`50%`, rather than the `%` acting as a wildcard.

### 4.3 Pagination counts the filtered set

`findMany` and `count` run in parallel via `Promise.all`, and both use
the same `where` clause. The `total` is the number of products that
*match the filters*, not the size of the table — so the pagination
metadata agrees with the results.

---

## 5. The cart

### 5.1 One cart per user, found by user

`Cart.userId` is `@unique`. The cart is located by `userId`, **never by a
client-supplied cart id**. There is no cart id in any request body. A
customer physically cannot address someone else's cart, because the
request never carries an identifier that could point at one.

Cart *lines* are scoped to the owning cart anyway:

```ts
await prisma.cartItem.findFirst({
  where: { id: itemId, cartId },     // both
});
```

So even if a customer guessed a valid line id belonging to another
cart, the query would not find it. And it returns the same 404 whether
the item does not exist or belongs to someone else — so the response
does not confirm that the id exists.

### 5.2 The cart is created lazily

A user who has never added anything has no cart row, and that is not an
error. `GET /api/cart` returns an empty cart. The row is created on the
first write. If two requests race to create it, the unique constraint
fires and the loser catches P2002 and re-reads the row.

### 5.3 Conflict checking on every write

The conflict engine (pure, deterministic, no I/O) is called on every cart
mutation, and the result is returned with the response.

**The cart warns and still adds.** A `BLOCK` conflict does not silently
reject the request:

```json
{
  "ok": true,
  "data": {
    "cart": { … },
    "newConflicts": [ { "ruleId": "AHA_RETINOL_BLOCK", "severity": "BLOCK", … } ],
    "hasBlockingConflict": true
  }
}
```

The reasoning: refusing to add a product is a decision the customer
should make. The platform's job is to make sure they know. The checkout
is where the decision becomes binding — and there, a `BLOCK` conflict
*is* refused unless confirmed.

---

## 6. Checkout — the transactional core

`POST /api/orders`. One Prisma **interactive transaction**:

```ts
const result = await db.$transaction(
  async (tx) => {
    // 1. Load the cart with its products
    // 2. Evaluate conflicts
    // 3. Price from the database rows
    // 4. Create the order and its items
    // 5. Decrement stock, conditionally
    // 6. Empty the cart
    // 7. Return the result
  },
  { maxWait: 5000, timeout: 10000, isolationLevel: "ReadCommitted" },
);
```

### 6.1 The conditional decrement

This is the line that makes overselling impossible:

```ts
const result = await tx.product.updateMany({
  where: { id: productId, stockQuantity: { gte: quantity } },
  data: { stockQuantity: { decrement: quantity } },
});

if (result.count === 0) {
  throw ApiError.conflict("Not enough stock for …");
}
```

The stock check and the decrement are **one statement**. The obvious
alternative is wrong:

```ts
const product = await tx.product.findUnique({ where: { id } });
if (product.stockQuantity < quantity) throw …;   // ← RACE
await tx.product.update({ where: { id }, data: { stockQuantity: product.stockQuantity - quantity } });
```

Between the read and the write, another transaction can commit. Two
customers checking out the last unit both read `stockQuantity: 1`, both
pass the check, both write `0` — and two orders exist for one item. The
conditional `updateMany` makes the database itself enforce the
invariant: only one statement can successfully decrement a row whose
stock is 1, so the loser gets `count === 0` and the whole transaction
rolls back.

Verified by the integration test *"does not sell the same unit twice
under concurrent checkouts"*: exactly one checkout is fulfilled, exactly
one rejected, stock lands on exactly 0, and exactly one order exists.

### 6.2 The price comes from the database

Inside the transaction, the cart is loaded *with* its products, and the
totals are computed from those rows:

```ts
const totals = calculateOrderTotals(
  cart.items.map((item) => ({
    product: { id: item.productId, pricePaisa: item.pricePaisa,
               discountPricePaisa: item.discountPricePaisa },
    quantity: item.quantity,
  })),
);
```

Nothing the client sent is involved. There is no code path by which a
client-supplied number can reach an order.

### 6.3 The order item is a snapshot

```ts
items: {
  create: cart.items.map((item) => ({
    productId: item.productId,
    productName: item.product.name,   // snapshot
    pricePaisa: effectivePricePaisa(item.product), // snapshot
    quantity: item.quantity,
  })),
}
```

The name and price are copied onto the order item. Renaming the product
or changing its price tomorrow does not rewrite yesterday's order — and
the customer can still be told what they actually paid. Verified by the
test *"snapshots the product name and price onto the order item"*.

### 6.4 Order status and payment status are separate

```ts
status:          OrderStatus.PENDING,       // has it shipped?
paymentStatus:   PaymentStatus.PENDING,     // has it been paid?
paymentMethod:   PaymentMethod.COD,
```

A COD order is `PENDING` / `PENDING`: not paid, and not dispatched. These
are different facts with different timelines, and collapsing them into
one column makes it impossible to answer "is this order paid?" without
also implying something about dispatch. The MVP accepts only COD
(`paymentMethod: z.enum(["COD"])`), but the columns exist from day one
so that adding a gateway later is a schema migration, not a redesign.

### 6.5 Everything rolls back together

The transaction covers the order, its items, the stock deductions and the
cart emptying. If the third item has insufficient stock, the first two
items' deductions are rolled back too. There is no partial order and no
phantom stock deduction.

Verified by *"rolls back the whole order when the stock is insufficient"*:
no order row, stock untouched, and the cart is still there so the
customer can adjust and retry.

### 6.6 A blocking conflict must be confirmed

```ts
if (evaluation.conflicts.some((c) => c.severity === "BLOCK") && !checkout.confirmConflicts) {
  throw new ApiError("CONFLICT", "…Please review the conflict and confirm to continue.", {
    conflicts: evaluation.conflicts,
  });
}
```

The 409 carries the conflict details — rule id, severity, title,
message, remedy, spacing advice — so the client can render the warning
and ask for confirmation. With `confirmConflicts: true` the order goes
through and the conflict is recorded on it.

### 6.7 Transaction conflicts are retryable

Prisma raises **P2034** when a transaction deadlocks or fails to
serialise. That is transient by definition — the same transaction
submitted again will usually succeed. It maps to 409 with a "please try
again" message, not to a 500.

---

## 7. Errors

`src/lib/api/errors.ts` provides one error path for every handler.

```ts
throw ApiError.notFound("Order not found.");
```

and the route wraps its handler:

```ts
try {
  // …
} catch (error) {
  return handleApiError(error);
}
```

`handleApiError` maps:

| Thrown | Response |
|--------|----------|
| `ApiError` | its own code and status |
| `ZodError` | 400, with `fieldErrors` keyed by field path |
| Prisma `P2002` | 409 — duplicate |
| Prisma `P2025` | 404 — not found |
| Prisma `P2034` | 409 — transaction conflict, retryable |
| anything else | 500 — logged server-side, generic message to the client |

The last row matters: an unrecognised error is logged in full and
returned as *"Something went wrong. Please try again."* Stack traces and
database errors never reach the client.

---

## 8. Next.js specifics

**`await connection()` outside the try block.** Every route that touches
the database calls it first, so the route is never prerendered at build
time. It must be outside the `try`, or the build-time call throws and the
route is treated as dynamic anyway — defeating the point.

**`context.params` is a Promise.** Next 16 delivers params asynchronously:

```ts
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const productId = productIdSchema.parse(id);
  // …
}
```

The id is validated with the same schema as a body field. A malformed id
is a 400, not a database query.

**Auth via `requireCustomer()`.** Cart and order routes call the guard
before doing anything. It throws `ApiError.unauthenticated()` (401) or
`ApiError.forbidden()` (403), which the shared error path turns into the
right response.

---

## 9. What was tested, and how

**241 tests pass** (151 before Step 9).

| Suite | Tests | What it proves |
|-------|-------|----------------|
| `tests/pricing/` | 20 | Discounts, free-shipping threshold, integer exactness |
| `tests/validation/commerce` | 37 | Query coercion, quantity bounds, address validation, client-price rejection |
| `tests/validation/schemas` | 16 | Phone normalisation across six spellings → one value |
| `tests/conflicts/engine` | 41 | The rules fire correctly; the default rule set is never empty |
| `tests/integration/catalog` | 6 | The effective-price filter, against a real database |
| `tests/integration/orders` | 8 | Transactions, rollback, concurrency, conflicts, against a real database |

The integration suites need a reachable PostgreSQL. When one is not
available they **skip** rather than fail, with a message saying so — an
unreachable database is an environment problem, not a defect in the code,
and a permanently red suite teaches people to ignore red.

### The three bugs this work found

These are worth reading, because each one had a shape that inspection
missed and only execution caught.

1. **The conflict engine silently no-opped.**
   `evaluateConflicts(products, rules = [])` defaulted to an *empty* rule
   set. The cart and order services imported the raw engine, so they
   got zero conflicts — no error, no warning, and a `BLOCK` rule that
   never fired. The checkout would have told a customer "no conflicts
   found" while ordering retinol next to an AHA. The default is now the
   platform rule set.

2. **The catalogue price filter matched nothing.** Described in §4.1. The
   two alternative price paths were AND-ed, so every price-filtered query
   returned an empty catalogue with a 200 response.

3. **`bdPhoneSchema` rejected `01712345678`** — the format customers
   actually type — despite its own docstring claiming to accept it. This
   one dates from Step 3 and was surfaced by a Step 9 test.

Each is now covered by a named regression test. The details are in
`DECISIONS.md`.

---

## 10. Running it

```bash
npm run dev                    # the app
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint
npm test                       # the whole suite
npm run verify:step9           # the Step 9 verification script
```

`verify:step9` is a script rather than a test because it exercises the
services end to end and prints a readable report — 39 checks across
pricing, the catalogue, cart ownership, conflicts, transactions, rollback
and concurrency. It needs a reachable database:

```bash
DATABASE_URL="postgresql://…" npm run verify:step9
```

---

## 11. Step 10 — what comes next

Step 9 built the API. What is still missing:

- **Admin routes.** Product and category CRUD, order status transitions
  (the `OrderStatus` enum already has the states; nothing moves them
  yet), review moderation (`isApproved` is already on the model).
- **The storefront.** The API is complete; the pages that consume it are
  not.
- **The advisor UI.** The `AiProvider` abstraction and the
  `filterBlockedCandidates` logic exist from Step 8, but there is no
  endpoint that uses them.
- **SMS reminders.** `SmsGateway`, `SmsLog` and the opt-in flag are in
  the schema from Step 2; the scheduled runner does not exist.
- **Uploads in the product flow.** The `StorageAdapter` and the magic-byte
  validation work; wiring them into product creation does not.

The schema is already in place for all of these. The work is in the
handlers, not in the data model.
