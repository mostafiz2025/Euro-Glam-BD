# Step 17 — Dynamic discovery: category, concern and brand imagery

**Scope.** The storefront's three discovery sections — "Shop By Category",
"Shop By Skin Concern" and "Shop By Brand" — become **fully dynamic** and
**manageable from the admin panel**. Categories gain an image; concerns
and brands become tables with images and logos; each of the three gets a
new audited admin surface; and the storefront renders the uploaded
imagery with the existing artwork as the fallback.

**Status.** Implemented and verified: a clean `tsc --noEmit`, a clean
`eslint .`, the full test suite green, and `scripts/verify-step17.ts`
passing every check.

---

## 1. What changed

| Area | Before | After |
|---|---|---|
| The database | `Category` had no image; concerns and brands were **static arrays in code** | `Category.image`, and two new tables: `SkinConcern` and `Brand` |
| The storefront | a hand-written SVG icon per category slug; a chip per concern; a two-letter monogram per brand | the **uploaded image**, falling back to the icon; the uploaded image behind the label; the **uploaded logo**, falling back to the monogram |
| The admin panel | **no** surface for any of the three | three new pages — Categories, Concerns, Brands — each with add, edit and a reasoned delete |
| The uploads | product images only | the **same** upload machinery, generalised and reused |
| The audit trail | no record of a category, a concern or a brand | nine new audited actions, one per mutation per entity |
| The seed | knew about none of them | seeds both new tables, **idempotently**, and never touches an upload |

---

## 2. The two facts that shaped the work

### 2.1 The upload infrastructure already existed

The project already had a storage abstraction (`src/lib/storage/adapter.ts`
plus `local-driver.ts`), a magic-byte image validator
(`src/lib/upload/validate.ts`), a two-step upload pattern, and a working
admin endpoint at `POST /api/admin/products/images` with a client picker at
`src/components/admin/products/ProductImagePicker.tsx`.

Step 17 **extends** that machinery rather than inventing a second upload
path. The whole algorithm — validate the batch, write each file, delete
the written ones if a later write fails — is extracted into one shared
service.

The one hard constraint: `STORAGE_SCOPES` is a **fixed allow-list**,
because the scope becomes a directory name under `public/uploads/` and
free text would be the first half of a path-traversal attack. Three
scopes were added: `categories`, `concerns` and `brands`.

### 2.2 The monogram is a deliberate legal decision

`src/components/home/brand-carousel.tsx` documents why it used monograms:

> There is no brand-logo asset for any of these brands — shipping
> trademarked logos requires permission, and a storefront that displays
> them without it is a legal problem.

The shop confirmed: **support logo upload, keep the monogram as the
fallback.** So a brand with no uploaded logo still renders — it renders
its monogram. The section never breaks because an admin has not uploaded
anything.

The admin form carries the caveat, and `DECISIONS.md` records that the
shop is responsible for holding the permission — the code cannot verify a
licence.

---

## 3. The schema

### 3.1 `Category.image`

```prisma
  /// Storage adapter key for the category's card image — NOT a raw URL.
  ///
  /// Null means "no image", and the storefront falls back to the SVG icon
  /// keyed by slug (`CATEGORY_ICONS`). The icon table decorates the
  /// catalogue; it never gates it — and an uploaded image is the same
  /// kind of enhancement, only better.
  image String? @db.VarChar(255)
```

### 3.2 `SkinConcern` — a new table

Concerns were a static array with an ingredient tag and a related-tag
list. To make them manageable they became a table:

```prisma
model SkinConcern {
  id String @id @default(cuid())
  name String @db.VarChar(80)
  slug String @unique @db.VarChar(100)

  /// The canonical ingredient ID the concern filter uses — "BHA".
  tag String @db.VarChar(60)
  relatedTags String[] @default([])

  image String? @db.VarChar(255)
  description String? @db.VarChar(200)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("skin_concerns")
}
```

The `tag` is one of the canonical ingredient IDs — the same list the
conflict engine compares in `src/lib/conflicts/catalogue.ts`. That is
what makes a concern filter and a conflict rule agree about what "BHA"
means.

### 3.3 `Brand` — a new table

```prisma
model Brand {
  id String @id @default(cuid())

  /// The canonical spelling — "CeraVe", "La Roche-Posay".
  ///
  /// This is the string `Product.brand` holds.
  name String @unique @db.VarChar(80)

  slug String @unique @db.VarChar(100)

  /// The two-letter monogram shown when no logo is uploaded.
  monogram String @db.VarChar(4)

  /// Storage adapter key for the brand's logo — NOT a raw URL.
  logo String? @db.VarChar(255)

  description String? @db.VarChar(200)

  /// The display order on the storefront. Lower comes first.
  sortOrder Int @default(0)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("brands")
}
```

**`Product.brand` stays a plain string.** Step 16 made it that
deliberately, and that decision is not being reversed. The `Brand` table
holds the *presentation* data — the logo, the monogram, the ordering —
and the product still stores the brand **name** it was given. So the
product read is unchanged: no join, no extra column, no migration of
existing rows.

### 3.4 The migration

`prisma/migrations/20261029160000_discovery_images/migration.sql` — raw
SQL in the house style, with an explanatory `--` header.

The backfill seeds the two new tables from the static vocabularies that
were in the code, so the concerns and brands that already existed do not
vanish when the arrays are retired. The `id`s are fixed strings, so the
backfill is idempotent.

**`Category.image` gets no backfill.** There are no category images
today, and a migration that guessed which file an icon should come from
would be inventing data.

---

## 4. The upload service

Rather than three near-identical copies of `uploadProductImages`, the
algorithm is **generalised**:

```ts
// src/lib/admin/discovery-images.ts
export async function uploadDiscoveryImages(
  files: readonly File[],
  scope: DiscoveryImageScope,
  adapter: StorageAdapter = getLocalStorageDriver(),
  maxFiles: number = MAX_DISCOVERY_IMAGES,
): Promise<DiscoveryImageUploadResult[]>
```

`uploadProductImages` is a thin wrapper over it, so the product path
keeps its exact behaviour and its exact error messages.

### 4.1 The cap is a parameter, not a constant

This is the single most important detail in the file.

The product carries up to twenty images. A discovery entity carries one.
The first attempt at the shared service carried `MAX_DISCOVERY_IMAGES = 4`
as a constant **inside** it — and every product upload of more than four
images failed with *"You can upload at most 4 images at a time."*

So the cap is a parameter:

```ts
export const MAX_DISCOVERY_IMAGES = 4;
export const MAX_PRODUCT_IMAGES = 20;
```

One implementation of "validate the batch, write, clean up"; two
independent limits; neither caller imposing its limit on the other.
`MAX_PRODUCT_IMAGES` is re-exported from `product-images.ts` so the
product path's existing importers keep working.

### 4.2 The order of operations

1. **Validate every file first.** Nothing is written until every file has
   passed the magic-byte check, the size cap and the dimension cap. A
   batch is all-or-nothing.
2. **Write them.** Each write produces a generated key — never a name
   derived from the user's filename.
3. **Clean up on a partial failure.** If the third write fails, the first
   two are deleted.

### 4.3 The three endpoints

```
POST   /api/admin/categories/images
POST   /api/admin/concerns/images
POST   /api/admin/brands/images
```

Each accepts `multipart/form-data` with one or more files under the name
`"images"`, validates them, stores them under its scope, and returns
`{ images: [{ key, url, originalName, mimeType, byteSize }] }`.

They are separate endpoints for the same reason the product endpoint is:
a category's name and slug are JSON, its image is bytes.

---

## 5. The services

Three new audited services, each following the house rules:

```ts
// src/lib/admin/categories.ts
export async function listAdminCategories(query): Promise<…>
export async function getAdminCategory(id): Promise<AdminCategory>
export async function createCategory(actor, input): Promise<AdminCategory>
export async function updateCategory(actor, id, input): Promise<AdminCategory>
export async function deleteCategory(actor, id, reason): Promise<void>
```

…with `concerns.ts` and `brands.ts` the same shape.

### 5.1 The rules that govern all three

**Every write shares its transaction with its audit entry.** A category
whose card image was swapped with no record of who swapped it is a
storefront surface nobody can account for.

**Every update is conditional on the values the admin saw.** The read
that precedes the write is not just for validation — it is the
*expectation*. The `updateMany` matches on the observed values of the
fields being changed, so two admins editing the same row produce one
winner and one 409.

**The audit entry records the changed fields only.** So the entry reads
"name Cleansers → Face Cleansers" rather than carrying the whole row
twice.

### 5.2 The category delete is a hard delete — and that is safe

`Product.categoryId` is `onDelete: Restrict`, so a category with
products **cannot** be deleted; the database refuses. But a bare
constraint violation is not an explanation, so the service counts the
products first and returns a distinct conflict:

> This category still has 9 products. Move them to another category
> first.

Cascading would be worse: it would delete the shop's products because
somebody tidied up a category.

### 5.3 Deleting a brand does not touch the products

`Product.brand` is a plain string, not a foreign key. Removing the brand
row removes the logo and the description; the products keep their brand
name and simply have no logo to show, because the storefront falls back
to the monogram. **A brand delete is never destructive to the catalogue.**

### 5.4 The brand name is canonicalised at the write

`Brand.name` is unique, and it is the string `Product.brand` holds. If
the admin typed "cerave" and the row was created as "cerave", the shop
would have a brand that no product carries and a brand that every product
carries — two rows, one brand. So the write folds the name to its
registry spelling, using the same `canonicalBrand` the product path uses.

---

## 6. The validation

`src/lib/validation/admin.ts` gains six schemas:

| Schema | Shape |
|---|---|
| `categoryCreateSchema` | name (1–120), slug, image (storage key or null) |
| `categoryUpdateSchema` | the same, all optional |
| `concernCreateSchema` | name (1–80), slug, tag, relatedTags, image, description (≤200) |
| `concernUpdateSchema` | the same, all optional |
| `brandCreateSchema` | name (canonicalised), slug, monogram (1–4 letters), logo, description, sortOrder |
| `brandUpdateSchema` | the same, all optional |

The **image field is a storage key**, and the schema validates it as one
— the existing `productImageEntrySchema` already encodes exactly that
rule, including the legacy absolute-path repair, so the discovery
schemas reuse it rather than writing a second, weaker copy.

A brand's name is canonicalised with `canonicalBrand`, so "cerave" and
"CeraVe" cannot become two brands.

---

## 7. The admin UI

### 7.1 Three new pages

```
src/app/admin/categories/page.tsx
src/app/admin/concerns/page.tsx
src/app/admin/brands/page.tsx
```

Each follows the shape of the existing admin pages: a server component
that reads through the service, a client dialog for add/edit, and a
delete confirmation. Each is behind the same route protection, and each
sets `export const instant = false;`.

### 7.2 The shared components

```
src/components/admin/discovery/DiscoveryImageField.tsx
src/components/admin/discovery/DiscoveryDeleteDialog.tsx
```

`DiscoveryImageField` is the single-image sibling of
`ProductImagePicker`: one file, uploaded as soon as it is chosen, showing
a preview and a "Remove" affordance, holding the **key** rather than the
URL. "Remove" clears the field; the file itself is cleaned up when the
record is saved.

`DiscoveryDeleteDialog` is one component for all three entity types. The
reason is mandatory, and an optional `blockedReason` prop disables the
button and explains why — which is how a category holding products
explains itself.

### 7.3 The form dialogs

```
src/components/admin/categories/CategoryFormDialog.tsx
src/components/admin/concerns/ConcernFormDialog.tsx
src/components/admin/brands/BrandFormDialog.tsx
```

Each is modelled on `CouponFormDialog`: `Escape` to close, focus on
open, `router.refresh()` after the save, and `ApiEnvelope` error
handling.

The brand form carries the trademark caveat:

> Only upload a logo you have permission to use. Brands without a logo
> show their monogram instead.

### 7.4 The nav

`ADMIN_NAV_ITEMS` gains three items — Categories (`TagIcon`), Concerns
(`DropletToolIcon`) and Brands (`BrandMarkIcon`) — with two new
hand-rolled icons in `src/components/ui/icons.tsx`, matching the
existing style. The nav test was **extended** from nine sections to
twelve, not weakened.

---

## 8. The storefront

### 8.1 "Shop By Category"

`CategoryGrid` renders the uploaded image when the category has one, and
falls back to the SVG icon when it does not:

```tsx
{category.image ? (
  <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-full bg-brand-50 ring-1 ring-border … sm:h-14 sm:w-14">
    <Image src={imageUrl(category.image)} alt="" fill sizes="56px" className="object-cover" />
  </span>
) : (
  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 …">
    <CategoryIcon slug={category.slug} width={22} height={22} />
  </span>
)}
```

The icon is **never removed** — it is the fallback, and the fallback is
what keeps a category the admin has not yet decorated from rendering as
an empty circle.

### 8.2 "Shop By Skin Concern"

`src/components/home/concern-grid.tsx` is new. The uploaded image sits
**behind** the label as a tinted backdrop (`opacity-25`) under a gradient
scrim, which keeps the label legible over any photograph. The link stays
`?ingredient=<tag>` — the tag is what the catalogue filters on, and it
does not change.

### 8.3 "Shop By Brand"

The carousel renders the uploaded logo when present and the monogram
when not:

```tsx
{brand.logo ? (
  <span className="relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-white ring-1 ring-border">
    <Image src={imageUrl(brand.logo)} alt={`${brand.name} logo`} fill sizes="48px" className="object-contain" />
  </span>
) : (
  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 font-serif text-sm font-bold text-brand-600">
    {brand.monogram}
  </span>
)}
```

`object-contain`, not `object-cover` — a logo is cropped badly by
`cover`, and a cropped logo is a broken logo.

### 8.4 The static vocabularies are retired, not orphaned

`CONCERNS` and `BRANDS` (and `BRAND_MONOGRAMS`, `brandSlug()`,
`monogramFor()`) are **removed** from `src/lib/format/taxonomy.ts` and
replaced by database reads. Two lists would drift, and the drifted one
would be the one the storefront shows.

Two things deliberately **stay**:

- **`KNOWN_BRANDS`** — the canonicalisation vocabulary the product path
  validates against, and the seed's source. Retiring it would undo Step
  16.
- **`CATEGORY_ICONS`** — the fallback artwork.

### 8.5 The reads

`src/lib/format/server-data.ts` gains two page-safe fetchers:

```ts
export async function fetchConcerns(): Promise<{ concerns: ConcernSummary[]; error: string | null }>
export async function fetchBrands(): Promise<{ brands: BrandSummary[]; error: string | null }>
```

Both **never throw** — a failed read renders an empty list with an
honest message, exactly as `fetchCategories` does.

---

## 9. The seed

`prisma/seed.ts` gains the brands and the concerns, seeded from the same
vocabularies the migration uses, so the two agree.

The seed stays **idempotent** — the Step 16 fix. The brand and concern
rows are found by their slug and updated, so a third run does not
duplicate them.

**The `image` and `logo` columns are never written by the seed**, on
create or on update:

> The `image` is **not** written by the seed — neither on create nor on
> update. It is the admin's upload, and a seed that reset it would
> silently wipe the card image of every category the shop has decorated.

The existing nineteen products keep their brands; the `Brand` table is
seeded with the nine registered brands, and `Product.brand` continues to
hold the name.

---

## 10. Verification

```bash
npx prisma generate
npx prisma migrate deploy

npx tsc --noEmit
npx eslint .
npx vitest run
npx next build

npx tsx scripts/verify-step17.ts
```

### 10.1 The manual gate

1. `/` — a category with an image shows the image; one without shows the
   icon.
2. `/` — a brand with a logo shows the logo; one without shows the
   monogram.
3. `/` — the concern grid shows the uploaded image.
4. `/products` — the brand strip and the concern strip show the imagery.
5. `/admin/categories` — upload an image, save, and see it on the
   storefront.
6. `/admin/brands` — upload a logo, save, and see it in the carousel.
7. `/admin/concerns` — create a new concern; it appears on the storefront.
8. Deleting a category that has products is **refused with a clear
   message**.
9. Deleting a brand does **not** affect the products that carry it.
10. A renamed `.txt` file is **rejected** by the upload, not stored.

### 10.2 The guard rails

| Property | Guard |
|---|---|
| An uploaded image reaches the database | `tests/integration/discovery-crud.test.ts`; `tests/integration/discovery.test.ts`; `scripts/verify-step17.ts` |
| The storefront reads the imagery back | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| A missing image reads as `null`, not as absent | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
| The monogram survives as the fallback | `tests/integration/discovery.test.ts`; `verify-step17.ts` |
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

---

## 11. The files

### Created

| Path | Purpose |
|---|---|
| `prisma/migrations/20261029160000_discovery_images/migration.sql` | The `Category.image` column, the two new tables, the backfill. |
| `src/lib/admin/discovery-images.ts` | The generalised upload service. |
| `src/lib/admin/categories.ts` | The category CRUD service. |
| `src/lib/admin/concerns.ts` | The concern CRUD service. |
| `src/lib/admin/brands.ts` | The brand CRUD service. |
| `src/app/api/admin/categories/images/route.ts` | The category image upload. |
| `src/app/api/admin/concerns/images/route.ts` | The concern image upload. |
| `src/app/api/admin/brands/images/route.ts` | The brand logo upload. |
| `src/app/api/admin/categories/route.ts` | The category list/create. |
| `src/app/api/admin/categories/[id]/route.ts` | The category read/update/delete. |
| `src/app/api/admin/concerns/route.ts` | The concern list/create. |
| `src/app/api/admin/concerns/[id]/route.ts` | The concern read/update/delete. |
| `src/app/api/admin/brands/route.ts` | The brand list/create. |
| `src/app/api/admin/brands/[id]/route.ts` | The brand read/update/delete. |
| `src/app/admin/categories/page.tsx` | The category admin page. |
| `src/app/admin/concerns/page.tsx` | The concern admin page. |
| `src/app/admin/brands/page.tsx` | The brand admin page. |
| `src/components/admin/discovery/DiscoveryImageField.tsx` | The shared single-image field. |
| `src/components/admin/discovery/DiscoveryDeleteDialog.tsx` | The shared delete dialog. |
| `src/components/admin/categories/CategoryFormDialog.tsx` | The category form. |
| `src/components/admin/concerns/ConcernFormDialog.tsx` | The concern form. |
| `src/components/admin/brands/BrandFormDialog.tsx` | The brand form. |
| `src/components/home/concern-grid.tsx` | The "Shop By Concern" card grid. |
| `tests/admin/discovery-images.test.ts` | The upload service. |
| `tests/integration/discovery-crud.test.ts` | The three CRUD services. |
| `tests/integration/discovery.test.ts` | The persistence and the storefront reads. |
| `scripts/verify-step17.ts` | The readable verification report. |

### Modified

| Path | Change |
|---|---|
| `prisma/schema.prisma` | `Category.image`; the `SkinConcern` and `Brand` models; nine `AdminAction` values. |
| `src/lib/storage/adapter.ts` | Three new `STORAGE_SCOPES`. |
| `src/lib/admin/product-images.ts` | `uploadProductImages` delegates to the generalised service. |
| `src/lib/admin/audit.ts` | `CATEGORY_ACTIONS`, `CONCERN_ACTIONS`, `BRAND_ACTIONS`. |
| `src/lib/validation/admin.ts` | The six new schemas. |
| `src/lib/catalog/service.ts` | `listCategories` carries the image; the concern and brand list functions. |
| `src/lib/format/types.ts` | The mirrored summaries carry the image. |
| `src/lib/format/server-data.ts` | `fetchConcerns`, `fetchBrands`. |
| `src/lib/format/taxonomy.ts` | `CONCERNS` and `BRANDS` retired in favour of the database reads. |
| `src/components/admin/shell/admin-nav-items.ts` | Three nav items. |
| `src/components/ui/icons.tsx` | Two new hand-rolled icons. |
| `src/components/home/category-grid.tsx` | The uploaded image with the icon fallback. |
| `src/components/home/brand-carousel.tsx` | The uploaded logo with the monogram fallback. |
| `src/components/commerce/filter-panel.tsx` | The concerns come from the database. |
| `src/components/commerce/mobile-filter-sheet.tsx` | The concerns prop is passed through. |
| `src/app/page.tsx` | The streamed concern section; the brand and category reads. |
| `src/app/products/page.tsx` | The concern and brand strips read from the database. |
| `prisma/seed.ts` | The brands and concerns; still idempotent; never writes an upload. |
| `DECISIONS.md` | The Step 17 decisions. |
| `docs/STEP-17-DYNAMIC-DISCOVERY.md` | This guide. |

### Deliberately NOT touched

| Path | Why |
|---|---|
| `src/lib/format/brand.ts` — `KNOWN_BRANDS` | It is the canonicalisation vocabulary and the seed's source. Step 16 made it the single source of truth; retiring it now would undo that. |
| `src/lib/format/taxonomy.ts` — `CATEGORY_ICONS` | The fallback artwork. An uploaded image enhances it; it never replaces it. |
| `src/lib/admin/products.ts` (the stock path) | Proven and tested; not involved. |
| `package.json` dependencies | No new dependencies. |
