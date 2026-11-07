import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STORAGE_DRIVERS,
  StorageError,
  getStorageDriver,
  getStorageDriverName,
} from "@/lib/storage";
import { LocalStorageDriver } from "@/lib/storage/local-driver";
import { CloudinaryStorageDriver } from "@/lib/storage/cloudinary";

/**
 * The storage driver's selection.
 *
 * `STORAGE_DRIVER` decides which driver the whole application uses. That
 * switch is the entire point of the storage abstraction, so it is worth
 * pinning down:
 *
 *   1. `"local"` is the default, and it needs no credentials.
 *   2. `"cloudinary"` selects the Cloudinary driver.
 *   3. An unrecognised value is a **hard failure**, not a silent fall
 *      back to "local". A deployment that believes it is writing to
 *      Cloudinary while writing to the filesystem is a failure that
 *      stays hidden until the files go missing — so a typo is refused
 *      loudly instead.
 *   4. The value is read from the environment, not hard-coded, so the
 *      switch really is a configuration change.
 */

describe("the storage driver selection", () => {
  const originalDriver = process.env.STORAGE_DRIVER;

  beforeEach(() => {
    // `getStorageDriver()` memoises its result, so the module has to be
    // re-imported for each environment. The import is keyed on a query
    // string, which busts the module cache.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDriver === undefined) {
      delete process.env.STORAGE_DRIVER;
    } else {
      process.env.STORAGE_DRIVER = originalDriver;
    }
  });

  it("lists the drivers it knows about", () => {
    expect(STORAGE_DRIVERS).toEqual(["local", "cloudinary"]);
  });

  it("defaults to the local driver when nothing is configured", () => {
    delete process.env.STORAGE_DRIVER;

    expect(getStorageDriverName()).toBe("local");
  });

  it("reads the driver name from the environment", () => {
    process.env.STORAGE_DRIVER = "cloudinary";

    expect(getStorageDriverName()).toBe("cloudinary");
  });

  it("ignores surrounding whitespace and casing", () => {
    process.env.STORAGE_DRIVER = "  Cloudinary  ";

    expect(getStorageDriverName()).toBe("cloudinary");
  });

  it("refuses an unrecognised driver name", () => {
    process.env.STORAGE_DRIVER = "s3";

    expect(() => getStorageDriverName()).toThrow(StorageError);
  });

  it("names the unknown driver in the error, so the typo is visible", () => {
    process.env.STORAGE_DRIVER = "s3";

    expect(() => getStorageDriverName()).toThrow(/s3/);
  });

  it("returns the local driver when STORAGE_DRIVER is local", async () => {
    process.env.STORAGE_DRIVER = "local";

    const { getStorageDriver } = await import("@/lib/storage");

    // The constructor name rather than `instanceof`: the re-imported
    // module carries its own class identity, so `instanceof` against the
    // class imported at the top of this file compares two different
    // constructors.
    expect(getStorageDriver().constructor.name).toBe(
      new LocalStorageDriver().constructor.name,
    );
  });

  it("returns the Cloudinary driver when STORAGE_DRIVER is cloudinary", async () => {
    process.env.STORAGE_DRIVER = "cloudinary";

    const { getStorageDriver } = await import("@/lib/storage");

    expect(getStorageDriver().constructor.name).toBe(
      new CloudinaryStorageDriver().constructor.name,
    );
  });

  it("returns the same driver every time", () => {
    process.env.STORAGE_DRIVER = "local";

    expect(getStorageDriver()).toBe(getStorageDriver());
  });
});
