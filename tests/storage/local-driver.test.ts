import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StorageError } from "@/lib/storage/adapter";
import { LocalStorageDriver } from "@/lib/storage/local-driver";

/**
 * Local storage driver tests.
 *
 * These cover the four properties that make local storage safe to use with
 * user uploads:
 *
 *   1. The stored filename is generated and random — never user-derived.
 *   2. A crafted key cannot escape the upload root.
 *   3. `delete()` is idempotent, because the cleanup job calls it twice.
 *   4. A round trip preserves the bytes exactly.
 *
 * Every test runs against a temporary directory, so the suite never touches
 * the real `public/uploads`.
 */

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

describe("LocalStorageDriver", () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "egb-storage-"));
    driver = new LocalStorageDriver({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("put", () => {
    it("stores a file and returns its key", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "holiday.png",
        scope: "advisor",
      });

      expect(stored.key).toMatch(
        /^advisor\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
      );
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

    it("generates a different key for every upload of the same bytes", async () => {
      const first = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      const second = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      expect(first.key).not.toBe(second.key);
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

    it("writes the bytes verbatim", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      const readBack = await driver.read(stored.key);

      expect(readBack.equals(PNG_1X1)).toBe(true);
    });
  });

  describe("getUrl", () => {
    it("returns the /uploads URL for a key", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      expect(driver.getUrl(stored.key)).toBe(`/uploads/${stored.key}`);
    });
  });

  describe("exists", () => {
    it("returns true for a stored object", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      await expect(driver.exists(stored.key)).resolves.toBe(true);
    });

    it("returns false for an unknown key", async () => {
      await expect(
        driver.exists("advisor/2026/10/does-not-exist.png"),
      ).resolves.toBe(false);
    });
  });

  describe("delete", () => {
    it("removes a stored object", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      await driver.delete(stored.key);

      await expect(driver.exists(stored.key)).resolves.toBe(false);
    });

    it("is idempotent — deleting an absent file succeeds", async () => {
      // The cleanup job calls delete() repeatedly for keys it has already
      // tried to remove. That must not throw.
      await expect(
        driver.delete("advisor/2026/10/never-existed.png"),
      ).resolves.toBeUndefined();
    });

    it("is idempotent when called twice on the same key", async () => {
      const stored = await driver.put({
        bytes: PNG_1X1,
        mimeType: "image/png",
        originalName: "a.png",
        scope: "advisor",
      });

      await driver.delete(stored.key);
      await expect(driver.delete(stored.key)).resolves.toBeUndefined();
    });
  });

  describe("path traversal protection", () => {
    it("rejects a key that escapes the root", async () => {
      await expect(driver.exists("../../etc/passwd")).rejects.toThrow(
        StorageError,
      );
    });

    it("rejects a key with a parent-directory segment", async () => {
      await expect(
        driver.exists("advisor/../../../../etc/passwd"),
      ).rejects.toThrow(StorageError);
    });

    it("rejects an absolute path as a key", async () => {
      await expect(driver.exists("/etc/passwd")).rejects.toThrow(StorageError);
    });

    it("rejects a key containing a null byte", async () => {
      await expect(driver.exists("advisor/\0evil.png")).rejects.toThrow(
        StorageError,
      );
    });

    it("rejects an empty key", async () => {
      await expect(driver.exists("")).rejects.toThrow(StorageError);
    });

    it("rejects a delete with a traversing key", async () => {
      await expect(driver.delete("../../etc/passwd")).rejects.toThrow(
        StorageError,
      );
    });

    it("does not read a file outside the root", async () => {
      // Write a file just outside the root, then try to reach it through
      // the driver. It must be refused, not read.
      const outside = path.join(path.dirname(root), "egb-outside-secret.txt");

      await writeFile(outside, "secret");

      try {
        const relative = path
          .relative(root, outside)
          .split(path.sep)
          .join("/");

        await expect(driver.exists(relative)).rejects.toThrow(StorageError);
      } finally {
        await rm(outside, { force: true });
      }
    });
  });

  describe("root resolution", () => {
    it("resolves the root to an absolute path", () => {
      expect(path.isAbsolute(driver.uploadRoot)).toBe(true);
    });

    it("resolves a relative root against the working directory", () => {
      const relative = new LocalStorageDriver({ root: "./some/uploads" });

      expect(path.isAbsolute(relative.uploadRoot)).toBe(true);
      expect(relative.uploadRoot.endsWith(path.join("some", "uploads"))).toBe(
        true,
      );
    });
  });
});
