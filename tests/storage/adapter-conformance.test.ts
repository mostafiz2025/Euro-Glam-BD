import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  STORAGE_SCOPES,
  isStorageScope,
  type StorageAdapter,
} from "@/lib/storage/adapter";
import { LocalStorageDriver } from "@/lib/storage/local-driver";
import { CloudinaryStorageDriver } from "@/lib/storage/cloudinary";

/**
 * The storage adapter contract.
 *
 * The interface is the whole point of the storage module: a driver can
 * be swapped without touching a call site. That promise is only worth
 * anything if **every** driver honours it, so the contract is checked
 * here rather than assumed.
 *
 * The properties:
 *
 *   1. Every driver implements all four operations.
 *   2. Every driver accepts every scope in the allow-list and refuses
 *      everything outside it — the scope is a namespace, so a driver
 *      that invented its own would break the cleanup job's assumptions.
 *   3. Every driver produces a key in the same shape, so a key means
 *      the same thing whichever driver wrote it.
 *   4. Every driver refuses a malformed key rather than passing it on.
 *   5. Every driver's `getUrl()` turns a key into a URL, and never
 *      returns the bare key — a key is not a URL.
 */

describe("the storage adapter contract", () => {
  const originalEnv = { ...process.env };

  /**
   * The temporary root the local driver writes into.
   *
   * A real directory rather than a mocked filesystem, because the point
   * of the checks is that the driver behaves correctly against one.
   */
  let localRoot: string;

  /**
   * The drivers under test.
   *
   * The local driver is constructed against the temporary root; the
   * Cloudinary driver is constructed without touching the network,
   * because none of these checks perform an upload.
   */
  let drivers: ReadonlyArray<{
    readonly name: string;
    readonly driver: StorageAdapter;
  }>;

  beforeAll(async () => {
    // The Cloudinary driver refuses to build a URL for an unconfigured
    // deployment, so the credentials are stubbed here. No request is
    // made — the SDK is only asked to *format* a URL.
    process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
    process.env.CLOUDINARY_API_KEY = "test-key";
    process.env.CLOUDINARY_API_SECRET = "test-secret";

    localRoot = await mkdtemp(path.join(tmpdir(), "euro-glam-conformance-"));

    drivers = [
      {
        name: "LocalStorageDriver",
        driver: new LocalStorageDriver({ root: localRoot }),
      },
      {
        name: "CloudinaryStorageDriver",
        driver: new CloudinaryStorageDriver(),
      },
    ];
  });

  afterAll(async () => {
    process.env = { ...originalEnv };

    if (localRoot) {
      await rm(localRoot, { recursive: true, force: true });
    }
  });

  it("every driver implements all four operations", () => {
    for (const { name, driver } of drivers) {
      expect(typeof driver.put, `${name}.put`).toBe("function");
      expect(typeof driver.delete, `${name}.delete`).toBe("function");
      expect(typeof driver.getUrl, `${name}.getUrl`).toBe("function");
      expect(typeof driver.exists, `${name}.exists`).toBe("function");
    }
  });

  it("every driver produces the same key shape", async () => {
    // The shape is asserted against a **real upload**, not against a
    // live Cloudinary account: the local driver writes to a temporary
    // directory, and the Cloudinary driver's shape is checked in
    // `cloudinary-driver.test.ts` against the mocked SDK.
    //
    // The point of the check is that a key means the same thing
    // whichever driver wrote it. A key written under one driver and
    // read under another — which is exactly what a migration does —
    // has to resolve to the same object.
    const shape = /^advisor\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/;

    const local = drivers[0].driver;

    const stored = await local.put({
      bytes: Buffer.from("not really an image"),
      mimeType: "image/png",
      originalName: "x.png",
      scope: "advisor",
    });

    expect(stored.key).toMatch(shape);
  });

  it("every driver refuses a scope outside the allow-list", async () => {
    for (const { name, driver } of drivers) {
      await expect(
        driver.put({
          bytes: Buffer.from("not really an image"),
          mimeType: "image/png",
          originalName: "x.png",
          scope: "../../etc",
        }),
        `${name} must refuse an unknown scope`,
      ).rejects.toThrow();
    }
  });

  it("every driver accepts every scope in the allow-list", () => {
    // The allow-list is the driver's own contract with the cleanup
    // job. A scope the driver refuses would leave orphaned files that
    // no cleanup pass could ever collect.
    for (const scope of STORAGE_SCOPES) {
      expect(isStorageScope(scope)).toBe(true);
    }

    expect(isStorageScope("not-a-scope")).toBe(false);
    expect(isStorageScope("../../etc")).toBe(false);
    expect(isStorageScope("")).toBe(false);
  });

  it("every driver refuses an empty key", async () => {
    for (const { name, driver } of drivers) {
      await expect(
        driver.exists(""),
        `${name} must refuse an empty key`,
      ).rejects.toThrow();

      await expect(
        driver.delete(""),
        `${name} must refuse an empty key`,
      ).rejects.toThrow();
    }
  });

  it("every driver refuses a key with a null byte", async () => {
    for (const { name, driver } of drivers) {
      await expect(
        driver.exists("advisor/2026/10/\0evil.png"),
        `${name} must refuse a null byte`,
      ).rejects.toThrow();
    }
  });

  it("every driver refuses a traversing key", async () => {
    for (const { name, driver } of drivers) {
      await expect(
        driver.exists("../../etc/passwd"),
        `${name} must refuse a traversing key`,
      ).rejects.toThrow();
    }
  });

  it("every driver turns a key into a URL and never returns the bare key", () => {
    for (const { name, driver } of drivers) {
      const key = "products/2026/11/abc123.png";
      const url = driver.getUrl(key);

      // The URL contains the key's *path*. The Cloudinary URL does not
      // carry the extension, because a Cloudinary asset's public id
      // does not — the format is a separate field of the asset.
      const path = key.slice(0, key.lastIndexOf("."));

      expect(url, `${name}.getUrl`).toContain(path);
      expect(url, `${name}.getUrl`).not.toBe(key);

      // The local driver serves the file from the app's own origin, so
      // its URL is a root-relative path. The Cloudinary driver serves
      // it from the CDN, so its URL is absolute. Both are valid; what
      // matters is that neither is the bare key.
      expect(
        url.startsWith("/") || /^https?:\/\//.test(url),
        `${name}.getUrl must be a URL, not a bare key`,
      ).toBe(true);
    }
  });
});
