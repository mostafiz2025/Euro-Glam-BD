/**
 * Building Cloudinary delivery URLs.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * A stored key has to become a URL in **two** places:
 *
 *   1. The **upload** path, when the admin's preview needs a URL and the
 *      upload response carries one.
 *   2. The **render** path, when the storefront draws the image.
 *
 * They are different modules — one is server-only, the other is imported
 * by client components — and when they build URLs separately they drift.
 * That drift is invisible until a shopper sees a broken image.
 *
 * So the URL is built **here**, once, by a module that has no
 * dependencies at all: no `cloudinary` SDK, no `node:fs`. It is safe to
 * import from a client component and from the server, so both paths
 * produce byte-identical URLs.
 *
 * ── Why the URL is not built by the Cloudinary SDK ────────────────────────
 *
 * `cloudinary.url()` works, but it emits a **signed** URL:
 *
 * ```
 * https://res.cloudinary.com/<cloud>/image/upload/v1/<folder>/<id>?_a=BAMAROiw0
 * ```
 *
 * Two things about that are wrong for this shop:
 *
 *   • The `v1/` segment and the `_a=` signature are Cloudinary's own
 *     delivery-format choices. They are **optional** — the bare form
 *     resolves to the same asset — but they mean the SDK's URL and a
 *     hand-built one are different strings for the same object.
 *
 *   • The signature is derived from the API secret. A URL carrying it is
 *     then **per-account and non-deterministic** across SDK versions,
 *     which makes it a poor thing to persist or to compare.
 *
 * The bare form is used instead:
 *
 * ```
 * https://res.cloudinary.com/<cloud>/image/upload/<folder>/<key>
 * ```
 *
 * It resolves to the same asset, it is stable, and it is identical
 * whether it was built by the driver or by the render helper.
 */

/**
 * The folder every object is written under.
 *
 * The storage scope is the **first segment** of the key, and the scope
 * is part of the Cloudinary `public_id` — so the key maps onto the URL
 * path directly, with this folder in front of it.
 */
export const CLOUDINARY_FOLDER = "euro-glam-bd";

/**
 * The Cloudinary cloud name, or `null` when it is not configured.
 *
 * Read from the environment at **call time** rather than at module load,
 * because the environment is not guaranteed to be populated when the
 * module is first imported.
 */
export function cloudinaryCloudName(): string | null {
  const name = process.env.CLOUDINARY_CLOUD_NAME;

  return name && name.trim().length > 0 ? name.trim() : null;
}

/**
 * Builds the Cloudinary delivery URL for a storage key.
 *
 * @param key - The storage key, e.g. `brands/2026/10/abc123.png`.
 *
 * @returns The delivery URL, or `null` when the cloud name is not
 *          configured — because a URL for an account that does not exist
 *          resolves to nothing, and returning one would be a lie.
 */
export function cloudinaryDeliveryUrl(key: string): string | null {
  const cloudName = cloudinaryCloudName();

  if (!cloudName) return null;

  const withoutLeadingSlash = key.trim().replace(/^\/+/, "");

  return `https://res.cloudinary.com/${cloudName}/image/upload/${CLOUDINARY_FOLDER}/${withoutLeadingSlash}`;
}

/**
 * Converts a storage key into a Cloudinary `public_id`.
 *
 * ── Why the folder is added at all ───────────────────────────────────────
 *
 * A key is `scope/<filename>` — `brands/2026/10/abc.png`. Cloudinary
 * stores the folder **inside** the `public_id`, so the object actually
 * lives at `euro-glam-bd/brands/2026/10/abc.png`. The key on its own
 * would therefore not find the file.
 *
 * ### Why the folder is not added twice
 *
 * The `public_id` that comes back from an upload **already contains the
 * folder** — Cloudinary returns `euro-glam-bd/brands/2026/10/abc`, not
 * `brands/2026/10/abc`.
 *
 * So the conversion has to be idempotent: a `public_id` that already
 * begins with the folder is left alone. Adding the folder a second time
 * produces `euro-glam-bd/euro-glam-bd/brands/…`, and every URL built
 * from it is a 404 — the file is real, the URL simply points somewhere
 * else.
 *
 * ### Why the extension is removed
 *
 * Cloudinary keeps the file's format in a **separate** field. The
 * uploaded asset is:
 *
 * ```
 * public_id : euro-glam-bd/products/n3bgpvbqb6tyqfclsziz
 * format    : png
 * ```
 *
 * There is no `.png` in the `public_id` — but the **key** has one,
 * because the local driver's key format includes the extension and the
 * two drivers share one column.
 *
 * So the extension is stripped on the way to the `public_id`. Keeping
 * it produces `euro-glam-bd/products/n3bgpvbqb6tyqfclsziz.png`, which
 * is a **different identifier**: the Admin API's `resource` and
 * `destroy` calls would answer "not found" for it, so `exists()` would
 * report every object as missing and `delete()` would silently leave
 * every object in place.
 *
 * The delivery URL is unaffected either way — Cloudinary's CDN accepts
 * the extension in the path and serves the same asset — which is exactly
 * why this failure is easy to miss: the images **render**, and only the
 * deletion quietly stops working.
 */
export function toCloudinaryPublicId(key: string): string {
  const trimmed = key.trim().replace(/^\/+/, "");

  const withoutFolder = trimmed.startsWith(`${CLOUDINARY_FOLDER}/`)
    ? trimmed.slice(CLOUDINARY_FOLDER.length + 1)
    : trimmed;

  return `${CLOUDINARY_FOLDER}/${stripExtension(withoutFolder)}`;
}

/**
 * Removes a file extension from a storage key.
 *
 * Only the **last** segment is considered, so a folder whose name
 * contains a dot — `v1.2/abc` — is left alone.
 */
function stripExtension(key: string): string {
  const lastSlash = key.lastIndexOf("/");
  const lastDot = key.lastIndexOf(".");

  // No dot, or the dot is in a folder segment rather than in the name.
  if (lastDot === -1 || lastDot < lastSlash) return key;

  return key.slice(0, lastDot);
}
