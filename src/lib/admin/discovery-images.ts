import { ApiError } from "@/lib/api/errors";
import {
  StorageError,
  deleteStoredObject,
  getStorageDriver,
  type StorageAdapter,
  type StorageScope,
} from "@/lib/storage";
import {
  UploadValidationError,
  assertValidImage,
  type AllowedImageMimeType,
} from "@/lib/upload/validate";

/**
 * The discovery-image upload service.
 *
 * ── What this is ─────────────────────────────────────────────────────────
 *
 * The storefront's three discovery sections — "Shop By Category", "Shop By
 * Skin Concern" and "Shop By Brand" — each carry an image. This service
 * uploads one file into any of the three discovery scopes.
 *
 * It exists as a **generalisation** of the product-image upload, not as a
 * copy of it. The product path already had the whole algorithm — validate
 * the batch up front, write each file, delete the written ones if a later
 * write fails — and three near-identical copies of that algorithm would
 * be three places for it to drift. So the algorithm lives here, and
 * `uploadProductImages` calls it.
 *
 * ── Why the upload is its own endpoint ───────────────────────────────────
 *
 * A category's name and slug travel as JSON. Its image does not: it is
 * bytes, and it has to be **validated, size-capped, renamed and written
 * to disk** before it is a key. Bolting a `multipart/form-data` body onto
 * the create/update endpoints would force *every* write through a
 * multipart parser, for a field most of them do not touch.
 *
 * So the flow is:
 *
 *   1. The admin picks a file in the form.
 *   2. The form uploads it to the upload endpoint, which returns a **key**.
 *   3. The form sends the record's JSON body — including that key — to
 *      the create / update endpoint.
 *
 * The row is therefore never written with a file that has not already been
 * validated and stored. A half-finished upload leaves an orphaned file on
 * disk (a cleanup job's problem), never a row pointing at a file that does
 * not exist.
 *
 * ── Why the keys are storage keys, not URLs ───────────────────────────────
 *
 * The `image` / `logo` columns hold storage adapter keys, so the driver
 * can be swapped for a bucket without rewriting every row. `imageUrl()`
 * turns a key into a public URL at render time. The uploader returns the
 * key, and the form sends the key.
 */

/**
 * The storage scopes the discovery images live under.
 *
 * Each is one of the driver's allow-listed scopes. They are separate
 * directories because the three are managed independently: a brand's logo
 * is replaced far more often than a category's card image, and one scope's
 * cleanup must not sweep another's files.
 */
export const DISCOVERY_IMAGE_SCOPES = {
  categories: "categories",
  concerns: "concerns",
  brands: "brands",
  hero: "hero",
} as const satisfies Record<string, StorageScope>;

/**
 * The scope used for a discovery entity.
 *
 * The **product** scope is in the union too, because the product-image
 * upload shares this service — the algorithm is identical, and the
 * difference between a product's twenty images and a category's one is a
 * cap on the batch, not a different pipeline.
 *
 * The **hero** scope is in the union for the same reason: the homepage
 * banner's artwork goes through the identical validate-then-write
 * pipeline, under its own storage scope so the campaign's turnover does
 * not disturb the discovery sections' files.
 */
export type DiscoveryImageScope =
  | (typeof DISCOVERY_IMAGE_SCOPES)[keyof typeof DISCOVERY_IMAGE_SCOPES]
  | "products";

/**
 * The maximum number of files in one upload request.
 *
 * A discovery entity carries **one** image, but the endpoint accepts a
 * batch so that the client component is the same shape as the product
 * one, and so a drag-and-drop of several files reports all of them at
 * once rather than failing on the second.
 */
export const MAX_DISCOVERY_IMAGES = 4;

/**
 * The maximum number of files the **product** upload accepts.
 *
 * The product carries up to twenty images, so its cap is higher. The cap
 * is a **parameter** of the shared service rather than a constant inside
 * it, precisely so the two callers can have different limits without
 * either one imposing its limit on the other.
 *
 * The value is **imported** from the validation layer, which owns it.
 * The validation layer is the lowest of the three — it does not import
 * from the admin services — so defining the number there and importing
 * it here means the schema's cap, this cap, and the picker's cap cannot
 * drift apart. A form that offers one more image than the schema
 * accepts would fail with a validation error naming no field.
 */
export { MAX_PRODUCT_IMAGES } from "@/lib/validation/admin";

/**
 * The result of a successful upload.
 */
export type DiscoveryImageUploadResult = {
  /** The storage key, e.g. `brands/2026/10/9f2c….png`. */
  readonly key: string;
  /** The public URL, e.g. `/uploads/brands/2026/10/9f2c….png`. */
  readonly url: string;
  /** The original filename, as the admin's browser reported it. */
  readonly originalName: string;
  /** The detected MIME type. Detected from the bytes, never trusted. */
  readonly mimeType: string;
  /** The size in bytes. */
  readonly byteSize: number;
};

/**
 * Converts an upload failure into the API's typed error.
 *
 * The distinction the admin cares about:
 *
 *   • **413** — the file is too big. The admin can fix that by choosing a
 *     smaller image.
 *   • **415** — the file is not a supported image, or its contents do not
 *     match its name. The admin can fix that by choosing another file.
 *   • **400** — the request itself was malformed (no files at all).
 *
 * A `StorageError` from the driver is an **internal** failure — the bytes
 * were fine and the disk said no. It is logged and reported as a generic
 * 500, because its message names an internal path and an admin cannot act
 * on it.
 */
function toApiError(error: unknown): ApiError {
  if (error instanceof UploadValidationError) {
    return new ApiError(
      error.code === "FILE_TOO_LARGE"
        ? "PAYLOAD_TOO_LARGE"
        : "UNSUPPORTED_MEDIA_TYPE",
      error.message,
    );
  }

  if (error instanceof StorageError) {
    console.error("[admin] Discovery image storage failed:", error);

    return new ApiError(
      "INTERNAL_ERROR",
      "The image could not be saved. Please try again.",
    );
  }

  return error as ApiError;
}

/**
 * Uploads a batch of discovery images into one scope.
 *
 * ── The order of operations ──────────────────────────────────────────────
 *
 * 1. **Validate every file first.** Nothing is written until every file
 *    has passed the magic-byte check, the size cap and the dimension cap.
 *    A batch is all-or-nothing.
 *
 * 2. **Write them.** Each write produces a generated key — never a name
 *    derived from the user's filename, so a file called
 *    `../../etc/passwd.png` cannot escape the upload root.
 *
 * 3. **Clean up on a partial failure.** If the third write fails, the
 *    first two are deleted.
 *
 * @param files   - The uploaded files, already extracted from the form.
 * @param scope   - The storage scope to write under.
 * @param adapter - The storage adapter. Defaults to the dynamic driver selector.
 * @param maxFiles - The largest batch this caller accepts.
 *
 * @throws ApiError 400 when the batch is empty or too large.
 * @throws ApiError 413 when a file is too large.
 * @throws ApiError 415 when a file is not a supported image.
 */
export async function uploadDiscoveryImages(
  files: readonly File[],
  scope: DiscoveryImageScope,
  adapter: StorageAdapter = getStorageDriver(),
  maxFiles: number = MAX_DISCOVERY_IMAGES,
): Promise<DiscoveryImageUploadResult[]> {
  if (files.length === 0) {
    throw ApiError.validation("Choose at least one image to upload.");
  }

  if (files.length > maxFiles) {
    throw ApiError.validation(
      `You can upload at most ${maxFiles} images at a time.`,
    );
  }

  // ── Validate the whole batch before writing any of it ───────────────
  const prepared = await Promise.all(
    files.map(async (file) => {
      const bytes = Buffer.from(await file.arrayBuffer());

      let validated;

      try {
        validated = assertValidImage(bytes, file.type);
      } catch (error) {
        throw toApiError(error);
      }

      return {
        bytes,
        file,
        mimeType: validated.mimeType as AllowedImageMimeType,
      };
    }),
  );

  // ── Write them ──────────────────────────────────────────────────────
  const results: DiscoveryImageUploadResult[] = [];
  const written: string[] = [];

  try {
    for (const entry of prepared) {
      const stored = await adapter.put({
        bytes: entry.bytes,
        mimeType: entry.mimeType,
        originalName: entry.file.name,
        scope,
      });

      written.push(stored.key);

      results.push({
        key: stored.key,
        url: adapter.getUrl(stored.key),
        originalName: entry.file.name,
        mimeType: stored.mimeType,
        byteSize: stored.byteSize,
      });
    }
  } catch (error) {
    await Promise.all(
      written.map((key) =>
        deleteStoredObject(key, adapter).catch((cleanupError: unknown) => {
          console.error(
            `[admin] Orphan cleanup failed for "${key}":`,
            cleanupError,
          );
        }),
      ),
    );

    throw toApiError(error);
  }

  return results;
}

/**
 * Deletes discovery images that are no longer referenced.
 *
 * @param keys - The storage keys to remove.
 */
export async function deleteDiscoveryImages(
  keys: readonly string[],
  adapter: StorageAdapter = getStorageDriver(),
): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      deleteStoredObject(key, adapter).catch((error: unknown) => {
        console.error(
          `[admin] Orphan cleanup failed for "${key}":`,
          error,
        );
      }),
    ),
  );
}