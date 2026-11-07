import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StorageError } from "@/lib/storage/adapter";
import {
  CloudinaryStorageDriver,
  getCloudinaryStorageDriver,
} from "@/lib/storage/cloudinary";

/**
 * The Cloudinary storage driver.
 *
 * These tests never touch the network. The Cloudinary SDK is mocked at
 * the module boundary, so what is under test is the driver's own
 * behaviour — the decisions it makes about the key, the scope, the
 * configuration and the error it throws.
 *
 * The properties that matter:
 *
 *   1. **A key is persisted, not a URL.** This is the adapter's
 *      documented invariant, and it is the whole reason the driver can
 *      be swapped without rewriting a single database row. The key has
 *      the same shape as the local driver's.
 *   2. The scope is an allow-list. Free text is refused.
 *   3. The extension comes from the detected MIME type, never from the
 *      client's filename.
 *   4. `delete()` is idempotent, because the cleanup job calls it twice.
 *   5. `exists()` tells the truth — it returns false for an object that
 *      is not there, rather than always claiming success.
 *   6. A missing credential is a hard failure, not a silent fall back.
 *   7. A malformed key is refused before it reaches the API.
 */

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

const CLOUD_NAME = "test-cloud";

/**
 * The mocked Cloudinary SDK.
 *
 * `vi.mock` is hoisted above every top-level declaration, so the mock
 * objects have to be hoisted with it — otherwise the factory would run
 * before they exist.
 */
const { uploader, api, url } = vi.hoisted(() => ({
  uploader: {
    upload_stream: vi.fn(),
    destroy: vi.fn(),
  },
  api: {
    resource: vi.fn(),
  },
  url: vi.fn(),
}));

vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader,
    api,
    url,
  },
}));

/**
 * Builds a `upload_stream` mock that calls back with a success result.
 *
 * The public id Cloudinary reports **excludes** the format — the
 * format is a separate field of the asset — and includes the folder it
 * prepended. The mock reproduces that shape exactly, because the driver
 * derives the storage key from what it is told.
 *
 * `publicId` is an override for the one test that needs Cloudinary to
 * report somewhere other than where the driver asked it to. Left
 * unset, the mock echoes the request.
 */
function mockUploadSuccess(publicId?: string): void {
  uploader.upload_stream.mockImplementation(
    (
      options: { folder?: string; public_id?: string },
      callback: (error: unknown, result: unknown) => void,
    ) => {
      const stream = {
        end: () => {
          const reported =
            publicId ??
            `${options.folder ?? ""}/${options.public_id ?? ""}`;

          callback(null, {
            public_id: reported,
            secure_url: `https://res.cloudinary.com/${CLOUD_NAME}/${reported}`,
            bytes: PNG_1X1.length,
            resource_type: "image",
            format: "png",
          });
        },
      };

      return stream;
    },
  );
}

/**
 * Builds a `upload_stream` mock that calls back with a failure.
 */
function mockUploadFailure(): void {
  uploader.upload_stream.mockImplementation(
    (
      _options: unknown,
      callback: (error: unknown, result: unknown) => void,
    ) => {
      const stream = {
        end: () => {
          callback(new Error("Cloudinary rejected the upload."), undefined);
        },
      };

      return stream;
    },
  );
}

describe("CloudinaryStorageDriver", () => {
  let driver: CloudinaryStorageDriver;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.CLOUDINARY_CLOUD_NAME = CLOUD_NAME;
    process.env.CLOUDINARY_API_KEY = "test-key";
    process.env.CLOUDINARY_API_SECRET = "test-secret";

    driver = new CloudinaryStorageDriver();

    mockUploadSuccess();
    url.mockImplementation(
      (publicId: string) =>
        `https://res.cloudinary.com/${CLOUD_NAME}/${publicId}`,
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("put", () => {
    it("returns a key, not a URL", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "holiday.png",
        scope: "advisor",
      });

      // The single most important property. A URL here would bake the
      // driver into every database row and make a future migration a
      // data rewrite rather than a config change.
      expect(stored.key).not.toContain("https://");
      expect(stored.key).not.toContain("res.cloudinary.com");
    });

    it("returns a key with the same shape as the local driver's", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "holiday.png",
        scope: "advisor",
      });

      expect(stored.key).toMatch(
        /^advisor\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
      );
    });

    it("reports the byte size and the MIME type", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "holiday.png",
        scope: "advisor",
      });

      expect(stored.byteSize).toBe(PNG_1X1.length);
      expect(stored.mimeType).toBe("image/png");
    });

    it("does not use the original filename in the key", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "../../etc/passwd.png",
        scope: "advisor",
      });

      expect(stored.key).not.toContain("passwd");
      expect(stored.key).not.toContain("..");
      expect(stored.key).not.toContain("etc");
    });

    it("derives the extension from the detected MIME type, not the filename", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "photo.jpg",
        scope: "advisor",
      });

      expect(stored.key.endsWith(".png")).toBe(true);
    });

    it("uploads under the euro-glam-bd folder", async () => {
      await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      const options = uploader.upload_stream.mock.calls[0][0] as {
        folder: string;
        public_id: string;
      };

      expect(options.folder).toBe("euro-glam-bd");
    });

    it("uploads with the public id stripped of its extension", async () => {
      /*
       * Cloudinary appends the format to the public id itself, so a
       * public id that already ends in `.png` would be stored as
       * `….png.png`. The extension has to come off before the upload
       * and back on afterwards.
       */
      await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      const options = uploader.upload_stream.mock.calls[0][0] as {
        public_id: string;
      };

      expect(options.public_id).toMatch(
        /^advisor\/\d{4}\/\d{2}\/[0-9a-f]{32}$/,
      );
      expect(options.public_id).not.toContain(".png");
    });

    it("uploads with a public id that does not repeat the folder", async () => {
      /*
       * The `folder` option is a prefix Cloudinary prepends, and the
       * resulting public id includes it. Putting the folder in the
       * public id as well would store the object at
       * `euro-glam-bd/euro-glam-bd/…`, where no later lookup would
       * find it.
       */
      await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      const options = uploader.upload_stream.mock.calls[0][0] as {
        public_id: string;
      };

      expect(options.public_id).not.toContain("euro-glam-bd");
    });

    it("refuses to store an object Cloudinary filed somewhere else", async () => {
      // The key is derived from the public id Cloudinary reports, and
      // the two are compared. A mismatch means a later lookup would
      // miss the object, so it is a failure rather than a silent
      // misfiling.
      mockUploadSuccess("euro-glam-bd/somewhere/else/entirely.png");

      await expect(
        driver.put({
          bytes: PNG_1X1,
          mimeType: "image/png",
          originalName: "a.png",
          scope: "advisor",
        }),
      ).rejects.toThrow(StorageError);
    });

    it("rejects a scope that is not in the allow-list", async () => {
      await expect(
        driver.put({
          bytes: PNG_1X1,
          mimeType: "image/png",
          originalName: "a.png",
          scope: "../../etc",
        }),
      ).rejects.toThrow(StorageError);
    });

    it("rejects a MIME type with no known extension", async () => {
      await expect(
        driver.put({
          bytes: PNG_1X1,
          mimeType: "application/x-msdownload",
          originalName: "a.exe",
          scope: "advisor",
        }),
      ).rejects.toThrow(StorageError);
    });

    it("turns an upload failure into a StorageError", async () => {
      mockUploadFailure();

      await expect(
        driver.put({
          bytes: PNG_1X1,
          mimeType: "image/png",
          originalName: "a.png",
          scope: "advisor",
        }),
      ).rejects.toThrow(StorageError);
    });

    it("refuses to upload when the driver is not configured", async () => {
      // A missing credential is a hard failure, not a silent fall back
      // to the local driver. A deployment that believes it is writing
      // to Cloudinary while writing to the filesystem is a failure
      // that stays hidden until the files go missing.
      delete process.env.CLOUDINARY_API_SECRET;

      await expect(
        driver.put({
          bytes: PNG_1X1,
          mimeType: "image/png",
          originalName: "a.png",
          scope: "advisor",
        }),
      ).rejects.toThrow(StorageError);

      // And nothing was uploaded.
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    });
  });

  describe("getUrl", () => {
    it("derives a Cloudinary URL from the key", () => {
      const result = driver.getUrl("advisor/2026/10/abc.png");

      expect(result).toContain("res.cloudinary.com");
      expect(result).toContain("euro-glam-bd/advisor/2026/10/abc");
    });

    it("never returns the key itself", () => {
      // The local driver returns `/uploads/<key>`; the Cloudinary driver
      // returns an absolute CDN URL. Neither returns the bare key,
      // because the key is not a URL.
      const result = driver.getUrl("advisor/2026/10/abc.png");

      expect(result).not.toBe("advisor/2026/10/abc.png");
    });

    it("produces the plain unsigned URL the client can also derive", () => {
      /*
       * The storefront derives its URL from the key on the client, in
       * `src/lib/format/image.ts`. The client cannot reproduce the
       * SDK's `?_a=` signature without the API secret, so the driver
       * must not emit one — otherwise the same picture would be two
       * separate cached copies under the two URL forms.
       */
      const result = driver.getUrl("advisor/2026/10/abc.png");

      expect(result).toBe(
        "https://res.cloudinary.com/test-cloud/image/upload/euro-glam-bd/advisor/2026/10/abc",
      );
      expect(result).not.toContain("?_a=");
    });

    it("does not use the SDK's URL builder", () => {
      // The SDK's builder produces the signed, versioned form. The
      // driver builds its own.
      driver.getUrl("advisor/2026/10/abc.png");

      expect(url).not.toHaveBeenCalled();
    });
  });

  describe("exists", () => {
    it("looks the object up without its extension", async () => {
      api.resource.mockResolvedValue({ public_id: "euro-glam-bd/advisor/x" });

      await driver.exists("advisor/2026/10/abc.png");

      expect(api.resource).toHaveBeenCalledWith(
        "euro-glam-bd/advisor/2026/10/abc",
        expect.objectContaining({ resource_type: "image" }),
      );
    });

    it("returns true for an object that is present", async () => {
      api.resource.mockResolvedValue({ public_id: "euro-glam-bd/advisor/x" });

      await expect(
        driver.exists("advisor/2026/10/abc.png"),
      ).resolves.toBe(true);
    });

    it("returns false for an object that is absent", async () => {
      // This is the property the old implementation got wrong: it
      // returned true unconditionally, so it always lied.
      //
      // The Cloudinary SDK nests the HTTP status under `error`, so the
      // shape the driver has to recognise is the nested one.
      api.resource.mockRejectedValue({ error: { http_code: 404 } });

      await expect(
        driver.exists("advisor/2026/10/never-existed.png"),
      ).resolves.toBe(false);
    });

    it("returns false for a 404 reported at the top level", async () => {
      api.resource.mockRejectedValue({ http_code: 404 });

      await expect(
        driver.exists("advisor/2026/10/never-existed.png"),
      ).resolves.toBe(false);
    });

    it("throws when the lookup fails for any other reason", async () => {
      api.resource.mockRejectedValue({ error: { http_code: 500 } });

      await expect(
        driver.exists("advisor/2026/10/abc.png"),
      ).rejects.toThrow(StorageError);
    });
  });

  describe("delete", () => {
    it("destroys the object under the euro-glam-bd folder", async () => {
      uploader.destroy.mockResolvedValue({ result: "ok" });

      await driver.delete("advisor/2026/10/abc.png");

      // The extension is not part of the public id — Cloudinary keeps
      // the format in a separate field — so the lookup and the delete
      // address the object without it.
      expect(uploader.destroy).toHaveBeenCalledWith(
        "euro-glam-bd/advisor/2026/10/abc",
        expect.objectContaining({ invalidate: true }),
      );
    });

    it("is idempotent — deleting an absent object succeeds", async () => {
      // The cleanup job calls delete() repeatedly for keys it has
      // already tried to remove. That must not throw.
      uploader.destroy.mockResolvedValue({ result: "not found" });

      await expect(
        driver.delete("advisor/2026/10/never-existed.png"),
      ).resolves.toBeUndefined();
    });

    it("is idempotent when called twice on the same key", async () => {
      uploader.destroy.mockResolvedValue({ result: "ok" });

      await driver.delete("advisor/2026/10/abc.png");

      await expect(
        driver.delete("advisor/2026/10/abc.png"),
      ).resolves.toBeUndefined();
    });

    it("refuses a key with a traversing segment", async () => {
      await expect(driver.delete("../../etc/passwd")).rejects.toThrow(
        StorageError,
      );

      expect(uploader.destroy).not.toHaveBeenCalled();
    });
  });

  describe("key validation", () => {
    it("rejects an empty key", async () => {
      await expect(driver.exists("")).rejects.toThrow(StorageError);
    });

    it("rejects a key with a null byte", async () => {
      await expect(driver.exists("advisor/\0evil.png")).rejects.toThrow(
        StorageError,
      );
    });

    it("rejects a key that is not a four-segment object key", async () => {
      await expect(driver.exists("advisor/abc.png")).rejects.toThrow(
        StorageError,
      );
      await expect(
        driver.exists("advisor/2026/10/abc.png/extra"),
      ).rejects.toThrow(StorageError);
    });

    it("rejects a parent-directory segment", async () => {
      await expect(
        driver.exists("advisor/2026/../.."),
      ).rejects.toThrow(StorageError);
    });
  });

  describe("the shared instance", () => {
    it("returns the same driver every time", () => {
      expect(getCloudinaryStorageDriver()).toBe(
        getCloudinaryStorageDriver(),
      );
    });
  });
});
