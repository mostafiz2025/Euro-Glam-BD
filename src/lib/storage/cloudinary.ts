import { randomBytes } from "node:crypto";

import { v2 as cloudinary } from "cloudinary";

import { MIME_TYPE_EXTENSIONS } from "@/lib/upload/validate";

import {
  StorageError,
  isStorageScope,
  type PutInput,
  type StorageAdapter,
  type StoredObject,
} from "./adapter";

/**
 * The Cloudinary storage driver.
 *
 * ── Design notes ─────────────────────────────────────────────────────────
 *
 * • **Cloud-based storage for serverless environments (e.g., Vercel).**
 *   Replaces the local filesystem driver to persist uploaded assets
 *   securely on Cloudinary.
 *
 * • **Idempotency & URL resolution:**
 *   The object is stored under a **key**, not a URL. `Product.images` and
 *   `AdvisorImage.storageKey` persist the key, and the public URL is
 *   derived from it at render time via `getUrl()`. This is the adapter's
 *   documented invariant — storing a URL would bake the driver into every
 *   database row and make a future migration a rewrite of the data
 *   rather than a config change.
 *
 *   The key is the Cloudinary **public id** prefixed with the scope, so
 *   `euro-glam-bd/products/2026/11/<random>.webp` round-trips to a
 *   `res.cloudinary.com` URL without any lookup.
 *
 * • **The configuration is read at call time, not at module load.**
 *   `cloudinary.config()` at module scope would capture `undefined` for
 *   every variable in a build that does not use this driver, and would
 *   make the module unimportable in a test that stubs the environment.
 */

/**
 * The Cloudinary folder every upload is written under.
 */
const CLOUDINARY_FOLDER = "euro-glam-bd";

/**
 * The number of random bytes in a generated object name.
 *
 * 16 bytes = 128 bits of entropy, rendered as 32 hex characters — the
 * same guarantee the local driver makes.
 */
const RANDOM_BYTES = 16;

/**
 * The type Cloudinary returns for an uploaded asset.
 */
type CloudinaryUploadResult = {
  readonly public_id: string;
  readonly secure_url: string;
  readonly bytes: number;
  readonly resource_type: string;
  readonly format: string;
};

/**
 * The configuration Cloudinary needs.
 */
type CloudinaryConfig = {
  readonly cloudName: string;
  readonly apiKey: string;
  readonly apiSecret: string;
};

/**
 * Reads the Cloudinary configuration from the environment.
 *
 * @throws StorageError when a variable is missing. A missing credential is
 *   a hard failure, not a silent fall back to the local driver — a
 *   deployment that looks healthy while writing uploads somewhere nobody
 *   is looking is worse than one that refuses to start.
 */
function readConfig(): CloudinaryConfig {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

  const missing: string[] = [];

  if (!cloudName) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!apiKey) missing.push("CLOUDINARY_API_KEY");
  if (!apiSecret) missing.push("CLOUDINARY_API_SECRET");

  if (missing.length > 0) {
    throw new StorageError(
      "WRITE_FAILED",
      `The Cloudinary storage driver is not configured. Missing: ${missing.join(", ")}.`,
    );
  }

  return {
    cloudName: cloudName as string,
    apiKey: apiKey as string,
    apiSecret: apiSecret as string,
  };
}

/**
 * Applies the configuration to the Cloudinary SDK.
 */
function applyConfig(config: CloudinaryConfig): void {
  cloudinary.config({
    cloud_name: config.cloudName,
    api_key: config.apiKey,
    api_secret: config.apiSecret,
    secure: true,
  });
}

/**
 * Builds the storage key for an upload.
 *
 * The shape matches the local driver's exactly — `<scope>/<yyyy>/<mm>/<random>.<ext>`
 * — so a key means the same thing whichever driver produced it.
 */
function buildKey(
  scope: string,
  mimeType: string,
  now: Date,
): { key: string; extension: string } {
  const extension =
    MIME_TYPE_EXTENSIONS[mimeType as keyof typeof MIME_TYPE_EXTENSIONS];

  if (!extension) {
    throw new StorageError(
      "UNSUPPORTED_MIME_TYPE",
      `No file extension is defined for the MIME type "${mimeType}".`,
    );
  }

  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const random = randomBytes(RANDOM_BYTES).toString("hex");

  return { key: `${scope}/${year}/${month}/${random}.${extension}`, extension };
}

/**
 * The Cloudinary resource type for a MIME type.
 *
 * Cloudinary stores images and videos in **separate namespaces**. An
 * object uploaded as a `video` is not found by a lookup for an `image`
 * with the same public id, so the resource type has to be decided the
 * same way in every operation — and it has to be decided from the
 * MIME type, which is what the key's extension already encodes.
 *
 * A `video/` MIME type is a video. Everything else the driver accepts
 * is an image.
 */
function resourceTypeFor(mimeType: string): "image" | "video" {
  return mimeType.startsWith("video/") ? "video" : "image";
}

/**
 * The resource type a stored key belongs to.
 *
 * The key's extension is the only thing that distinguishes an image
 * from a video, so the extension is what decides it.
 */
function resourceTypeForKey(key: string): "image" | "video" {
  const extension = key.slice(key.lastIndexOf(".") + 1).toLowerCase();

  return VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
}

/**
 * The file extensions Cloudinary treats as videos.
 */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "mov",
  "webm",
  "m4v",
  "avi",
  "mkv",
  "ogv",
]);

/**
 * Returns true when a Cloudinary error means "not found".
 *
 * The Cloudinary SDK nests the HTTP status one level down, under
 * `error.error.http_code`, and not at the top level — a shape that was
 * confirmed against the live API rather than read off the docs. Both
 * levels are checked, because a future SDK version may flatten it.
 */
function isNotFound(error: unknown): boolean {
  const candidate = error as
    | { http_code?: number; error?: { http_code?: number } }
    | undefined;

  return candidate?.http_code === 404 || candidate?.error?.http_code === 404;
}

/**
 * Converts a storage key into the Cloudinary public id it is uploaded under.
 *
 * Two Cloudinary behaviours shape this, and both were established
 * against the live API rather than assumed:
 *
 *   1. **The `folder` option is a prefix Cloudinary prepends**, and the
 *      resulting public id *includes* it. Passing
 *      `folder: "euro-glam-bd"` and a public id that already starts
 *      with `euro-glam-bd/` stores the object at
 *      `euro-glam-bd/euro-glam-bd/…` and every later lookup misses.
 *
 *   2. **Cloudinary appends the format to the public id.** A public id
 *      that already ends in `.png` is stored as `….png.png`. So the
 *      public id is the key **without** its extension, and Cloudinary
 *      puts the extension back.
 *
 * So the public id is the key without its extension, and the folder
 * is left to the `folder` option. The stored public id comes back as
 * `<folder>/<key>` — the folder plus the key, extension and all — which
 * is what the database persists and what every later lookup addresses.
 */
function keyToPublicId(key: string): string {
  return stripExtension(key);
}

/**
 * Removes the extension from a storage key.
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
 * The **qualified** public id — the key with the folder prefix, and
 * without the extension.
 *
 * This is what the read, delete and URL operations address, because
 * Cloudinary's admin API takes the full path including the folder.
 * The extension is not part of the public id: Cloudinary stores the
 * format as a separate field of the asset, so a lookup for
 * `…/<name>.png` misses an object whose public id is `…/<name>`.
 */
function qualifiedPublicId(key: string): string {
  return `${CLOUDINARY_FOLDER}/${stripExtension(key)}`;
}

/**
 * Converts the public id Cloudinary reports back into a storage key.
 *
 * The inverse of `keyToPublicId`, with one wrinkle: Cloudinary reports
 * the public id **without** the format, because the format is a
 * separate field of the asset rather than part of its id. The key's
 * extension therefore has to be put back.
 */
function publicIdToKey(publicId: string, extension: string): string {
  const prefix = `${CLOUDINARY_FOLDER}/`;
  const withoutFolder = publicId.startsWith(prefix)
    ? publicId.slice(prefix.length)
    : publicId;

  // The public id already carries an extension if Cloudinary was asked
  // for one; only append the format when it is missing.
  const lastSlash = withoutFolder.lastIndexOf("/");
  const lastDot = withoutFolder.lastIndexOf(".");

  if (lastDot > lastSlash) {
    return withoutFolder;
  }

  return `${withoutFolder}.${extension}`;
}

/**
 * The Cloudinary storage driver.
 */
export class CloudinaryStorageDriver implements StorageAdapter {
  /**
   * Uploads an object to Cloudinary and returns its storage key.
   *
   * @throws StorageError when the scope is invalid, the MIME type is
   *   unsupported, the driver is unconfigured, or the upload fails.
   */
  async put(input: PutInput): Promise<StoredObject> {
    const scope = input.scope.trim().toLowerCase();

    if (!isStorageScope(scope)) {
      throw new StorageError(
        "INVALID_SCOPE",
        `"${input.scope}" is not a valid storage scope.`,
      );
    }

    const { key, extension } = buildKey(scope, input.mimeType, new Date());

    const config = readConfig();
    applyConfig(config);

    // The public id carries the folder and omits the extension —
    // Cloudinary prepends the folder and appends the format itself.
    const publicId = keyToPublicId(key);
    const resourceType = resourceTypeFor(input.mimeType);

    let uploaded: CloudinaryUploadResult;

    try {
      uploaded = await new Promise<CloudinaryUploadResult>(
        (resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: CLOUDINARY_FOLDER,
              public_id: publicId,
              resource_type: resourceType,
              overwrite: false,
            },
            (error: unknown, result: unknown) => {
              if (error) {
                reject(error);
                return;
              }

              if (!result || typeof result !== "object") {
                reject(new Error("Cloudinary returned no upload result."));
                return;
              }

              resolve(result as CloudinaryUploadResult);
            },
          );

          uploadStream.end(input.bytes);
        },
      );
    } catch (error) {
      throw new StorageError(
        "WRITE_FAILED",
        `Could not upload to Cloudinary (scope: ${scope}).`,
        error,
      );
    }

    /*
     * The key is derived from the public id Cloudinary reports, not
     * from the key we asked for. Cloudinary normalises the path it
     * stores, and this is the moment to notice if it stored the object
     * somewhere other than where a later lookup will look. Deriving the
     * key from the answer is what keeps the two in step.
     */
    const storedKey = publicIdToKey(uploaded.public_id, extension);

    if (storedKey !== key) {
      throw new StorageError(
        "WRITE_FAILED",
        `Cloudinary stored the object as "${uploaded.public_id}" rather than "${key}".`,
      );
    }

    return {
      key,
      byteSize:
        typeof uploaded.bytes === "number" && uploaded.bytes >= 0
          ? uploaded.bytes
          : input.bytes.length,
      mimeType: input.mimeType,
    };
  }

  /**
   * Deletes an object from Cloudinary.
   *
   * Idempotent: deleting a key that does not exist resolves successfully.
   * The cleanup job calls this repeatedly for keys it has already tried to
   * remove, and an already-absent object is a success, not an error.
   *
   * @throws StorageError when the key is malformed or the delete fails.
   */
  async delete(key: string): Promise<void> {
    const resolved = this.resolveKey(key);
    const publicId = qualifiedPublicId(resolved);

    const config = readConfig();
    applyConfig(config);

    try {
      await cloudinary.uploader.destroy(publicId, {
        invalidate: true,
        resource_type: resourceTypeForKey(resolved),
      });
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
   * The URL is derived from the key, never stored alongside it.
   *
   * ── Why the URL is built by hand ────────────────────────────────────────
   *
   * `cloudinary.url()` produces
   * `…/image/upload/v1/<public_id>?_a=<signature>` — a **signed** URL.
   * The signature is derived from the API secret, which cannot be
   * reproduced in the browser bundle without leaking the secret, so a
   * client-side derivation of the URL could never match it.
   *
   * That matters: `src/lib/format/image.ts` derives the storefront URL
   * from the key on the client, and the two derivations have to agree.
   * A key that produced one URL in the admin console and a different
   * URL on the storefront would be two separate cached copies of the
   * same picture, because the image optimiser caches by URL.
   *
   * The `v1/` version segment and the `?_a=` signature are both
   * optional — the asset serves without them — so the plain form is
   * used, and it is the same string the client-side derivation
   * produces.
   */
  getUrl(key: string): string {
    const resolved = this.resolveKey(key);
    const publicId = qualifiedPublicId(resolved);

    return `https://res.cloudinary.com/${readConfig().cloudName}/image/upload/${publicId}`;
  }

  /**
   * Returns true when the object exists in Cloudinary.
   *
   * @throws StorageError when the key is malformed or the lookup fails.
   */
  async exists(key: string): Promise<boolean> {
    const resolved = this.resolveKey(key);
    const publicId = qualifiedPublicId(resolved);

    const config = readConfig();
    applyConfig(config);

    try {
      const found = await cloudinary.api.resource(publicId, {
        resource_type: resourceTypeForKey(resolved),
        type: "upload",
      });

      return Boolean(found);
    } catch (error) {
      // A missing resource is a 404 from the API, not a failure. It
      // means the object is absent, which is a legitimate answer to the
      // question — not an error to propagate.
      if (isNotFound(error)) {
        return false;
      }

      throw new StorageError(
        "READ_FAILED",
        `Could not read the stored object (key: ${key}).`,
        error,
      );
    }
  }

  /**
   * Validates a storage key.
   *
   * @throws StorageError when the key is empty or malformed.
   */
  private resolveKey(key: string): string {
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new StorageError("INVALID_KEY", "The storage key is empty.");
    }

    if (key.includes("\0")) {
      throw new StorageError(
        "INVALID_KEY",
        "The storage key contains an invalid character.",
      );
    }

    // A key is `<scope>/<yyyy>/<mm>/<name>`. Four segments, each of them
    // free of a separator. Anything else is not a key this driver
    // produced, and is refused rather than passed to the API.
    const segments = key.split("/");

    if (
      segments.length !== 4 ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      )
    ) {
      throw new StorageError(
        "INVALID_KEY",
        "The storage key is not a valid Cloudinary object key.",
      );
    }

    return key;
  }
}

/**
 * The shared driver instance.
 *
 * A module-level singleton, matching the local driver's shape.
 */
let sharedDriver: CloudinaryStorageDriver | null = null;

/**
 * Returns the shared Cloudinary driver, creating it on first use.
 */
export function getCloudinaryStorageDriver(): CloudinaryStorageDriver {
  if (!sharedDriver) {
    sharedDriver = new CloudinaryStorageDriver();
  }

  return sharedDriver;
}
