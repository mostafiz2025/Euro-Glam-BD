/**
 * Turning a storage key into a displayable URL.
 *
 * ── Why this file exists, and why it does not import the driver ─────────
 *
 * `Product.images` holds **storage adapter keys**, not URLs. The schema
 * says so explicitly: "Storage adapter keys — NOT raw URLs, so the
 * driver can be swapped."
 *
 * The obvious implementation would be to call `getStorageUrl()` from
 * `src/lib/storage/index.ts`. That module is correct — but it imports
 * `node:fs` through the local driver, so a client component that
 * imports it would pull the Node filesystem module into the browser
 * bundle. That is a build error at best.
 *
 * So the URL is derived here, from the same constants the drivers use,
 * without importing either driver.
 *
 * ── Why the prefix is a function of the configured driver ────────────────
 *
 * The local driver serves files from `public/uploads`, which Next.js
 * serves at `/uploads/<key>`. The Cloudinary driver serves them from
 * `https://res.cloudinary.com/<cloud>/image/upload/<folder>/<key>`.
 *
 * A single hardcoded prefix cannot produce both. With `STORAGE_DRIVER`
 * set to `cloudinary` and a hardcoded `/uploads`, every product image
 * on the storefront would point at `/uploads/products/2026/11/abc.png`
 * — a path that resolves to nothing, because the file was never written
 * to the local disk. The catalogue would show the typographic
 * placeholder for every product, and the images would be sitting in
 * Cloudinary where nothing looked for them.
 *
 * So the derivation is a **pure function of the driver name**, and the
 * driver name comes from `STORAGE_DRIVER`. Both are read at call time
 * rather than at module load, so the value reflects the environment the
 * page is actually being rendered in.
 *
 * ── Why the driver name has a `NEXT_PUBLIC_` twin ────────────────────────
 *
 * This module is imported by **client components** — the admin image
 * picker's preview grid and the discovery image field are both
 * `"use client"`. Next.js inlines only `NEXT_PUBLIC_*` variables into the
 * browser bundle; every other name compiles to a lookup on an empty
 * object.
 *
 * So the driver name and the cloud name each have a public twin:
 *
 *   • `NEXT_PUBLIC_STORAGE_DRIVER`
 *   • `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`
 *
 * The public names are read first, and the server-only names are the
 * fallback. The server has both; the browser has only the public ones.
 *
 * Without the public twins this module was **half working**: the
 * server-rendered pages produced Cloudinary URLs and looked correct,
 * while the client components fell back to `/uploads/<key>` and showed
 * blank previews. The two halves of the same page disagreed about where
 * the image lived.
 */

/**
 * The public URL prefix for stored objects.
 *
 * The local driver serves files from `public/uploads`, which Next.js
 * serves at `/uploads/<key>`. A deployment fronting the files with a CDN
 * overrides `STORAGE_URL_PREFIX` in the environment.
 *
 * Mirrors `LOCAL_URL_PREFIX` in `src/lib/storage/local-driver.ts`.
 */
export const IMAGE_URL_PREFIX = "/uploads";

/**
 * The Cloudinary folder every upload is written under.
 *
 * Mirrors `CLOUDINARY_FOLDER` in `src/lib/storage/cloudinary.ts`.
 */
const CLOUDINARY_FOLDER = "euro-glam-bd";

/**
 * The configured storage driver, read at call time.
 *
 * ── Why the public variable comes first ───────────────────────────────────
 *
 * `process.env.STORAGE_DRIVER` is a **server-only** variable. Next.js
 * inlines only `NEXT_PUBLIC_*` variables into the browser bundle; every
 * other name compiles to a lookup on an empty object, so on the client it
 * is always `undefined`.
 *
 * That is not a subtlety — it is the whole bug this module had:
 *
 *   • The **server-rendered** pages read the real value and produced a
 *     Cloudinary URL, so the storefront and the admin table looked right.
 *   • The **client components** — the admin image picker's preview grid,
 *     the discovery image field — read `undefined`, fell back to
 *     `"local"`, and produced `/uploads/<key>`. Under the Cloudinary
 *     driver that path resolves to nothing, so the previews were blank.
 *
 * So the browser has to be given the configuration explicitly, through a
 * `NEXT_PUBLIC_*` variable. The server-only name is still read as a
 * fallback, because the server has both — and the server is where the
 * authoritative answer lives.
 *
 * The value is normalised exactly as `getStorageDriverName()` in
 * `src/lib/storage/index.ts` normalises it, so the two agree on what
 * "cloudinary" means. Anything that is not `cloudinary` is the local
 * driver — which is also what the dispatch falls back to.
 */
function configuredDriver(): string {
  const configured =
    process.env.NEXT_PUBLIC_STORAGE_DRIVER ?? process.env.STORAGE_DRIVER;

  return configured?.trim().toLowerCase() || "local";
}

/**
 * The Cloudinary cloud name, read at call time.
 *
 * The URL is built by hand rather than by the Cloudinary SDK, because
 * the SDK is a server-side dependency and this module is imported by
 * client components. The cloud name is the one piece of configuration
 * the URL needs.
 *
 * The same public-first rule applies: the browser only sees the
 * `NEXT_PUBLIC_` name, and the server-only name is the fallback.
 */
function cloudinaryCloudName(): string {
  const configured =
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ??
    process.env.CLOUDINARY_CLOUD_NAME;

  const trimmed = configured?.trim();

  if (trimmed) {
    return trimmed;
  }

  /*
   * No cloud name means no Cloudinary URL can be built. Falling back to
   * the local prefix would point at a path that does not exist, which
   * is the same broken picture the hardcoded prefix produced. An empty
   * cloud name makes the image fail visibly in the admin console —
   * where the mistake is being made — rather than silently on the
   * storefront.
   */
  return "";
}

/**
 * Removes the extension from a storage key.
 *
 * Mirrors `stripExtension()` in `src/lib/storage/cloudinary.ts`. A
 * Cloudinary asset's **public id** does not carry its format — the
 * format is a separate field of the asset — so the delivery URL must
 * not carry it either.
 */
function stripExtension(key: string): string {
  const lastSlash = key.lastIndexOf("/");
  const lastDot = key.lastIndexOf(".");

  if (lastDot <= lastSlash) {
    return key;
  }

  return key.slice(0, lastDot);
}

/**
 * The Cloudinary delivery URL for a storage key.
 *
 * The shape is exactly what `CloudinaryStorageDriver.getUrl()` produces:
 * `https://res.cloudinary.com/<cloud>/image/upload/<folder>/<key>`.
 *
 * The two must agree. A key that produced one URL in the admin console
 * and a different URL on the storefront would be a bug that only shows
 * up when someone compares the two screens — and the image optimiser
 * caches by URL, so the two would be two separate cached copies of the
 * same picture.
 */
function cloudinaryUrl(key: string): string {
  const cloudName = cloudinaryCloudName();

  return `https://res.cloudinary.com/${cloudName}/image/upload/${CLOUDINARY_FOLDER}/${stripExtension(key)}`;
}

/**
 * Converts a storage key into a public URL.
 *
 * @param key - The storage key, e.g. `advisor/2026/10/9f2c….webp`.
 */
export function imageUrl(key: string): string {
  const trimmed = key.trim();

  if (trimmed === "") {
    return "";
  }

  // A key that is already an absolute URL is passed through. This makes
  // the component tolerant of a row that was written by an admin who
  // pasted a URL into the image field.
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("//")
  ) {
    return trimmed;
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");

  /*
   * A legacy row holds an **absolute filesystem path** — the path on
   * the machine that uploaded the file, not a storage key. Joining it
   * onto `/uploads` produced a URL that resolved to nothing, so the
   * product showed its placeholder while the image sat on disk.
   *
   * The path is rewritten to the key it was pointing at. The file has
   * not moved; only the reference is corrected.
   */
  const legacyKey = legacyPathToStorageKey(withoutLeadingSlash);

  const storageKey = legacyKey ?? withoutLeadingSlash;

  if (configuredDriver() === "cloudinary") {
    return cloudinaryUrl(storageKey);
  }

  return `${IMAGE_URL_PREFIX}/${storageKey}`;
}

/**
 * Extracts the storage key from a **legacy absolute filesystem path**.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Before the upload pipeline, images were placed into
 * `public/uploads/products/` by hand and the **absolute path on the
 * machine that uploaded them** was written into the column:
 *
 * ```
 * C:\Users\someone\Downloads\Euro Glam BD\public\uploads\products\serum.jpg
 * ```
 *
 * That is not a storage key, and joining it onto `/uploads` produced
 * `/uploads/C:\Users\...\serum.jpg` — a URL that resolves to nothing.
 * Every one of those products showed the typographic placeholder on the
 * storefront, and the image was sitting on disk the whole time.
 *
 * So the path is rewritten to the key it was pointing at:
 * `products/serum.jpg`. The file is still exactly where it was; only
 * the reference is corrected.
 *
 * ### The three shapes it recognises
 *
 *   • A Windows path — `C:\…\public\uploads\products\serum.jpg`
 *   • A POSIX path — `/srv/app/public/uploads/products/serum.jpg`
 *   • A path that already contains the uploads root mid-string
 *
 * A path that does **not** contain the uploads root is not one of ours,
 * and it is returned unchanged rather than guessed at.
 */
export function legacyPathToStorageKey(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === "") return null;

  // Normalise the separators so one rule handles both platforms. The
  // Windows drive letter keeps its colon — the regex below looks for
  // the uploads root, not for a drive letter.
  const unified = trimmed.replace(/\\/g, "/");

  // The marker that identifies "this path points into our uploads
  // directory". Both the public/uploads form and the uploads form are
  // accepted, because the driver root is configurable.
  const marker = unified.lastIndexOf("/uploads/");

  if (marker === -1) return null;

  const key = unified.slice(marker + "/uploads/".length);

  if (key.length === 0) return null;

  return key;
}

/**
 * Returns the first usable image URL from a product's image list.
 *
 * The list is a `String[]` on the schema, and it may be empty — the
 * seeded catalogue has no images at all. A component that assumes a
 * non-empty list crashes on the very first product in the database, so
 * every image consumer goes through here and gets `null` instead.
 */
export function firstImageUrl(images: readonly string[]): string | null {
  for (const key of images) {
    const url = imageUrl(key);
    if (url !== "") return url;
  }

  return null;
}
