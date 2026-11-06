# Step 16 — The stored brand and dual pricing

**Scope.** The product's brand becomes a **real, editable, stored field** —
`Product.brand`, a nullable column — with a searchable combobox in the
admin form. The derivation from the name survives as the **fallback** for
rows written before the column existed. The admin form's two price inputs
are relabelled so it is unambiguous which one the customer pays, and the
form states the saving in plain words.

**Status.** Implemented and verified: 998 tests passing across 56 files,
clean `tsc --noEmit`, clean `eslint .`, a successful `next build`, and
`scripts/verify-step16.ts` passing every check.

---

## 1. What changed

| Area | Before | After |
|---|---|---|
| The database | no `brand` column — the brand lived inside `name` | `Product.brand VARCHAR(80)`, nullable, indexed |
| The vocabulary | `KNOWN_BRANDS` (9) and the carousel's `BRANDS` (8) — **drifted** | one list: `KNOWN_BRANDS`, with the carousel derived from it |
| The admin form | no brand field | a **combobox** — pick a known brand or type a new one |
| The storefront card | no brand line | the brand on its own line above the title |
| The product page | no brand line | the brand above the title, above the category |
| The admin inventory table | the brand **derived** from the name | the **stored** brand, falling back to the derivation |
| The prices | "Price" and "Discount price" | "**Regular price**" and "**Discount price**", with the saving spelled out |

---

## 2. Why the brand became a stored field

Step 15 derived the brand from the product's name against a closed
registry. That was a good *fallback* and a bad *field*, because:

- An admin could not **correct** a wrong brand.
- The catalogue could not **filter** on a brand.
- An admin could not enter a brand the registry had never heard of.

So `Product.brand` is now a real column, and the derivation survives only
for a row whose brand is null.

### 2.1 The two are combined by `displayBrand`

```ts
export function displayBrand(
  storedBrand: string | null | undefined,
  productName: string,
): string | null {
  if (storedBrand !== null && storedBrand !== undefined) {
    const trimmed = storedBrand.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return splitBrandAndTitle(productName).brand;
}
```

The **stored** value always wins. An admin who deliberately set "Bioderma"
on a product named "CeraVe Serum" must keep that choice — the derivation
is a fallback, not an override.

### 2.2 The name is left intact

The brand is *additional metadata*, not a replacement for the name. The
name feeds:

- the image alt text,
- the `OrderItem.productName` snapshot, which outlives the product,
- the catalogue search term,
- the admin's typed delete confirmation.

Rewriting it to strip the brand prefix would change the meaning of a
column in every consumer, for a display concern. So the name stays whole
and the brand is shown on its **own line** — above the title, not inside
it, or the card would read "CeraVe CeraVe Hydrating Facial Cleanser".

---

## 3. The schema

```prisma
  /// The brand the product belongs to — "CeraVe", "Bioderma",
  /// "La Roche-Posay".
  ///
  /// **Null means "unknown".** The column is nullable because a product
  /// can genuinely have no brand, and because a nullable column can be
  /// added to a live table without a backfill that guesses.
  brand String? @db.VarChar(80)
```

`@@index([brand])` — the brand is filtered on the storefront's brand
facet and by the catalogue's brand search.

### 3.1 The column is not a foreign key

There is no `Brand` table. A `Brand` table would mean a second admin CRUD
(list, create, rename, merge), a join on every product read, and a
migration rewriting every seeded row against a new table — for a label
with a closed, known vocabulary.

Instead the vocabulary lives in `src/lib/format/brand.ts`, and the column
is a plain string. The picker's suggestions and the server's accepted
values read **the same list**, so they cannot drift.

### 3.2 The backfill never guesses

`prisma/migrations/20261029150000_product_brand/migration.sql` brands a
row only when its name begins with a **registered** brand followed by
whitespace:

```sql
WHEN "name" LIKE 'CeraVe %' THEN 'CeraVe'
```

The trailing space enforces "prefix followed by whitespace", so
"Ceramide Cream" is **not** branded "CeraVe" — the same rule the
derivation has always used, applied once at migration time. A row whose
name matches no registered brand is left null.

---

## 4. The brand picker

`src/components/ui/brand-picker.tsx` — a **combobox**.

### 4.1 Why not a `<select>`

A native `<select>` renders its popup with the operating system's own
chrome, which cannot be themed — so it would be the one control on the
admin page that ignores the dark mode. And it cannot offer "Add brand" at
all, which is the half of the requirement that matters: the shop stocks
brands the code has never heard of.

A combobox does both: a text input that filters a list of suggestions
**and** accepts a value that is not in the list.

### 4.2 The ARIA pattern

The full combobox pattern, in the house style of `OrderStatusSelect.tsx`:

| Attribute | Value |
|---|---|
| `role` on the input | `combobox` |
| `aria-expanded` | whether the list is open |
| `aria-controls` | the listbox's id |
| `aria-autocomplete` | `list` |
| `role` on the list | `listbox` |
| `role` on each row | `option` |
| `aria-selected` | whether it is the current brand |

It closes on an outside click and on `Escape` — and `Escape` returns the
focus to the input, which is where a keyboard user expects it to be when
they cancel.

### 4.3 The typed value is canonicalised before it is saved

A brand typed as "cerave" is stored as "CeraVe". Without that, the shop
could end up with three products branded "cerave", "CeraVe" and "CERAVE",
and the storefront would show all three as different brands.

The canonicalisation happens in **two** places, for two different reasons:

| Where | Why |
|---|---|
| The Zod schema's `.transform()` | A convenience — it lets the admin form show the corrected spelling **before** the save. |
| The **service** (`normaliseBrand`) | The **guarantee** — the service is where every path to the database passes, so a caller that bypassed the schema still cannot store "cerave". |

A `null` brand stays `null`, and a blank string becomes `null`: "no brand"
is one value, and there are two spellings of it.

### 4.4 The picker's text is derived, not synchronised

The closed-state text **is** the value; the open-state text **is** the
query. There is no separate `draft` state to keep in step — an earlier
version had one, synchronised by an effect, and React's
`react-hooks/set-state-in-effect` rule correctly flagged it as a
cascading render. The fix was to remove the duplication rather than
suppress the rule.

---

## 5. The dual pricing

### 5.1 The labels say which one the customer pays

The fields are "**Regular price**" and "**Discount price**", not "Price"
and "Discount price". A form that leaves the admin guessing which one is
charged is a form where the two get filled in the wrong way — and on a
live product that is a visible, priced error.

### 5.2 The form states the saving in plain words

Beneath the two fields, the form says what the storefront will show:

> The customer pays ৳750 — ৳250 off the regular price. The regular price
> is shown struck through.

### 5.3 A discount price that would not be shown is reported, not ignored

`Price` renders the discount price **only when it is lower** than the
regular price. So a discount price *higher* than the regular price would
appear to have been silently discarded. The form says so explicitly
rather than saving a value that will not be displayed:

> The discount price is higher than the regular price — it will not be
> shown as a discount.

And a discount price *equal* to the regular price is reported as:

> The discount price matches the regular price, so no discount is shown.

### 5.4 Where the two prices are displayed

The struck-through original already renders through the shared `Price`
component, so it is consistent everywhere:

| Surface | Rendering |
|---|---|
| The storefront product card | `<Price size="md">` — the effective price and the struck-through original |
| The product detail page | `<Price size="lg">` — the same, plus "You save ৳250" |
| The cart view and the cart drawer | `<Price>` on each line |
| The admin inventory table | the effective price, the struck-through original, and the percentage |

---

## 6. The vocabulary reconciliation

Two brand registries existed and had **already drifted**: `KNOWN_BRANDS`
(9) in `src/lib/format/brand.ts` and `BRANDS` (8) in
`src/lib/format/taxonomy.ts`. The registry knew "Musta Baby"; the
carousel did not — so a shopper looking for the baby line could not find
it.

`BRANDS` is now **derived** from `KNOWN_BRANDS`:

```ts
export const BRANDS: readonly Brand[] = KNOWN_BRANDS.map((name) => ({
  id: brandSlug(name),
  name,
  query: name,
  monogram: monogramFor(name),
}));
```

Adding a brand to the vocabulary now puts it in the picker, the filter
panel and the carousel at once, and there is no second list to forget.

The **monograms** stay hand-written, because "La Roche-Posay" → "LR" is a
house convention, not a derivation — but a brand with no monogram falls
back to its first letters rather than rendering a blank tile.

---

## 7. The search

The catalogue's search condition now matches the brand column as well as
the name and the description:

```ts
conditions.push({
  OR: [
    { name: { contains: escaped, mode: "insensitive" } },
    { description: { contains: escaped, mode: "insensitive" } },
    { brand: { contains: escaped, mode: "insensitive" } },
  ],
});
```

That is the reason the brand became a column rather than staying a
derivation: a shopper typing "CeraVe" must find the CeraVe products,
including one whose *name* does not begin with the brand.

---

## 8. The seed

The seed states the brand **explicitly** rather than letting it be
derived — the same way the admin form does. A seed that guessed its own
brands would be a seed that could not be trusted to seed a new brand.

### 8.1 The seed is now idempotent

The seed's own header claimed it was "safe to run repeatedly", and it
was — until the products were created with `create` rather than looked up
first. Every run then doubled the catalogue: nineteen products became
thirty-eight, and the storefront showed every product twice.

The product loop now finds the existing row by name and updates the
**catalogue** fields:

```ts
const existing = await prisma.product.findFirst({
  where: { name: product.name },
  select: { id: true },
  orderBy: { createdAt: "asc" },
});

const row = existing
  ? await prisma.product.update({ where: { id: existing.id }, data: catalogueFields })
  : await prisma.product.create({ data: { name: product.name, ...catalogueFields, /* … */ } });
```

A `findFirst` + `create`/`update` is used rather than `upsert`, because
`upsert` needs a **unique** column and `Product.name` is not one — two
products may legitimately share a name. Adding a unique constraint to the
name would change what a product *is* in the database, which is a bigger
decision than a seed needs to make.

The update **leaves `stockQuantity` alone**: the stock is the shop's
live state, not the seed's, and a reseed must not hand a customer's
reserved unit back onto the shelf.

The brand is one of the updated fields, so a seed that adds a brand
column does not need a second migration to backfill it.

---

## 9. Verification

### 9.1 The commands

```bash
npx prisma generate
npx prisma migrate deploy

npx tsc --noEmit
npx eslint .
npx vitest run

npx next build

npx tsx scripts/verify-step16.ts
```

### 9.2 The test files

| File | What it covers |
|---|---|
| `tests/format/brand.test.ts` | The derivation, the canonicalisation, `displayBrand`, the vocabulary's invariants, and the validation schema |
| `tests/integration/product-brand.test.ts` | The brand reaching the database, the canonicalisation at the write, the partial update, the read paths and the search |

### 9.3 The verification script

`scripts/verify-step16.ts` proves against a real database that:

1. The vocabulary holds no duplicate in any casing, and every brand fits
   the column.
2. The carousel shows exactly the registered brands.
3. The brand is stored on the row.
4. A lowercased brand is folded to its registry spelling **by the
   service**, not only by the schema.
5. A custom brand is trimmed and collapsed.
6. A product with no brand is legitimate.
7. The brand survives a price-only edit.
8. A `null` brand clears the column.
9. A deliberate brand beats the derived one; a `null` brand falls back to
   the derivation.
10. The catalogue and the admin summary both carry the brand.
11. A product is found by its brand even when the name does not carry it.
12. The two prices are stored independently, and the discount mirror is
    recomputed from them.
13. The validation refuses a blank or over-long brand.
14. The audit trail records the brand on both the create and the update.

### 9.4 The guard rails

| Property | Guard |
|---|---|
| The brand reaches the database | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |
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
| The two prices are stored independently | `verify-step16.ts` |
| The discount mirror is recomputed from the two prices | `verify-step16.ts` |
| The audit trail records the brand | `tests/integration/product-brand.test.ts`; `verify-step16.ts` |

---

## 10. The files

### Created

| Path | Purpose |
|---|---|
| `prisma/migrations/20261029150000_product_brand/migration.sql` | The `brand` column, the backfill and the index. |
| `src/components/ui/brand-picker.tsx` | The searchable brand combobox. |
| `tests/integration/product-brand.test.ts` | The brand's persistence, canonicalisation and searchability. |
| `scripts/verify-step16.ts` | The readable verification report. |

### Modified

| Path | Change |
|---|---|
| `prisma/schema.prisma` | `Product.brand` and `@@index([brand])`. |
| `prisma/seed.ts` | The `brand` on every product; the seed is now idempotent. |
| `src/lib/format/brand.ts` | `canonicalBrand`, `isKnownBrand`, `displayBrand`, `MAX_BRAND_LENGTH`. `deriveBrand` and `deriveTitle` are **removed** — the derivation is now a fallback, and the old names implied it was the source of truth. |
| `src/lib/format/taxonomy.ts` | `BRANDS` is derived from `KNOWN_BRANDS`. |
| `src/lib/format/types.ts` | The mirrored `ProductSummary` carries the brand. |
| `src/lib/validation/admin.ts` | `brand` on the create and update schemas. |
| `src/lib/admin/catalog.ts` | The brand on the create, update and audit paths; `normaliseBrand`. |
| `src/lib/admin/stats.ts` | The brand on the admin summary. |
| `src/lib/catalog/service.ts` | The brand on the summary; the brand is searched. |
| `src/app/api/admin/products/route.ts` | The documented `brand` field on create. |
| `src/app/api/admin/products/[id]/route.ts` | The documented `brand` field on update. |
| `src/components/admin/products/ProductFormDialog.tsx` | The brand picker; the relabelled prices; the price hint. |
| `src/app/admin/products/page.tsx` | The stored brand, with the derivation as the fallback. |
| `src/components/commerce/product-card.tsx` | The brand line. |
| `src/app/products/[id]/page.tsx` | The brand line; the matching skeleton placeholder. |
| `tests/format/brand.test.ts` | The new functions and the vocabulary's invariants. |
| `DECISIONS.md` | Decisions 119–128. |

### Deliberately NOT touched

| Path | Why |
|---|---|
| `src/lib/format/brand.ts` — `splitBrandAndTitle` | The derivation's **logic** is unchanged and still correct. It is now the fallback rather than the source of truth, which is a change in *where it is called*, not in what it does. |
| `src/components/ui/price.tsx` | The struck-through original already renders correctly. The work was labelling the *inputs* so the admin knows which price is which. |
| `src/lib/admin/products.ts` (the stock path) | Step 11's atomic stock write is proven and tested, and it is not involved in either the brand or the prices. |
