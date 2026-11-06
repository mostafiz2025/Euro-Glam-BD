# Step 14 — Product Image Uploads

## Context

The product add/edit form had an **"Image URLs" textarea**. An admin
typed one path per line, and the form posted those strings straight
into `Product.images`.

That was workable for a prototype and wrong for a catalogue. Three
problems, in ascending order of severity:

1. **It asked for the wrong thing.** The column does not hold URLs — it
   holds *storage adapter keys*. The Prisma schema says so outright:

   > `/// Storage adapter keys — NOT raw URLs, so the driver can be swapped.`

   So the form was asking an admin to type something the system never
   wanted. A hand-typed URL cannot be validated, cannot be size-capped,
   and cannot be deleted by the driver.

2. **It could not show an image.** With no upload path, an admin had to
   find a file on a machine, upload it somewhere by hand, and type the
   resulting path. The catalogue's images were placed into
   `public/uploads/products/` by a script that then wrote the
   **absolute filesystem path of the machine that did the uploading**
   into the column. Thirteen of the nineteen seeded products hold a path
   like:

   ```
   C:\Users\someone\Downloads\Euro Glam BD\public\uploads\products\serum.jpg
   ```

   Joining that onto `/uploads` produced
   `/uploads/C:\Users\…\serum.jpg` — a URL that resolves to nothing. So
   those products showed the typographic placeholder while the image sat
   on disk the whole time.

3. **It had no way to be wrong, safely.** A typed URL bypassed every
   check the upload pipeline performs: the magic-byte check, the size
   cap, the dimension cap, the path-traversal guard.

This step replaces the textarea with a **file picker**, adds the upload
endpoint behind it, and repairs the seeded rows.

---

## 1. The shape of the flow

The upload is **not** a field on the product body. A product's facts —
its name, its price, its category — travel as JSON. An image does not:
it is bytes, and it has to be validated, size-capped, renamed and
written to disk before it is a key. Bolting a `multipart/form-data`
body onto `POST /api/admin/products` would force *every* product create
and update through a multipart parser, for a field most of them do not
touch.

So the upload is its own endpoint, and the flow is three steps:

```
┌──────────────────────────────────────────────────────────────┐
│ 1. The admin picks files in the form.                        │
│    <input type="file" accept="image/*" multiple>             │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. The form POSTs the files to                               │
│    POST /api/admin/products/images                           │
│    which validates them and returns STORAGE KEYS.            │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. The form sends the product's JSON body — including those   │
│    keys — to the existing create / update endpoints.          │
└──────────────────────────────────────────────────────────────┘
```

The property this buys is worth stating plainly: **the product row is
never written with a file that has not already been validated and
stored.** A half-finished upload leaves an orphaned file on disk — a
cleanup job's problem — never a product pointing at a file that does
not exist.

---

## 2. The upload service

`src/lib/admin/product-images.ts` — two exported functions.

### `uploadProductImages(files, adapter?)`

The order of operations is the whole design:

**1. Validate every file first.** Nothing is written until every file
has passed the magic-byte check, the size cap and the dimension cap.
A batch is **all-or-nothing**.

**2. Write them.** Each write produces a **generated** key — 16 bytes
of CSPRNG rendered as 32 hex characters — never a name derived from the
user's filename. A file called `../../etc/passwd.png` therefore cannot
escape the upload root, and a filename with spaces, ampersands or
non-ASCII characters causes no trouble at all, because the filename is
never used.

**3. Clean up on a partial failure.** If the third write fails (a
disk-full error, say), the first two are deleted. The cleanup is
best-effort: a failure to delete is logged, not thrown, because the
original error is the one the admin needs to see.

### Why validation is separated from the write

The codebase already has `uploadImage()` in `src/lib/storage/index.ts`,
which validates *and* writes in one call. It is the right helper for a
single file. It cannot serve a batch, though: calling it in a loop
writes the first file before the second is checked, so a batch of five
where the fourth is a renamed `.txt` would leave **three orphaned files
on disk**.

So `uploadProductImages` reads the bytes once, validates the whole
batch with `assertValidImage`, and only then enters the write phase.
That is the only reason the all-or-nothing property holds.

### The key is generated, and the extension comes from the bytes

The local driver names a stored object `<32 hex>.<extension>`, and the
extension is derived from the **detected** MIME type — not the one the
client declared. A PNG that the browser called `image/jpeg` is stored as
`.png`, because the bytes say PNG. The magic bytes are trusted; the
declared `Content-Type` is only ever a cross-check.

### The error taxonomy

The distinction the admin cares about is preserved from
`UploadValidationError`:

| Status | Meaning | Can the admin fix it? |
|---|---|---|
| **413** | The file is too big. | Yes — choose a smaller image. |
| **415** | The file is not a supported image, or its contents do not match its name. | Yes — choose another file. |
| **400** | The request was malformed (no files at all, or more than the cap). | Yes — pick fewer files. |
| **500** | The bytes were fine and the disk said no. | No — retry later. |

A `StorageError` from the driver is logged and reported as a generic
500, because its message names an internal path and an admin cannot act
on it.

### `deleteProductImages(keys, adapter?)`

Removes objects that are no longer referenced. **Best-effort**: the
product row has already been updated by the time this runs, so a file
that cannot be deleted leaves the product correct — it points at the
images it should. An orphaned file is a disk-space problem for a
maintenance job, not a correctness problem for the catalogue. Swallowing
the failure would hide a real problem; throwing it would fail a request
whose actual work succeeded.

---

## 3. The endpoint

`src/app/api/admin/products/images/route.ts` — `POST` only.

It follows the house rules exactly:

- `await connection()` sits **outside** the try block.
- `requireAdmin()` is the authority — the proxy is a fast filter.
- The body is `request.formData()`, and the files are read from the
  `images` field via `form.getAll("images")`, filtered to real `File`
  instances (a `FormData` entry may be a string).
- The response is `{ images: [{ key, url, originalName, mimeType,
  byteSize }] }` — the **key** is what the form posts to the product
  endpoint; the `url` is there so the form can render a preview.

It returns the *detected* MIME type and the byte size so the form can
tell the admin what was actually stored, rather than what the browser
claimed.

---

## 4. The form

`src/components/admin/products/ProductImagePicker.tsx` — a client
component.

### The input

```tsx
<input
  type="file"
  accept="image/jpeg,image/png,image/webp"
  multiple
  ...
/>
```

The `accept` list is the **exact** set `assertValidImage` supports.
`accept="image/*"` would also offer the admin a GIF or a BMP, which the
server would then refuse — a round trip to learn something the browser
could have said up front.

The input is visually hidden with `sr-only` **inside a `<label>`**, not
`display: none`, so it stays focusable and the keyboard path works.

### The preview

Each uploaded image renders through `next/image` with its URL derived
from the key by `imageUrl()` — the same function the storefront uses,
so the preview is exactly what a customer will see.

### The controls

| Control | What it does |
|---|---|
| **Remove** | Drops the image from the list. The file on disk is *not* deleted — it may still be referenced by a saved product, and the cleanup happens on save. |
| **← / →** | Reorders. The **first** image is the main one and is badged. |
| **The 20-image cap** | The picker refuses to go over it, and the server refuses it too. A form can never produce a list the server will reject. |

After a successful upload the input's `value` is cleared, so picking
the same file again re-fires `change`. Without that, selecting a
replacement for a rejected file would silently do nothing.

### The form's state

`ProductFormDialog` now holds `images` as a `string[]` — the keys —
rather than a newline-joined string. The change-detection line became:

```ts
if (images.join("|") !== product.images.join("|")) {
  changed.push("images");
}
```

---

## 5. The schema

`src/lib/validation/admin.ts` — `productImageEntrySchema`.

### The `.url()` check was wrong

The schema previously required each entry to be a URL. That would have
rejected **every** key the upload pipeline produces
(`products/2026/10/9f2c….png` is not a URL) and accepted a hand-pasted
URL that the driver could neither serve nor delete.

### What is accepted

| Shape | Treatment |
|---|---|
| A **storage key** — `products/2026/10/9f2c….png` | Accepted as-is. This is what the uploader produces. |
| An **absolute URL** — `https://cdn.example.com/x.jpg` | Accepted, passed through untouched. `imageUrl()` already passes it through, and rows written before the pipeline existed hold exactly this. Refusing it would make those products unsaveable — an admin opening one to fix a typo would get a 400 and no way to save. |
| A **legacy absolute filesystem path** — `C:\…\public\uploads\products\serum.jpg` | **Normalised** to the key it points at: `products/serum.jpg`. |

### The normalisation is the repair

The legacy path is not a key, and joining it onto `/uploads` produced a
URL that resolved to nothing — which is why thirteen seeded products
showed their placeholder while the image sat on disk.

So the path is rewritten to the key it was pointing at. The file has
**not moved**; only the reference is corrected. And because the rewrite
happens in the schema, **the act of saving a legacy product repairs
it** — which is how the seeded rows get fixed, one admin save at a
time, with no migration script and no risk of touching a row by
mistake.

### What is refused

| Shape | Why |
|---|---|
| A key with a `..` segment | A path-traversal attempt, not a typo. |
| A key starting with `/` | Absolute, where a key must be relative. |
| A **null byte** | Never legitimate. |
| An empty string | Never legitimate. |
| An absolute path **outside** our uploads root — `C:\Windows\System32\config.png` | Not one of ours. Rewriting it would be a guess, and storing it would produce a URL that resolves to nothing. |

The last one needed an explicit helper — `looksLikeAbsoluteFilesystemPath()`
— because a Windows absolute path contains **no forward slashes at
all**. Split on `/` and you get a single innocuous-looking segment, and
the relative-key check waves it through. It has to be recognised by its
drive letter (`X:`) or its backslash separators.

---

## 6. `imageUrl()` and the legacy path

`src/lib/format/image.ts` gains `legacyPathToStorageKey(value)`.

```ts
export function legacyPathToStorageKey(value: string): string | null
```

It normalises the separators (`\` → `/`), finds the **last** occurrence
of `/uploads/`, and returns what follows it. Three shapes are
recognised:

- A Windows path — `C:\…\public\uploads\products\serum.jpg`
- A POSIX path — `/srv/app/public/uploads/products/serum.jpg`
- A path that already contains the uploads root mid-string

A path that does **not** contain the uploads root returns `null` — it
is not ours, and guessing at it would be worse than leaving it alone.

`imageUrl()` calls it, so the seeded rows render correctly **without
anyone opening and saving them**:

```
"C:\Users\…\public\uploads\products\Bioderma atoderm.jpg"
  → "/uploads/products/Bioderma atoderm.jpg"
```

The spaces in the filename are **kept**. The file on disk has spaces in
it, and the URL has to match it exactly — a "cleaned up" name would
point at nothing.

---

## 7. The audit trail

**No new `AdminAction` was needed.** `images` was already one of the
`EDITABLE_FIELDS` in `src/lib/admin/catalog.ts`, so `PRODUCT_UPDATED`
already carries the image diff, in the same transaction as the change.

The entry's `before` and `after` hold **the changed fields only**, so
the log reads "2 images → 1 image" rather than the entire product row.

### Making it readable

`src/app/admin/audit-logs/page.tsx` gained `formatImageList()`, which
renders an image list as:

> 2 images — 91a7d74458a22799241e0274e1381c85.png, 1b128866510c7bf59c81058d4f5fd5d6.png

rather than a raw JSON array. A diff that nobody can read is a diff
nobody reads.

---

## 8. The verification

### The tests

| File | Tests | What it covers |
|---|---|---|
| `tests/admin/product-images.test.ts` | 19 | The upload service: the key shape, the bytes on disk, multi-file, unique keys, a renamed payload refused, a MIME mismatch refused, the extension coming from the detected type, a GIF refused, a hostile filename absent from the key, spaces and special characters handled, the all-or-nothing batch, the empty batch, the over-cap batch, the at-cap batch, an oversized file, an empty file, the 415 code, the 400 code. |
| `tests/integration/admin-product-images.test.ts` | 6 | Against a real database: the key is not a URL, the bytes are on disk, attaching the image to a product, the `PRODUCT_UPDATED` diff carrying `before.images`/`after.images`, only the changed fields in the diff, a renamed payload refused, `firstImageUrl()` returning `/uploads/${key}`. |
| `tests/api/admin-product-images-route.test.ts` | 5 | The route: multi-file stored, the key and URL returned, no files → 400, a renamed payload → 415 with "JPEG" in the message, no session → 401. |
| `tests/format/image.test.ts` | 16 | `imageUrl()` for keys, absolute URLs, protocol-relative URLs, empty strings, legacy Windows and POSIX paths, and spaces preserved; `legacyPathToStorageKey()` for every branch; `firstImageUrl()`. |
| `tests/validation/admin-catalog.test.ts` | 41 | The image rules in the schema: a key accepted, an absolute URL accepted, a traversal refused, a legacy path normalised on both create and update, a foreign absolute path refused, a null byte refused, an empty reference refused, too many images refused. |

The suite went from **908 → 926** tests across 52 files, with nothing
removed. `tsc --noEmit` and `eslint .` are both clean, and `next build`
succeeds with `ƒ /api/admin/products/images` registered.

### The script

`scripts/verify-step14.ts` — 40 checks against a real database and a
real disk, with a **temporary upload root** so it never touches the
real `public/uploads` directory.

```
DATABASE_URL=postgresql://... npx tsx scripts/verify-step14.ts
```

It covers the upload (the generated key, the bytes on disk, the
hostile filename absent from the key), the renamed-payload refusal, the
all-or-nothing batch (asserted with a **tree walk** of the upload root,
so "nothing was written" cannot pass by accident), the batch cap, the
key-not-URL contract, the audit diff, the schema's accept-and-refuse
rules, and the legacy-path normalisation.

---

## 9. The files

### Created

| Path | Purpose |
|---|---|
| `src/lib/admin/product-images.ts` | The upload service. |
| `src/app/api/admin/products/images/route.ts` | The upload endpoint. |
| `src/components/admin/products/ProductImagePicker.tsx` | The file picker. |
| `tests/admin/product-images.test.ts` | The service tests. |
| `tests/integration/admin-product-images.test.ts` | The database tests. |
| `tests/api/admin-product-images-route.test.ts` | The route tests. |
| `tests/format/image.test.ts` | The URL-derivation tests. |
| `scripts/verify-step14.ts` | The verification script. |
| `docs/STEP-14-PRODUCT-IMAGE-UPLOADS.md` | This document. |

### Modified

| Path | Change |
|---|---|
| `src/components/admin/products/ProductFormDialog.tsx` | The textarea became `<ProductImagePicker />`; the state became a `string[]` of keys. |
| `src/lib/validation/admin.ts` | `productImageEntrySchema` — keys accepted, URLs passed through, legacy paths normalised, traversal refused. |
| `src/lib/format/image.ts` | `legacyPathToStorageKey()`, wired into `imageUrl()`. |
| `src/app/admin/audit-logs/page.tsx` | `formatImageList()` — a readable image diff. |
| `tests/validation/admin-catalog.test.ts` | The image rules rewritten around keys. |
| `DECISIONS.md` | Decisions #100–#106. |

### Deliberately NOT touched

| Path | Why |
|---|---|
| `src/lib/storage/local-driver.ts` | The driver already generated the key and already had the traversal guard. The upload path uses it as-is. |
| `src/lib/upload/validate.ts` | `assertValidImage()` already detected the type from the magic bytes and enforced the caps. |
| `src/lib/admin/catalog.ts` | `images` was already an editable field, so the audit trail needed no new action. |
| `prisma/schema.prisma` | The column already documented the key-not-URL contract. |
| `src/lib/admin/audit.ts` | No new `AdminAction` was needed. |

---

## 10. The decisions

| # | Area | Decision |
|---|---|---|
| 100 | The upload endpoint | The upload is its **own endpoint**, not a field on the product body. A multipart body would force every product create and update through a multipart parser, for a field most of them do not touch. |
| 101 | The key-not-URL contract | `Product.images` holds **storage keys**, and the URL is derived at render time. The uploader returns the key; the form posts the key. A `.url()` check on the schema was wrong — it would reject every key the pipeline produces. |
| 102 | The generated filename | The stored filename is **generated** (16 bytes of CSPRNG), never derived from the user's. So spaces, ampersands and non-ASCII characters are a non-issue, and `../../etc/passwd.png` cannot escape the upload root. The extension comes from the **detected** type, not the declared one. |
| 103 | The legacy path normalisation | A legacy absolute filesystem path is **rewritten to the key it points at**, not refused. The file has not moved; only the reference is corrected — and because the rewrite happens in the schema, saving a legacy product repairs it. |
| 104 | The all-or-nothing batch | Validation is **separated from the write**. The existing `uploadImage()` helper validates and writes in one call, so calling it in a loop would leave orphaned files behind when a later file in the batch is invalid. |
| 105 | The audit trail | An image change needs **no new `AdminAction`**. `images` was already an editable field, so `PRODUCT_UPDATED` already carries the diff, in the same transaction as the change. |
