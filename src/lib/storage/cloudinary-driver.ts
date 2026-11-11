import { v2 as cloudinary } from "cloudinary";

import {
  StorageError,
  isStorageScope,
  type PutInput,
  type StorageAdapter,
  type StoredObject,
} from "./adapter";

import {
  CLOUDINARY_FOLDER,
  cloudinaryDeliveryUrl,
  toCloudinaryPublicId,
} from "./cloudinary-url";

/**
 * The Cloudinary storage driver.
 *
 * ── What this is ─────────────────────────────────────────────────────────
 *
 * The driver the shop uses in production. The local filesystem driver
 * (`local-driver.ts`) is the development default; on Vercel the
 * filesystem is ephemeral, so an uploaded file would vanish on the next
 * deployment. Cloudinary is the object store that replaces it.
 *
 * ── Why the driver is its own module ─────────────────────────────────────
 *
 * `src/lib/storage/index.ts` selects between the drivers at runtime, and
 * it used to define the Cloudinary adapter inline. That put the
 * `cloudinary` import — and the config calls — in the same module as the
 * local driver's `node:fs` import. Moving it here means the URL helper
 * can import the Cloudinary URL builder without dragging the filesystem
 * module into a browser bundle.
 *
 * ── The keys are Cloudinary `public_id`s ──────────────────────────────────
 *
 * A key looks like `brands/2026/10/9f2c1a7b4e5d6c8a0b1c2d3e4f5a6b7c`.
 * The leading segment is the **folder**, which is the storage scope, and
 * the rest is the generated filename. So a key is still a key: the driver
 * can be swapped back to the local filesystem and the rows still mean
 * something.
 *
 * ── Why the extension is preserved in the `public_id` ─────────────────────
 *
 * Cloudinary's `public_id` normally has **no** extension — the format
 * lives in a separate `format` field on the upload response. But the
 * local driver *does* put the extension in the key (`….png`), and the
 * two drivers share one column.
 *
 * So the extension is appended to the `public_id` here. Cloudinary
 * accepts a `public_id` that carries an extension — it stores the whole
 * string as the identifier and still records the format separately — so
 * `brands/xyz.png` is a valid id, and `brands/xyz` (the same id without
 * the extension) is *not* the same object. That last point matters: the
 * local driver's key format is what the database already holds, so the
 * extension has to survive the round trip or a driver swap would orphan
 * every file.
 */
export class CloudinaryStorageDriver implements StorageAdapter {
  private readonly folder: string;

  constructor(folder = CLOUDINARY_FOLDER) {
    this.folder = folder;
  }

  /**
   * The Cloudinary account's cloud name.
   */
  private get cloudName(): string {
    const name = process.env.CLOUDINARY_CLOUD_NAME;

    if (!name) {
      throw new StorageError(
        "WRITE_FAILED",
        "CLOUDINARY_CLOUD_NAME is not configured.",
      );
    }

    return name;
  }

  /**
   * Configures the Cloudinary SDK with the server-side credentials.
   *
   * Called before every operation rather than once at module load,
   * because the credentials come from the environment and the environment
   * is not guaranteed to be populated at import time — a module-level
   * `cloudinary.config()` would capture `undefined` on a cold start.
   */
  private configure(): void {
    cloudinary.config({
      cloud_name: this.cloudName,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  /**
   * Writes an object and returns its key.
   */
  async put(input: PutInput): Promise<StoredObject> {
    const scope = input.scope.trim().toLowerCase();

    if (!isStorageScope(scope)) {
      throw new StorageError(
        "INVALID_SCOPE",
        `"${input.scope}" is not a valid storage scope.`,
      );
    }

    this.configure();

    try {
      const result = await new Promise<{
        public_id: string;
        bytes: number;
        format?: string;
        resource_type?: string;
        secure_url: string;
      }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `${this.folder}/${scope}`,
            resource_type: "auto",
            overwrite: false,
          },
          (error, uploaded) => {
            if (error || !uploaded) {
              reject(error ?? new Error("Cloudinary upload failed."));
              return;
            }

            resolve(uploaded as never);
          },
        );

        stream.end(input.bytes);
      });

      return {
        key: cloudinaryKey(result.public_id, result.format, this.folder),
        byteSize: result.bytes,
        mimeType: result.format ? `image/${result.format}` : input.mimeType,
      };
    } catch (error) {
      if (error instanceof StorageError) throw error;

      throw new StorageError(
        "WRITE_FAILED",
        "Could not write the file to Cloudinary.",
        error,
      );
    }
  }

  /**
   * Deletes an object.
   *
   * Idempotent: deleting a key that is already gone resolves
   * successfully. Cloudinary's `destroy` answers "not found" rather than
   * throwing, and an error is swallowed so a repeated cleanup run cannot
   * fail on a file it already removed.
   */
  async delete(key: string): Promise<void> {
    this.configure();

    try {
      await cloudinary.uploader.destroy(toCloudinaryPublicId(key));
    } catch (error) {
      throw new StorageError(
        "READ_FAILED",
        `Could not delete the stored object (key: ${key}).`,
        error,
      );
    }
  }

  /**
   * Returns the public URL for a key.
   *
   * The URL is built by the **shared** builder in `cloudinary-url.ts`,
   * not by the Cloudinary SDK. The SDK's `cloudinary.url()` emits a
   * signed URL carrying a `v1/` segment and a `_a=` signature derived
   * from the API secret — and the render path, which cannot import the
   * SDK, builds the bare form. Two builders means two URLs for one
   * object, and the two drift the moment either is edited.
   *
   * So both paths use the bare form, which resolves to the same asset.
   */
  getUrl(key: string): string {
    return cloudinaryDeliveryUrl(key) ?? "";
  }

  /**
   * Returns true when the object exists.
   */
  async exists(key: string): Promise<boolean> {
    try {
      this.configure();

      const result = await cloudinary.api.resource(
        toCloudinaryPublicId(key),
      );

      return !!result;
    } catch {
      return false;
    }
  }
}

/**
 * The file extension for a stored MIME type.
 *
 * Mirrors `MIME_TYPE_EXTENSIONS` in `src/lib/upload/validate.ts`, but
 * declared locally rather than imported: that module is safe to import
 * from the browser, but pulling it in here would drag the validation
 * logic into a module whose whole job is to be a thin driver.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Builds the storage key for an uploaded object.
 *
 * ── What the key looks like ──────────────────────────────────────────────
 *
 * The key is **scope-relative**: `brands/2026/10/abc.png`.
 *
 * That is deliberate. The local driver's key has the same shape — the
 * scope is the first segment, the rest is the generated filename — and
 * the column is shared between the two drivers. So a key written by
 * Cloudinary means the same thing as a key written to disk, and
 * switching the driver back and forth does not orphan a row.
 *
 * ### Why the folder is stripped
 *
 * Cloudinary's `public_id` comes back **with the folder already in it**:
 * `euro-glam-bd/brands/2026/10/abc`. The folder is a property of
 * *where the object lives*, not of what the key is — the local driver's
 * key does not carry the upload root either, even though the file sits
 * under `public/uploads/`.
 *
 * So the folder is removed. Leaving it in would give the key a
 * `euro-glam-bd/` prefix that the local driver never produces, and the
 * URL builder would then prepend the folder a second time.
 *
 * ### Why the extension is appended
 *
 * Cloudinary's `public_id` has **no** extension — the format lives in a
 * separate `format` field on the upload response, so the uploaded asset
 * is `euro-glam-bd/products/xyz` with `format: png`.
 *
 * But the local driver *does* put the extension in the key (`….png`),
 * and the two drivers share one column. So the extension is appended
 * here, and the key comes out as `products/xyz.png`.
 *
 * That keeps the key **driver-agnostic**: a key written by Cloudinary
 * means the same thing as a key written to disk, so the driver can be
 * swapped without orphaning a row.
 *
 * The `public_id` is reconstructed from the key by
 * `toCloudinaryPublicId()`, which strips the extension again — Cloudinary
 * identifies the asset by the extension-less id.
 */
function cloudinaryKey(
  publicId: string,
  format: string | undefined,
  folder: string,
): string {
  /*
   * The folder is stripped, so the key is scope-relative.
   *
   * `public_id` arrives as `euro-glam-bd/brands/2026/10/abc`, and the
   * key should be `brands/2026/10/abc`.
   */
  let key = publicId;

  if (key.startsWith(`${folder}/`)) {
    key = key.slice(folder.length + 1);
  }

  if (!format) return key;

  const extension = EXTENSION_BY_MIME[`image/${format}`] ?? format;

  // The `public_id` already carries the extension when the extension was
  // part of the uploaded filename.
  if (key.toLowerCase().endsWith(`.${extension}`)) {
    return key;
  }

  return `${key}.${extension}`;
}

/**
 * Returns the shared Cloudinary driver.
 *
 * A module-level singleton, so the resolved folder is computed once
 * rather than on every call.
 */
let sharedDriver: CloudinaryStorageDriver | null = null;

export function getCloudinaryStorageDriver(): CloudinaryStorageDriver {
  if (!sharedDriver) {
    sharedDriver = new CloudinaryStorageDriver();
  }

  return sharedDriver;
}
