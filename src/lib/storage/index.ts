import { getCloudinaryStorageDriver } from "./cloudinary";
import { getLocalStorageDriver } from "./local-driver";
import type { StoredObject } from "./adapter";

/**
 * The storage service.
 *
 * This is the module the rest of the application imports. It composes the
 * two halves that must always work together:
 *
 *   • the **adapter** — where the bytes go, and under what key.
 *   • the **validation** — whether the bytes are allowed at all.
 *
 * The adapter on its own does not validate: it trusts the caller. The
 * `upload*` functions here are the only supported way to write an object,
 * and they always validate first.
 *
 * ── Choosing a driver ────────────────────────────────────────────────────
 *
 * `STORAGE_DRIVER` selects the driver for the whole application:
 *
 *   • `"local"`      — the filesystem, under `UPLOAD_ROOT`. The default.
 *   • `"cloudinary"` — Cloudinary, for a serverless deployment where the
 *                     filesystem is ephemeral and files must outlive it.
 *
 * Every function here defaults to `getStorageDriver()`, so a call site
 * never names a driver. The environment decides, and the switch is one
 * configuration change rather than a code change.
 *
 * The driver is imported **statically** rather than dynamically. A
 * dynamic `import()` would split the module graph at runtime, and Next.js
 * would have no way to know the Cloudinary SDK was reachable from the
 * server bundle — the failure would surface as a missing import at
 * request time rather than at build time. Static imports keep the build
 * honest.
 */

export {
  STORAGE_SCOPES,
  StorageError,
  isStorageScope,
  type PutInput,
  type StorageAdapter,
  type StorageScope,
  type StoredObject,
} from "./adapter";

export {
  DEFAULT_UPLOAD_ROOT,
  LOCAL_URL_PREFIX,
  LocalStorageDriver,
  getLocalStorageDriver,
  type LocalDriverOptions,
} from "./local-driver";

export {
  CloudinaryStorageDriver,
  getCloudinaryStorageDriver,
} from "./cloudinary";

export {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
  MAX_IMAGE_DIMENSION,
  UploadValidationError,
  assertValidImage,
  assertValidVideo,
  detectMimeType,
  getMaxBytes,
  readImageDimensions,
  type AllowedImageMimeType,
  type AllowedVideoMimeType,
  type ValidatedUpload,
} from "@/lib/upload/validate";

import { assertValidImage, assertValidVideo } from "@/lib/upload/validate";

import { StorageError } from "./adapter";
import type { StorageAdapter as Adapter } from "./adapter";

/**
 * The storage drivers the application knows about.
 */
export const STORAGE_DRIVERS = ["local", "cloudinary"] as const;

export type StorageDriverName = (typeof STORAGE_DRIVERS)[number];

/**
 * The driver used when `STORAGE_DRIVER` is unset or unrecognised.
 *
 * The local filesystem, because it needs no credentials and no network.
 */
const DEFAULT_DRIVER: StorageDriverName = "local";

/**
 * The shared driver instance for the configured driver.
 */
let sharedDriver: Adapter | null = null;

/**
 * Reads the configured driver name from the environment.
 */
export function getStorageDriverName(): StorageDriverName {
  const configured = process.env.STORAGE_DRIVER?.trim().toLowerCase();

  if (!configured) {
    return DEFAULT_DRIVER;
  }

  if ((STORAGE_DRIVERS as readonly string[]).includes(configured)) {
    return configured as StorageDriverName;
  }

  // An unrecognised driver name is a configuration mistake, and it is
  // reported rather than quietly treated as "local" — a deployment that
  // believes it is writing to Cloudinary while writing to the filesystem
  // is a failure that stays hidden until the files go missing.
  throw new StorageError(
    "WRITE_FAILED",
    `"${configured}" is not a known storage driver. Use one of: ${STORAGE_DRIVERS.join(", ")}.`,
  );
}

/**
 * Returns the configured storage driver, creating it on first use.
 *
 * The driver is chosen by `STORAGE_DRIVER` and is the default for every
 * storage function in this module.
 */
export function getStorageDriver(): Adapter {
  if (!sharedDriver) {
    sharedDriver =
      getStorageDriverName() === "cloudinary"
        ? getCloudinaryStorageDriver()
        : getLocalStorageDriver();
  }

  return sharedDriver;
}

/**
 * The input to an upload.
 */
export type UploadRequest = {
  readonly bytes: Buffer;
  /** The client-declared MIME type. Cross-checked against the bytes. */
  readonly declaredMime: string | null | undefined;
  /** The original filename. Used only for diagnostics. */
  readonly originalName: string;
  /** The storage scope, e.g. `advisor`. */
  readonly scope: string;
};

/**
 * The result of a successful upload.
 */
export type UploadResult = StoredObject & {
  /** The public URL for the stored object. */
  readonly url: string;
};

/**
 * Uploads an image.
 *
 * Validates the bytes first — magic-byte detection, size cap, dimension
 * cap, and a cross-check against the declared type — and only then writes.
 *
 * @param adapter - The storage adapter. Defaults to the driver named by
 *   `STORAGE_DRIVER`.
 *
 * @throws UploadValidationError when validation fails.
 * @throws StorageError when the write fails.
 */
export async function uploadImage(
  request: UploadRequest,
  adapter: Adapter = getStorageDriver(),
): Promise<UploadResult> {
  const validated = assertValidImage(
    request.bytes,
    request.declaredMime,
  );

  const stored = await adapter.put({
    bytes: request.bytes,
    mimeType: validated.mimeType,
    originalName: request.originalName,
    scope: request.scope,
  });

  return {
    ...stored,
    url: adapter.getUrl(stored.key),
  };
}

/**
 * Uploads a video.
 *
 * @throws UploadValidationError when validation fails.
 * @throws StorageError when the write fails.
 */
export async function uploadVideo(
  request: UploadRequest,
  adapter: Adapter = getStorageDriver(),
): Promise<UploadResult> {
  const validated = assertValidVideo(
    request.bytes,
    request.declaredMime,
  );

  const stored = await adapter.put({
    bytes: request.bytes,
    mimeType: validated.mimeType,
    originalName: request.originalName,
    scope: request.scope,
  });

  return {
    ...stored,
    url: adapter.getUrl(stored.key),
  };
}

/**
 * Returns the public URL for a stored key.
 */
export function getStorageUrl(
  key: string,
  adapter: Adapter = getStorageDriver(),
): string {
  return adapter.getUrl(key);
}

/**
 * Deletes a stored object. Idempotent.
 */
export async function deleteStoredObject(
  key: string,
  adapter: Adapter = getStorageDriver(),
): Promise<void> {
  await adapter.delete(key);
}

/**
 * Returns true when a stored object exists.
 */
export async function storedObjectExists(
  key: string,
  adapter: Adapter = getStorageDriver(),
): Promise<boolean> {
  return adapter.exists(key);
}
