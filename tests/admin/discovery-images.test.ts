import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import {
  DISCOVERY_IMAGE_SCOPES,
  MAX_DISCOVERY_IMAGES,
  MAX_PRODUCT_IMAGES,
  uploadDiscoveryImages,
} from "@/lib/admin/discovery-images";
import { LocalStorageDriver } from "@/lib/storage/local-driver";

/**
 * The discovery-image upload service.
 *
 * ── Why these tests exist ────────────────────────────────────────────────
 *
 * The three discovery sections — "Shop By Category", "Shop By Skin
 * Concern" and "Shop By Brand" — each accept one uploaded image. That is
 * the same untrusted-file surface the product upload already had, so the
 * same properties have to hold:
 *
 *   1. The file's **type** comes from its magic bytes, never from the
 *      filename or the declared `Content-Type`.
 *   2. A renamed non-image is refused.
 *   3. The stored filename is **generated**, so a hostile filename cannot
 *      escape the upload root.
 *   4. A batch is **all-or-nothing**: one bad file means nothing is
 *      written.
 *   5. The size cap is enforced.
 *
 * Plus the property that is **new** in Step 17 — the two callers have
 * different batch caps. The product path accepts twenty images; a
 * discovery entity carries one. The cap is a **parameter** of the shared
 * service precisely so that neither caller imposes its limit on the other.
 * A regression here would mean the product upload silently dropping to
 * four images, which is exactly what happened before the cap was made a
 * parameter.
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
 * whole tree, so it is checked against the whole tree.
 */
async function listStoredFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const relative =
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];

    throw error;
  }

  return found;
}

describe("uploadDiscoveryImages", () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "egb-discovery-images-"));
    driver = new LocalStorageDriver({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("the happy path", () => {
    it("stores an image and returns its key", async () => {
      const results = await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "serum.png", "image/png")],
        DISCOVERY_IMAGE_SCOPES.categories,
        driver,
      );

      expect(results).toHaveLength(1);

      const [result] = results;

      // The key is `<scope>/<yyyy>/<mm>/<32 hex chars>.<ext>`.
      expect(result.key).toMatch(
        /^categories\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
      );

      expect(result.url).toBe(`/uploads/${result.key}`);
      expect(result.mimeType).toBe("image/png");
      expect(result.byteSize).toBe(PNG_1X1.length);
      expect(result.originalName).toBe("serum.png");
    });

    it("writes the bytes to disk", async () => {
      const [result] = await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "serum.png", "image/png")],
        DISCOVERY_IMAGE_SCOPES.categories,
        driver,
      );

      const stored = await driver.read(result.key);

      expect(stored.equals(PNG_1X1)).toBe(true);
    });

    it("writes each scope to its own directory", async () => {
      // The three scopes are separate directories because the three are
      // managed independently — one scope's cleanup must not sweep
      // another's files.
      await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "a.png", "image/png")],
        DISCOVERY_IMAGE_SCOPES.categories,
        driver,
      );
      await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "b.png", "image/png")],
        DISCOVERY_IMAGE_SCOPES.concerns,
        driver,
      );
      await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "c.png", "image/png")],
        DISCOVERY_IMAGE_SCOPES.brands,
        driver,
      );

      const files = await listStoredFiles(root);

      expect(files.some((file) => file.startsWith("categories/"))).toBe(true);
      expect(files.some((file) => file.startsWith("concerns/"))).toBe(true);
      expect(files.some((file) => file.startsWith("brands/"))).toBe(true);
    });

    it("gives every file a different key", async () => {
      const results = await uploadDiscoveryImages(
        [
          makeFile(PNG_1X1, "same.png", "image/png"),
          makeFile(PNG_1X1, "same.png", "image/png"),
        ],
        DISCOVERY_IMAGE_SCOPES.brands,
        driver,
      );

      expect(results[0].key).not.toBe(results[1].key);
    });

    it("stores a multi-file selection", async () => {
      // The endpoint accepts a batch so a drag-and-drop of several files
      // reports all of them at once rather than failing on the second.
      const results = await uploadDiscoveryImages(
        [
          makeFile(PNG_1X1, "one.png", "image/png"),
          makeFile(JPEG_1X1, "two.jpg", "image/jpeg"),
        ],
        DISCOVERY_IMAGE_SCOPES.concerns,
        driver,
      );

      expect(results).toHaveLength(2);
      expect(results[0].key.endsWith(".png")).toBe(true);
      expect(results[1].key.endsWith(".jpg")).toBe(true);
      expect(results[1].mimeType).toBe("image/jpeg");
    });
  });

  describe("the type comes from the bytes, not the name", () => {
    it("rejects a text file renamed to .png", async () => {
      await expect(
        uploadDiscoveryImages(
          [makeFile(TEXT_FILE, "payload.png", "image/png")],
          DISCOVERY_IMAGE_SCOPES.categories,
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("rejects a file whose contents disagree with its declared type", async () => {
      await expect(
        uploadDiscoveryImages(
          [makeFile(PNG_1X1, "serum.jpg", "image/jpeg")],
          DISCOVERY_IMAGE_SCOPES.concerns,
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("derives the extension from the detected type, not the filename", async () => {
      const [result] = await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "whatever.exe", "image/png")],
        DISCOVERY_IMAGE_SCOPES.brands,
        driver,
      );

      expect(result.key.endsWith(".png")).toBe(true);
      expect(result.key).not.toContain("whatever");
    });

    it("rejects an unsupported image type", async () => {
      const gif = Buffer.from("GIF89a", "ascii");

      await expect(
        uploadDiscoveryImages(
          [makeFile(gif, "animation.gif", "image/gif")],
          DISCOVERY_IMAGE_SCOPES.brands,
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("the stored name is generated, never user-derived", () => {
    it("does not use a hostile filename in the key", async () => {
      const [result] = await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "../../etc/passwd.png", "image/png")],
        DISCOVERY_IMAGE_SCOPES.categories,
        driver,
      );

      expect(result.key).not.toContain("passwd");
      expect(result.key).not.toContain("..");
      expect(result.key).not.toContain("etc");
    });

    it("handles spaces and special characters in the filename", async () => {
      const [result] = await uploadDiscoveryImages(
        [makeFile(PNG_1X1, "my logo (final) v2 & more!.png", "image/png")],
        DISCOVERY_IMAGE_SCOPES.brands,
        driver,
      );

      expect(result.key).toMatch(
        /^brands\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
      );

      // The original name is kept for diagnostics only.
      expect(result.originalName).toBe("my logo (final) v2 & more!.png");
    });
  });

  describe("a batch is all-or-nothing", () => {
    it("writes nothing when one file in the batch is invalid", async () => {
      await expect(
        uploadDiscoveryImages(
          [
            makeFile(PNG_1X1, "good.png", "image/png"),
            makeFile(TEXT_FILE, "payload.png", "image/png"),
            makeFile(PNG_1X1, "also-good.png", "image/png"),
          ],
          DISCOVERY_IMAGE_SCOPES.categories,
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);

      // The directory is inspected rather than a key guessed at, because
      // "that particular key does not exist" would also pass if the batch
      // had written a file under a *different* key. This asserts the
      // stronger property: the tree is empty.
      expect(await listStoredFiles(root)).toEqual([]);
    });

    it("rejects an empty batch", async () => {
      await expect(
        uploadDiscoveryImages([], DISCOVERY_IMAGE_SCOPES.categories, driver),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("the batch cap is a parameter, not a constant", () => {
    it("uses the discovery cap by default", async () => {
      const files = Array.from(
        { length: MAX_DISCOVERY_IMAGES + 1 },
        (_, i) => makeFile(PNG_1X1, `image-${i}.png`, "image/png"),
      );

      await expect(
        uploadDiscoveryImages(files, DISCOVERY_IMAGE_SCOPES.categories, driver),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("accepts a batch exactly at the discovery cap", async () => {
      const files = Array.from(
        { length: MAX_DISCOVERY_IMAGES },
        (_, i) => makeFile(PNG_1X1, `image-${i}.png`, "image/png"),
      );

      const results = await uploadDiscoveryImages(
        files,
        DISCOVERY_IMAGE_SCOPES.categories,
        driver,
      );

      expect(results).toHaveLength(MAX_DISCOVERY_IMAGES);
    });

    it("accepts a larger batch when the caller raises the cap", async () => {
      // This is the property the product path depends on. Before the cap
      // became a parameter, the discovery cap of four was imposing itself
      // on the product upload, which accepts twenty.
      const files = Array.from(
        { length: MAX_DISCOVERY_IMAGES + 1 },
        (_, i) => makeFile(PNG_1X1, `image-${i}.png`, "image/png"),
      );

      const results = await uploadDiscoveryImages(
        files,
        "products",
        driver,
        MAX_PRODUCT_IMAGES,
      );

      expect(results).toHaveLength(MAX_DISCOVERY_IMAGES + 1);
    });

    it("still enforces the caller's cap when one is given", async () => {
      const files = Array.from(
        { length: MAX_PRODUCT_IMAGES + 1 },
        (_, i) => makeFile(PNG_1X1, `image-${i}.png`, "image/png"),
      );

      await expect(
        uploadDiscoveryImages(files, "products", driver, MAX_PRODUCT_IMAGES),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("keeps the two caps distinct", async () => {
      // The whole point of the parameter: one implementation, two
      // independent limits.
      expect(MAX_DISCOVERY_IMAGES).toBeLessThan(MAX_PRODUCT_IMAGES);
    });
  });

  describe("the size cap", () => {
    it("rejects a file over the cap", async () => {
      const oversized = Buffer.concat([
        PNG_1X1,
        Buffer.alloc(6 * 1024 * 1024, 0x41),
      ]);

      await expect(
        uploadDiscoveryImages(
          [makeFile(oversized, "huge.png", "image/png")],
          DISCOVERY_IMAGE_SCOPES.categories,
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("rejects an empty file", async () => {
      await expect(
        uploadDiscoveryImages(
          [makeFile(Buffer.alloc(0), "empty.png", "image/png")],
          DISCOVERY_IMAGE_SCOPES.categories,
          driver,
        ),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  describe("the error codes", () => {
    it("reports an unsupported type as 415", async () => {
      try {
        await uploadDiscoveryImages(
          [makeFile(TEXT_FILE, "payload.png", "image/png")],
          DISCOVERY_IMAGE_SCOPES.categories,
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
        await uploadDiscoveryImages(
          [],
          DISCOVERY_IMAGE_SCOPES.categories,
          driver,
        );

        expect.unreachable("the upload should have been refused");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(400);
        expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      }
    });

    it("reports an over-sized batch as 400", async () => {
      const files = Array.from(
        { length: MAX_DISCOVERY_IMAGES + 1 },
        (_, i) => makeFile(PNG_1X1, `image-${i}.png`, "image/png"),
      );

      try {
        await uploadDiscoveryImages(
          files,
          DISCOVERY_IMAGE_SCOPES.categories,
          driver,
        );

        expect.unreachable("the upload should have been refused");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(400);
        expect((error as ApiError).code).toBe("VALIDATION_ERROR");
      }
    });
  });
});
