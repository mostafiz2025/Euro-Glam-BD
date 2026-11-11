import { ApiError } from "@/lib/api/errors";
import {
  deleteStoredObject,
  getStorageDriver,
  type StorageAdapter,
} from "@/lib/storage";

import {
  MAX_PRODUCT_IMAGES,
  uploadDiscoveryImages,
} from "./discovery-images";

/**
 * The maximum number of files in one upload request.
 *
 * The same cap the product's image list enforces. A form cannot produce
 * a list of 20 images by uploading 25 files, because the list is
 * capped at 20 — but capping the request too means a single request
 * cannot carry an unbounded amount of work.
 *
 * It is **defined** in `discovery-images.ts`, alongside the discovery
 * entity's cap, because the two belong to the same shared service — and
 * re-exported here so the product path (and its callers) can read it
 * from the product module without a second, divergent copy.
 */
export { MAX_PRODUCT_IMAGES };

/**
 * The product-image upload service.
 *
 * ── Why this is a separate route, and not a field on the product body ────
 *
 * A product's facts — its name, its price, its category — travel as JSON.
 * An image does not: it is bytes, and it has to be **validated, size-
 * capped, renamed and written to disk** before it is a key. Bolting a
 * `multipart/form-data` body onto `POST /api/admin/products` would force
 * *every* product create and update through a multipart parser, for a
 * field most of them do not touch.
 *
 * So the upload is its own endpoint. The flow is:
 *
 *   1. The admin picks files in the form.
 *   2. The form uploads them to this endpoint, which returns **keys**.
 *   3. The form sends the product's JSON body — including those keys —
 *      to the existing create / update endpoints.
 *
 * The product row is therefore never written with a file that has not
 * already been validated and stored. A half-finished upload leaves an
 * orphaned file on disk (a cleanup job's problem), never a product
 * pointing at a file that does not exist.
 *
 * ── Why the keys are storage keys, not URLs ───────────────────────────────
 *
 * The `Product.images` column holds storage adapter keys, so the driver
 * can be swapped for a bucket without rewriting every row. `imageUrl()`
 * turns a key into a public URL at render time. The uploader returns the
 * key, and the form sends the key.
 *
 * ── Why a failed upload cleans up after itself ────────────────────────────
 *
 * The route validates every file **before** writing any of them. So a
 * batch of five files where the fourth is a renamed `.txt` writes
 * nothing at all — there is no partial batch to clean up.
 *
 * But a write can still fail *after* an earlier file was written (a
 * disk-full error, say). When that happens the already-written files are
 * deleted, so a failed request leaves no orphaned bytes behind. The
 * cleanup is best-effort: a failure to delete is logged, not thrown,
 * because the original error is the one the admin needs to see.
 */

/**
 * The storage scope product images are written under.
 *
 * Must be one of the driver's allow-listed scopes.
 */
export const PRODUCT_IMAGE_SCOPE = "products";

/**
 * The result of a successful upload.
 */
export type ProductImageUploadResult = {
  /** The storage key, e.g. `products/2026/10/9f2c….png`. */
  readonly key: string;
  /** The public URL, e.g. `/uploads/products/2026/10/9f2c….png`. */
  readonly url: string;
  /** The original filename, as the admin's browser reported it. */
  readonly originalName: string;
  /** The detected MIME type. Detected from the bytes, never trusted. */
  readonly mimeType: string;
  /** The size in bytes. */
  readonly byteSize: number;
};

/**
 * Uploads a batch of product images.
 *
 * ── The order of operations ──────────────────────────────────────────────
 *
 * 1. **Validate every file first.** Nothing is written until every file
 *    has passed the magic-byte check, the size cap and the dimension
 *    cap. A batch is all-or-nothing.
 *
 * 2. **Write them.** Each write produces a generated key — never a name
 *    derived from the user's filename, so a file called
 *    `../../etc/passwd.png` cannot escape the upload root.
 *
 * 3. **Clean up on a partial failure.** If the third write fails, the
 *    first two are deleted.
 *
 * @param files - The uploaded files, already extracted from the form.
 * @param adapter - The storage adapter. Defaults to the **configured**
 *                  driver, so a production deployment writing to
 *                  Cloudinary does not have to be told about it here.
 *
 * @throws ApiError 400 when the batch is empty or too large.
 * @throws ApiError 413 when a file is too large.
 * @throws ApiError 415 when a file is not a supported image.
 */
export async function uploadProductImages(
  files: readonly File[],
  adapter: StorageAdapter = getStorageDriver(),
): Promise<ProductImageUploadResult[]> {
  if (files.length === 0) {
    throw ApiError.validation("Choose at least one image to upload.");
  }

  if (files.length > MAX_PRODUCT_IMAGES) {
    throw ApiError.validation(
      `You can upload at most ${MAX_PRODUCT_IMAGES} images at a time.`,
    );
  }

  /*
   * The algorithm — validate the whole batch, write each file, delete the
   * written ones if a later write fails — lives in `discovery-images.ts`,
   * because the storefront's category, concern and brand images need
   * exactly the same algorithm.
   *
   * The two caps differ (a product carries up to 20 images; a discovery
   * entity carries one), so the cap is **passed in** rather than being a
   * constant inside the shared service — neither caller's limit is
   * imposed on the other.
   */
  const uploaded = await uploadDiscoveryImages(
    files,
    PRODUCT_IMAGE_SCOPE,
    adapter,
    MAX_PRODUCT_IMAGES,
  );

  return uploaded.map((image) => ({
    key: image.key,
    url: image.url,
    originalName: image.originalName,
    mimeType: image.mimeType,
    byteSize: image.byteSize,
  }));
}

/**
 * Deletes product images that are no longer referenced.
 *
 * ── Why this is best-effort ─────────────────────────────────────────────
 *
 * The product row has already been updated by the time this runs — the
 * image list and the row move together. If a file cannot be deleted, the
 * product is still correct: it points at the images it should. An
 * orphaned file is a disk-space problem for a maintenance job, not a
 * correctness problem for the catalogue.
 *
 * So a failure here is logged, not thrown. Swallowing it would hide a
 * real problem; throwing it would fail a request whose actual work
 * succeeded.
 *
 * @param keys - The storage keys to remove.
 */
export async function deleteProductImages(
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
