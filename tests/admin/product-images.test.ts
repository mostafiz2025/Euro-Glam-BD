import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  MAX_PRODUCT_IMAGES,
  uploadProductImages,
} from "@/lib/admin/product-images";
import { LocalStorageDriver } from "@/lib/storage/local-driver";

/**
 * The product-image upload service.
 *
 * ── Why these tests exist ────────────────────────────────────────────────
 *
 * An upload endpoint is the one place in this codebase where an
 * **untrusted file** arrives. Everything else it accepts is text the
 * server can validate with a schema. A file has to be checked against
 * its own contents, because the name and the declared type are both
 * things the sender chooses.
 *
 * So the properties proved here are:
 *
 *   1. The file's **type** comes from its magic bytes, never from the
 *      filename or the declared `Content-Type`.
 *   2. A renamed non-image is refused.
 *   3. A file whose contents disagree with its declared type is
 *      refused.
 *   4. The stored filename is **generated**, so a hostile filename
 *      cannot escape the upload root.
 *   5. A batch is **all-or-nothing**: one bad file means nothing is
 *      written.
 *   6. The size cap is enforced.
 *
 * Every test runs against a temporary directory, so the suite never
 * touches the real `public/uploads`.
 */

/**
 * A valid 1×1 PNG.
 */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/**
 * A valid 1×1 JPEG.
 */
const JPEG_1X1 = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd9",
  "hex",
);

/**
 * A plain-text file — the classic "renamed to .png" payload.
 */
const TEXT_FILE = Buffer.from(
  "This is not an image, whatever the filename says.",
  "utf8",
);

/**
 * Builds a `File` from bytes.
 *
 * The `File` constructor is available in Node 20+, which is what the
 * route receives at runtime.
 */
function makeFile(
  bytes: Buffer,
  name: string,
  type: string,
): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/**
 * Lists every file written under an upload root.
 *
 * The assertion that a failed batch wrote nothing is a claim about the
 * whole tree, so it is checked against the whole tree. Guessing at one
 * key and asserting it is absent would also pass if the batch had
 * written a file under a different name.
 *
 * Returns paths relative to the root, slash-separated.
 */
async function listStoredFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const relative = prefix.length === 0
        ? entry.name
        : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
      } else {
        found.push(relative);
      }
    }
  }

  try {
    await walk(root, "");
  } catch (error) {
    // A root that does not exist holds no files. That is the "nothing
    // was written" case, not a failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];

    throw error;
  }

  return found;
}

describe("uploadProductImages", () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "egb-product-images-"));
    driver = new LocalStorageDriver({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("the happy path", () => {
    it("stores an image and returns its key", async () => {
      const results = await uploadProductImages(
        [makeFile(PNG_1X1, "serum.png", "image/png")],
        driver,
      );

      expect(results).toHaveLength(1);

      const [result] = results;

      // The key is `<scope>/<yyyy>/<mm>/<32 hex chars>.<ext>`.
      expect(result.key).toMatch(
        /^products\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
      );

      expect(result.url).toBe(`/uploads/${result.key}`);
      expect(result.mimeType).toBe("image/png");
      expect(result.byteSize).toBe(PNG_1X1.length);
      expect(result.originalName).toBe("serum.png");
    });

    it("writes the bytes to disk", async () => {
      const [result] = await uploadProductImages(
        [makeFile(PNG_1X1, "serum.png", "image/png")],
        driver,
      );

      const stored = await driver.read(result.key);

      expect(stored.equals(PNG_1X1)).toBe(true);
    });

    it("stores a multi-file selection", async () => {
      const results = await uploadProductImages(
        [
          makeFile(PNG_1X1, "one.png", "image/png"),
          makeFile(JPEG_1X1, "two.jpg", "image/jpeg"),
        ],
        driver,
      );

      expect(results).toHaveLength(2);
      expect(results[0].key.endsWith(".png")).toBe(true);
      expect(results[1].key.endsWith(".jpg")).toBe(true);
    });

    it("gives every file a different key", async () => {
      const results = await uploadProductImages(
        [
          makeFile(PNG_1X1, "same.png", "image/png"),
          makeFile(PNG_1X1, "same.png", "image/png"),
        ],
        driver,
      );

      expect(results[0].key).not.toBe(results[1].key);
    });
  });

  describe("the type comes from the bytes, not the name", () => {
    it("rejects a text file renamed to .png", async () => {
      await expect(
        uploadProductImages(
          [makeFile(TEXT_FILE, "payload.png", "image/png")],
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("rejects a file whose contents disagree with its declared type", async () => {
      // The bytes really are a PNG, but the client declared them as a
      // JPEG. The mismatch is either a bug or an attempt to slip
      // something past the check, and it is refused either way.
      await expect(
        uploadProductImages(
          [makeFile(PNG_1X1, "serum.jpg", "image/jpeg")],
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("derives the extension from the detected type, not the filename", async () => {
      // The client called it `.png` and declared `image/png`, and the
      // bytes really are a PNG — so it gets `.png` on disk. But the
      // extension comes from the **detected** type, never the name.
      const [result] = await uploadProductImages(
        [makeFile(PNG_1X1, "whatever.exe", "image/png")],
        driver,
      );

      expect(result.key.endsWith(".png")).toBe(true);
      expect(result.key).not.toContain("whatever");
    });

    it("rejects an unsupported image type", async () => {
      // A GIF is a real image, but it is not one this platform accepts.
      const gif = Buffer.from("GIF89a", "ascii");

      await expect(
        uploadProductImages(
          [makeFile(gif, "animation.gif", "image/gif")],
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("the stored name is generated, never user-derived", () => {
    it("does not use a hostile filename in the key", async () => {
      const [result] = await uploadProductImages(
        [makeFile(PNG_1X1, "../../etc/passwd.png", "image/png")],
        driver,
      );

      expect(result.key).not.toContain("passwd");
      expect(result.key).not.toContain("..");
      expect(result.key).not.toContain("etc");
    });

    it("handles spaces and special characters in the filename", async () => {
      // The admin's file is called "my product (final) v2 & more!.png".
      // The stored name must not carry any of that.
      const [result] = await uploadProductImages(
        [makeFile(PNG_1X1, "my product (final) v2 & more!.png", "image/png")],
        driver,
      );

      expect(result.key).toMatch(
        /^products\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
      );

      // The original name is kept for diagnostics only.
      expect(result.originalName).toBe("my product (final) v2 & more!.png");
    });

    it("writes the file inside the upload root", async () => {
      const [result] = await uploadProductImages(
        [makeFile(PNG_1X1, "serum.png", "image/png")],
        driver,
      );

      await expect(driver.exists(result.key)).resolves.toBe(true);

      // The file landed under the `products` scope, and nothing else
      // was written.
      const files = await listStoredFiles(root);

      expect(files).toEqual([result.key]);
    });
  });

  describe("a batch is all-or-nothing", () => {
    it("writes nothing when one file in the batch is invalid", async () => {
      await expect(
        uploadProductImages(
          [
            makeFile(PNG_1X1, "good.png", "image/png"),
            makeFile(TEXT_FILE, "payload.png", "image/png"),
            makeFile(PNG_1X1, "also-good.png", "image/png"),
          ],
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);

      // Nothing was written. The validation of the whole batch happens
      // before the first write, so there is no partial batch to clean
      // up — and no orphaned file holding a renamed payload.
      //
      // The directory is inspected rather than a key guessed at, because
      // "that particular key does not exist" would also pass if the
      // batch had written a file under a *different* key. This asserts
      // the stronger property: the tree is empty.
      expect(await listStoredFiles(root)).toEqual([]);
    });

    it("rejects an empty batch", async () => {
      await expect(uploadProductImages([], driver)).rejects.toBeInstanceOf(
        ApiError,
      );
    });

    it("rejects a batch larger than the image cap", async () => {
      const files = Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, (_, i) =>
        makeFile(PNG_1X1, `image-${i}.png`, "image/png"),
      );

      await expect(uploadProductImages(files, driver)).rejects.toBeInstanceOf(
        ApiError,
      );
    });

    it("accepts a batch exactly at the cap", async () => {
      const files = Array.from({ length: MAX_PRODUCT_IMAGES }, (_, i) =>
        makeFile(PNG_1X1, `image-${i}.png`, "image/png"),
      );

      const results = await uploadProductImages(files, driver);

      expect(results).toHaveLength(MAX_PRODUCT_IMAGES);
    });
  });

  describe("the size cap", () => {
    it("rejects a file over the cap", async () => {
      // The default cap is 5 MB. The image is valid PNG, but it is
      // padded past the cap — and the size check runs before the
      // dimension check, so the padded bytes are rejected on size.
      const oversized = Buffer.concat([
        PNG_1X1,
        Buffer.alloc(6 * 1024 * 1024, 0x41),
      ]);

      await expect(
        uploadProductImages(
          [makeFile(oversized, "huge.png", "image/png")],
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("rejects an empty file", async () => {
      await expect(
        uploadProductImages(
          [makeFile(Buffer.alloc(0), "empty.png", "image/png")],
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("the error codes", () => {
    it("reports an unsupported type as 415", async () => {
      try {
        await uploadProductImages(
          [makeFile(TEXT_FILE, "payload.png", "image/png")],
          driver,
        );

        expect.unreachable("the upload should have been refused");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(415);
        expect((error as ApiError).code).toBe("UNSUPPORTED_MEDIA_TYPE");
      }
    });

    it("reports an empty batch as 400", async () => {
      try {
        await uploadProductImages([], driver);

        expect.unreachable("the upload should have been refused");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(400);
        expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      }
    });
  });
});
