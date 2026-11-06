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

import type { StorageAdapter as Adapter } from "./adapter";

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
 * @param adapter - The storage adapter. Defaults to the local driver.
 *
 * @throws UploadValidationError when validation fails.
 * @throws StorageError when the write fails.
 */
export async function uploadImage(
  request: UploadRequest,
  adapter: Adapter = getLocalStorageDriver(),
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
  adapter: Adapter = getLocalStorageDriver(),
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
  adapter: Adapter = getLocalStorageDriver(),
): string {
  return adapter.getUrl(key);
}

/**
 * Deletes a stored object. Idempotent.
 */
export async function deleteStoredObject(
  key: string,
  adapter: Adapter = getLocalStorageDriver(),
): Promise<void> {
  await adapter.delete(key);
}

/**
 * Returns true when a stored object exists.
 */
export async function storedObjectExists(
  key: string,
  adapter: Adapter = getLocalStorageDriver(),
): Promise<boolean> {
  return adapter.exists(key);
}
