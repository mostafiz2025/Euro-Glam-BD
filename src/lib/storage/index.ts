import { getLocalStorageDriver } from "./local-driver";
import type { StoredObject, StorageAdapter } from "./adapter";
import { v2 as cloudinary } from "cloudinary";

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

export function getStorageDriver(): StorageAdapter {
  const driverType = process.env.STORAGE_DRIVER;

  if (driverType === "cloudinary") {
    return {
      async put(input) {
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
        });

        return new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            {
              folder: input.scope,
              resource_type: "auto",
            },
            (error, result) => {
              if (error || !result) {
                return reject(error || new Error("Cloudinary upload failed"));
              }
              resolve({
                key: result.public_id,
                byteSize: result.bytes,
                mimeType: result.format ? `image/${result.format}` : input.mimeType,
                createdAt: new Date(),
                url: result.secure_url,
              } as unknown as StoredObject);
            }
          );
          uploadStream.end(input.bytes);
        });
      },
      async delete(key: string) {
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
        });
        await cloudinary.uploader.destroy(key);
      },
      async exists(key: string): Promise<boolean> {
        try {
          cloudinary.config({
            cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
            api_key: process.env.CLOUDINARY_API_KEY,
            api_secret: process.env.CLOUDINARY_API_SECRET,
          });
          const result = await cloudinary.api.resource(key);
          return !!result;
        } catch {
          return false;
        }
      },
      getUrl(key: string): string {
        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
        });
        return cloudinary.url(key, { secure: true });
      },
    };
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