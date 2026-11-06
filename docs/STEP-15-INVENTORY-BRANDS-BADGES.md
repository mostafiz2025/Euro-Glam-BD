# Step 15 — The inventory table, brand display and dynamic badges

**Scope.** The admin inventory table gains a product thumbnail, the brand
above the title, and both prices. The admin product form's two hardcoded
checkboxes become a **badge editor** — a closed set of known badges plus
free-text custom tags — backed by a new `Product.badges` column.

**Status.** Implemented and verified: 968 tests passing across 55 files,
clean `tsc --noEmit`, clean `eslint .`, a successful `next build` with
`/admin/products` rendering as `ƒ` (dynamic), and
`scripts/verify-step15.ts` passing every check.

---

## 1. What the inventory row shows

| Column | Before | After |
|---|---|---|
| Product | the name, linked | a **thumbnail**, the **brand** above the **title**, the badge pills |
| Price | the effective price | the effective price, the **struck-through original**, and the discount percentage |

### 1.1 The thumbnail

The row's image is a **derived** URL. `Product.images` holds storage
*keys*, not URLs — the same contract the upload pipeline established in
Step 14 — and `imageUrl()` turns the key into the public path at render
time. So:

- The row keeps working if the storage driver is swapped for a bucket.
- A legacy row holding an absolute filesystem path is normalised to its
  key on read, and renders its real image rather than a broken URL.
- The row's image list comes from the **existing** `ADMIN_PRODUCT_SELECT`
  — no second query, and no second shape of the same data.

A product with no image gets an empty brand-gradient tile, not a broken
image icon. The storefront's `ProductImage` component does the same
thing, for the same reason.

### 1.2 The brand

There is **no `Brand` model** in the database. A product is a name, a
category and a price, and the brand has always lived inside the name:

```
"CeraVe Hydrating Facial Cleanser"      → brand "CeraVe"
"The Ordinary Niacinamide 10% + Zinc 1%" → brand "The Ordinary"
"La Roche-Posay Effaclar Purifying Gel" → brand "La Roche-Posay"
```

Adding a `Brand` table, a foreign key, a migration and a seed rewrite
would be a large change for a string that is already in the column. So
`src/lib/format/brand.ts` **derives** the brand.

The derivation is a **closed registry**, not a heuristic. The tempting
alternative — split on the first word — is wrong, and visibly so:
"The Ordinary" would be branded "The". So:

1. The brand must be a **prefix** of the name, followed by whitespace.
   "CeraVe" must not match "Ceramide Cream" or "CeraVexfoliant".
2. The match is **case-insensitive**.
3. The **longest** registered prefix wins, so "Musta Baby" beats
   "Musta Makeup"'s shared prefix and "The Ordinary" is never "The".
4. A name whose prefix is **not registered** yields **no brand**, and the
   title is the whole name.

That last rule is the important one: **the derivation never guesses**. An
empty brand cell is honest; "The" is not. Adding a brand to
`KNOWN_BRANDS` is a deliberate act — the entry means "products whose
names start with this belong to this brand".

The registry covers the brands the shop stocks: La Roche-Posay, Musta
Makeup, Musta Baby, The Ordinary, CeraVe, Bioderma, Neutrogena,
Maybelline, Vichy.

### 1.3 Both prices

The customer pays the discount price, but an admin judging a discount
needs to see what the product was worth before it. A row showing only
the effective price cannot answer "is this discounted?" So the row shows:

- the effective price (what the customer pays),
- the original price, struck through,
- the discount percentage.

All three come from the two prices the row already carries, and the
percentage from the same `discountPercent()` helper the storefront uses.
A product with no discount shows one price and no percentage — the
"0% off" badge would be worse than no badge.

---

## 2. The badge system

### 2.1 The column

```prisma
  /// Promotional badges — the closed set of known badges ("New Arrival",
  /// "Best Seller", "Discount Offer", "Limited Edition") plus any
  /// free-text custom tag the shop needs for a one-off campaign.
  ///
  /// The list is the **single source of truth** for the promotional
  /// labels on a product. `isNewArrival` and `isBestSeller` below are
  /// a *mirror* of two entries in this list, maintained by the admin
  /// catalogue service on every write — the storefront reads the
  /// booleans, so it does not have to know about the badge list.
  badges String[] @default([])
```

A scalar list cannot carry a `@@index` in PostgreSQL, so it is
deliberately not indexed. The catalogue filters on the booleans, which
are.

### 2.2 The backfill

The seeded rows already carried the two boolean flags, and some were set.
Leaving the badge list empty would **desynchronise** them: the storefront
would show "New", the admin form would show nothing, and the first save
would clear the flag.

So the migration backfills each row's list from its flags:

```sql
UPDATE "products"
SET "badges" = ARRAY_REMOVE(
    ARRAY[
        CASE WHEN "isBestSeller" THEN 'Best Seller' END,
        CASE WHEN "isNewArrival" THEN 'New Arrival' END
    ],
    NULL
)
WHERE "isBestSeller" = true OR "isNewArrival" = true;
```

`ARRAY_REMOVE(..., NULL)` drops the element a false flag produces — a
`CASE` with no `ELSE` yields `NULL`, and `NULL` is not a valid badge.
(`ARRAY(CASE ..., CASE ...)` is invalid PostgreSQL; the `ARRAY[...]`
form is the one that parses.)

### 2.3 The list is the source of truth

The storefront's product card and product page render `isNewArrival` and
`isBestSeller` as booleans. Rather than rewrite the storefront's badge
rendering, the **badge list is the source of truth** and the two booleans
are a **mirror** of two entries in it.

`resolveBadges()` in `src/lib/admin/catalog.ts` keeps them in step, in
one place, on every write:

```ts
function resolveBadges(
  badges: readonly string[],
  legacyNewArrival: boolean | undefined,
  legacyBestSeller: boolean | undefined,
): { badges; isNewArrival; isBestSeller }
```

It is called from both the create and the update path, so no write can
leave the two out of step.

### 2.4 The legacy booleans still work

An older client knows nothing about the badge list, so `isNewArrival` and
`isBestSeller` remain accepted on the wire — and they may only ever
**add** to the list, never remove from it, because the list is the source
of truth.

They are now **optional** on the create schema rather than defaulted to
`false`. A client that sends only the badge list must not also be made
to send a boolean that says the same thing.

### 2.5 "Discount Offer" is derived, never stored

Whether a product is discounted is a fact about its two **prices**, and
prices change. A stored "Discount Offer" badge on a product whose
discount was removed yesterday is a lie the storefront would tell.

So:

- The schema **refuses** to store it — `productBadgeSchema` has a
  `.refine()` that rejects it with "The discount badge is set
  automatically from the prices."
- The admin form shows it as a **read-only note** — a disabled checkbox
  labelled "Discount Offer (from the prices)" — so the admin can see the
  product is discounted but the flag is never theirs to set and stale.
- The storefront derives the badge from the prices at render time.

### 2.6 The editor

`src/components/admin/products/ProductBadgeEditor.tsx` is a controlled
client component:

- One checkbox per **known badge**, except the derived one.
- A free-text field for a **custom tag**, with `Enter` adding it rather
  than submitting the form, and a removable pill per tag.
- A custom tag that matches a known badge is **canonicalised** into it,
  so "best seller" becomes "Best Seller" rather than a second spelling.

The known set plus free text is deliberate. The closed set is what makes
the checkboxes useful (an admin picks rather than types, so a typo
cannot end up on a storefront); the free text is what makes the feature
complete (a closed set alone cannot hold "Eid Special 2026"). Neither
alone is enough.

### 2.7 The validation

| Rule | Why |
|---|---|
| A badge is trimmed, 1–40 chars | A badge is a label, not a sentence. |
| At most 12 badges | A product with twenty badges has a badge problem, not a promotional one. |
| No duplicates | The check is on the **normalised** list, so `["best seller", "Best Seller"]` is caught. |
| "Discount Offer" is refused | It is derived from the prices. |
| A known badge is canonicalised | "best seller" → "Best Seller", so the same badge is never stored twice under two spellings. |

On **update**, a badge list **replaces** rather than merges. An absent
list leaves the badges alone; a present list replaces them wholesale.
That is what a partial update means everywhere else in the schema, and a
list that could only grow would make it **impossible to remove a badge**.

---

## 3. The files

### Created

| Path | Purpose |
|---|---|
| `prisma/migrations/20261029120000_product_badges/migration.sql` | The `badges` column and the backfill. |
| `src/lib/format/brand.ts` | The brand derivation — a closed registry, longest-match-first. |
| `src/lib/format/badges.ts` | The badge vocabulary and the canonicalisation. |
| `src/components/admin/products/ProductBadgeEditor.tsx` | The badge editor. |
| `tests/format/brand.test.ts` | The brand derivation. |
| `tests/validation/admin-badges.test.ts` | The badge validation. |
| `tests/integration/admin-product-badges.test.ts` | The badge persistence and the mirror. |
| `scripts/verify-step15.ts` | The readable verification report. |

### Modified

| Path | Change |
|---|---|
| `prisma/schema.prisma` | The `badges` column. |
| `src/lib/validation/admin.ts` | The badge schemas; the legacy booleans become optional on create. |
| `src/lib/admin/catalog.ts` | `resolveBadges()`, the `badges` field in the select, the editable fields, the conditional expectation and the audit diff. |
| `src/lib/admin/stats.ts` | `AdminProductSummary` gains `badges`. |
| `src/components/admin/products/ProductFormDialog.tsx` | The badge editor replaces the two hardcoded checkboxes. |
| `src/app/admin/products/page.tsx` | The thumbnail, the brand, and both prices. |
| `src/app/api/admin/products/route.ts` | The `badges` field is documented. |
| `src/app/api/admin/products/[id]/route.ts` | The `badges` field is documented. |
| `DECISIONS.md` | Decisions #107–#118. |

### Deliberately NOT touched

| Path | Why |
|---|---|
| The storefront's product card and PDP | They read the **booleans**, which are the mirror. The storefront never has to learn about badge lists. |
| `src/lib/admin/products.ts` | Step 11's atomic stock write is proven and tested. |
| `src/lib/admin/orders.ts`, `src/lib/admin/reviews.ts` | Their state machines are proven. |

---

## 4. The verification

```bash
npx prisma generate
npx prisma migrate deploy

npx tsc --noEmit
npx eslint .
DATABASE_URL="postgresql://postgres@localhost:55432/euro_glam_bd_test?schema=public" \
  npx vitest run
npx next build

DATABASE_URL="postgresql://postgres@localhost:55432/euro_glam_bd_test?schema=public" \
  npx tsx scripts/verify-step15.ts
```

Expected: **968 tests passing across 55 files**, clean type-check, clean
lint, a successful build with `/admin/products` as `ƒ`, and every Step 15
check passing.

### The properties under test

| Property | Guard |
|---|---|
| The brand derivation never guesses | `tests/format/brand.test.ts`; `verify-step15.ts` |
| "The Ordinary" is never branded "The" | `tests/format/brand.test.ts`; `verify-step15.ts` |
| "CeraVe" does not match "Ceramide Cream" | `tests/format/brand.test.ts`; `verify-step15.ts` |
| The badge list and the booleans never disagree | `tests/integration/admin-product-badges.test.ts`; `verify-step15.ts` |
| A legacy boolean still works | `tests/integration/admin-product-badges.test.ts`; `verify-step15.ts` |
| The derived discount badge cannot be stored | `tests/validation/admin-badges.test.ts`; `verify-step15.ts` |
| A badge change is audited as a diff | `tests/integration/admin-product-badges.test.ts`; `verify-step15.ts` |
| A badge list replaces, it does not merge | `tests/validation/admin-badges.test.ts`; `verify-step15.ts` |
| A badge change is only sent when it changed | The form's `changed` list in `ProductFormDialog.tsx` |

### A note on the global audit count

One existing integration test counted `PRODUCT_CREATED` audit entries
across the **whole table**. Vitest runs the suites in parallel against
one shared database, so that count moves whenever another suite creates
a product — the assertion fails for a reason that has nothing to do with
the code under test. It is now scoped to the test's own run id. Global
counts must be asserted relationally, never absolutely.
