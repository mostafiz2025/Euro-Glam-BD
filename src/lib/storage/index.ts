import { getCloudinaryStorageDriver } from "./cloudinary-driver";
import { getLocalStorageDriver } from "./local-driver";
import type { StoredObject, StorageAdapter } from "./adapter";

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
} from "./cloudinary-driver";

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

/**
 * Returns the storage driver the deployment is configured to use.
 *
 * ── Why the selection is dynamic ────────────────────────────────────────
 *
 * The driver is chosen from `STORAGE_DRIVER` **at call time**, not at
 * module load. Two reasons:
 *
 *   1. The environment is not guaranteed to be populated when the module
 *      is first imported, so a module-level decision would capture
 *      `undefined`.
 *   2. The choice is a deployment concern, not a code concern — the same
 *      build runs on the local filesystem in development and on Cloudinary
 *      in production.
 *
 * So every call re-reads the environment and returns the matching driver.
 * Both drivers are singletons, so the repeated call is cheap.
 *
 * **The Cloudinary driver is the production one.** The local filesystem
 * is ephemeral on Vercel: a file written there is gone after the next
 * deployment, and it is not shared between the server instances. So a
 * shop that uploads an image to the local driver in production loses it
 * on the next deploy.
 */
export function getStorageDriver(): StorageAdapter {
  const driverType = process.env.STORAGE_DRIVER;

  if (driverType === "cloudinary") {
    return getCloudinaryStorageDriver();
  }

  return getLocalStorageDriver();
}

export type UploadRequest = {
  readonly bytes: Buffer;
  readonly declaredMime: string | null | undefined;
  readonly originalName: string;
  readonly scope: string;
};

export type UploadResult = StoredObject & {
  readonly url: string;
};

export async function uploadImage(
  request: UploadRequest,
  adapter: StorageAdapter = getStorageDriver(),
): Promise<UploadResult> {
  const validated = assertValidImage(request.bytes, request.declaredMime);
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

export async function uploadVideo(
  request: UploadRequest,
  adapter: StorageAdapter = getStorageDriver(),
): Promise<UploadResult> {
  const validated = assertValidVideo(request.bytes, request.declaredMime);
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

export function getStorageUrl(
  key: string,
  adapter: StorageAdapter = getStorageDriver(),
): string {
  return adapter.getUrl(key);
}

export async function deleteStoredObject(
  key: string,
  adapter: StorageAdapter = getStorageDriver(),
): Promise<void> {
  await adapter.delete(key);
}

export async function storedObjectExists(
  key: string,
  adapter: StorageAdapter = getStorageDriver(),
): Promise<boolean> {
  return adapter.exists(key);
}