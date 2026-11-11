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
 * So the URL prefix is re-declared here as a plain constant, and the
 * conversion is a string join. The value must match
 * `STORAGE_URL_PREFIX` in the environment and `LOCAL_URL_PREFIX` in
 * `src/lib/storage/local-driver.ts` — and the test for this module
 * asserts that it does.
 *
 * ── The rule this module follows now ────────────────────────────────────
 *
 * **A key is resolved by the driver that wrote it.** The column does not
 * record which driver produced a key, so the URL is derived from the
 * *currently configured* driver — the same one the upload path writes
 * through (`getStorageDriver()`).
 *
 * That matters because the two drivers produce different key shapes and
 * different URLs:
 *
 *   • The **local** driver writes `brands/2026/10/abc.png` and serves
 *     it at `/uploads/brands/2026/10/abc.png`.
 *
 *   • The **Cloudinary** driver writes `brands/2026/10/abc.png` and
 *     serves it at
 *     `https://res.cloudinary.com/<cloud>/image/upload/euro-glam-bd/brands/2026/10/abc.png`.
 *
 * Hardcoding the local prefix meant that every image uploaded through
 * Cloudinary — which is the production configuration — rendered as a
 * broken path, and every admin preview did too. So the prefix is now
 * read from the environment, and the Cloudinary URL is built by the
 * driver itself.
 *
 * ### Why the environment is read here rather than imported from the driver
 *
 * `process.env` is read at **call time**, not at module load. A
 * module-level constant would capture the value at import time, and the
 * local driver's prefix is configurable per deployment — so the constant
 * would be wrong the moment the environment changed.
 */

import { cloudinaryDeliveryUrl } from "@/lib/storage/cloudinary-url";

/**
 * The public URL prefix for stored objects, when the **local** driver
 * is in use.
 *
 * The local driver serves files from `public/uploads`, which Next.js
 * serves at `/uploads/<key>`. A deployment fronting the files with a CDN
 * overrides `STORAGE_URL_PREFIX` in the environment.
 *
 * Mirrors `LOCAL_URL_PREFIX` in `src/lib/storage/local-driver.ts`.
 */
export const IMAGE_URL_PREFIX = "/uploads";

/**
 * Whether the **Cloudinary** driver is the configured one.
 *
 * The same check `getStorageDriver()` makes, so the URL this module
 * builds and the driver the upload path writes through cannot disagree
 * about which driver is in use.
 */
function isCloudinaryDriver(): boolean {
  return (
    process.env.STORAGE_DRIVER === "cloudinary" ||
    Boolean(process.env.CLOUDINARY_CLOUD_NAME)
  );
}

/**
 * The local driver's URL prefix.
 *
 * Read from the environment at **call time**, so a deployment that
 * changes `STORAGE_URL_PREFIX` is honoured without a rebuild — and so
 * the value never disagrees with the local driver's own `getUrl()`.
 */
function localUrlPrefix(): string {
  const configured = process.env.STORAGE_URL_PREFIX;

  const prefix =
    configured && configured.trim().length > 0
      ? configured.trim()
      : IMAGE_URL_PREFIX;

  return prefix.replace(/\/+$/, "");
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

  /*
   * A legacy row holds an **absolute filesystem path** — the path on
   * the machine that uploaded the file, not a storage key. Joining it
   * onto `/uploads` produced a URL that resolved to nothing, so the
   * product showed its placeholder while the image sat on disk.
   *
   * The path is rewritten to the key it was pointing at. The file has
   * not moved; only the reference is corrected.
   */
  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");

  const legacyKey = legacyPathToStorageKey(withoutLeadingSlash);

  const storageKey = legacyKey ?? withoutLeadingSlash;

  /*
   * The Cloudinary driver serves the key from its own CDN, so the URL is
   * built from the cloud name rather than from the local prefix.
   *
   * When the cloud name is **not** configured the local URL is used
   * instead. That is the honest fallback: a Cloudinary deployment with
   * no cloud name cannot serve a Cloudinary URL, and returning an empty
   * string would render nothing at all — whereas the local URL at least
   * points at the path the file would occupy on the local driver.
   */
  if (isCloudinaryDriver()) {
    const url = cloudinaryDeliveryUrl(storageKey);

    if (url !== null) return url;
  }

  return `${localUrlPrefix()}/${storageKey}`;
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