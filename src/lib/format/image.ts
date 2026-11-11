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
 */
function isCloudinaryDriver(): boolean {
  return (
    process.env.STORAGE_DRIVER === "cloudinary" ||
    Boolean(process.env.CLOUDINARY_CLOUD_NAME) ||
    Boolean(process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME) ||
    process.env.NODE_ENV === "production"
  );
}

/**
 * The local driver's URL prefix.
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
  // ডাটাবেজ থেকে যদি অ্যারে বা কোটেশন আকারে স্ট্রিং আসে, সেগুলোকে ক্লিন করে নেওয়া
  const cleanedKey = key
    .replace(/^\[\s*["']?/, "")
    .replace(/["']?\s*\]$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();

  const trimmed = cleanedKey;

  if (trimmed === "") {
    return "";
  }

  // A key that is already an absolute URL is passed through.
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("//")
  ) {
    return trimmed;
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");

  const legacyKey = legacyPathToStorageKey(withoutLeadingSlash);

  const storageKey = legacyKey ?? withoutLeadingSlash;

  if (isCloudinaryDriver()) {
    // প্রথমে ড্রাইভারে থাকা ফাংশন দিয়ে ট্রাই করবে
    const url = cloudinaryDeliveryUrl(storageKey);
    if (url !== null) return url;

    // যদি কোনো কারণে null রিটার্ন করে, তবে সরাসরি ক্লাউডিনারি স্ট্যান্ডার্ড ইউআরএল তৈরি করে দেবে
    // এখানে আপনার ক্লাউডিনারি ক্লাউড নেম অথবা এনভায়রনমেন্ট থেকে নাম নেবে
    const cloudName =
      process.env.CLOUDINARY_CLOUD_NAME ||
      process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ||
      "dlmhnvjj2"; // আপনার প্রজেক্টের ক্লাউডিনারি একাউন্ট বা ফলব্যাক নাম

    if (cloudName) {
      const cleanKey = storageKey.replace(/^\/+/, "");
      return `https://res.cloudinary.com/${cloudName}/image/upload/euro-glam-bd/${cleanKey}`;
    }
  }

  return `${localUrlPrefix()}/${storageKey}`;
}

/**
 * Extracts the storage key from a **legacy absolute filesystem path**.
 */
export function legacyPathToStorageKey(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === "") return null;

  const unified = trimmed.replace(/\\/g, "/");

  const marker = unified.lastIndexOf("/uploads/");

  if (marker === -1) return null;

  const key = unified.slice(marker + "/uploads/".length);

  if (key.length === 0) return null;

  return key;
}

/**
 * Returns the first usable image URL from a product's image list.
 */
export function firstImageUrl(images: readonly string[]): string | null {
  for (const key of images) {
    const url = imageUrl(key);
    if (url !== "") return url;
  }

  return null;
}