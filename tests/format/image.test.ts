import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IMAGE_URL_PREFIX,
  firstImageUrl,
  imageUrl,
  legacyPathToStorageKey,
} from "@/lib/format/image";

/**
 * Turning a stored image reference into a public URL.
 *
 * ── The three shapes an entry can take ───────────────────────────────────
 *
 * 1. **A storage key** — `products/2026/10/9f2c….png`. This is what
 *    the upload pipeline produces and what the column is documented to
 *    hold.
 *
 * 2. **An absolute URL** — `https://cdn.example.com/x.jpg`. Hand-pasted
 *    by an admin, and passed through untouched.
 *
 * 3. **A legacy absolute filesystem path** —
 *    `C:\…\public\uploads\products\serum.jpg`. What the seeded
 *    catalogue actually holds.
 *
 * The third shape is the reason this module has any subtlety in it. A
 * filesystem path joined onto `/uploads` produces
 * `/uploads/C:\Users\…\serum.jpg` — a URL that resolves to nothing. The
 * image is on disk; the reference is wrong. So the path is rewritten to
 * the key it was pointing at.
 */
describe("imageUrl", () => {
  it("joins a storage key onto the uploads prefix", () => {
    expect(imageUrl("products/2026/10/abc123.png")).toBe(
      `${IMAGE_URL_PREFIX}/products/2026/10/abc123.png`,
    );
  });

  it("passes an absolute URL through untouched", () => {
    expect(imageUrl("https://cdn.example.com/x.jpg")).toBe(
      "https://cdn.example.com/x.jpg",
    );
  });

  it("passes a protocol-relative URL through untouched", () => {
    expect(imageUrl("//cdn.example.com/x.jpg")).toBe(
      "//cdn.example.com/x.jpg",
    );
  });

  it("returns an empty string for an empty reference", () => {
    expect(imageUrl("")).toBe("");
    expect(imageUrl("   ")).toBe("");
  });

  it("rewrites a legacy Windows absolute path into its key", () => {
    // This is the exact shape the seeded catalogue holds. The file is
    // at `public/uploads/products/Bioderma atoderm.jpg`, and this is
    // the URL that finds it.
    expect(
      imageUrl(
        "C:\\Users\\BS01137\\Downloads\\Euro Glam BD\\public\\uploads\\products\\Bioderma atoderm.jpg",
      ),
    ).toBe(`${IMAGE_URL_PREFIX}/products/Bioderma atoderm.jpg`);
  });

  it("rewrites a legacy POSIX absolute path into its key", () => {
    expect(
      imageUrl("/srv/app/public/uploads/products/serum.jpg"),
    ).toBe(`${IMAGE_URL_PREFIX}/products/serum.jpg`);
  });

  it("keeps the spaces in a legacy filename", () => {
    // The filename on disk has spaces in it, and the URL has to match
    // it exactly. A "cleaned up" name would point at nothing.
    const url = imageUrl(
      "C:\\Users\\someone\\Euro Glam BD\\public\\uploads\\products\\La Roche-Posay Cicaplast B5.jpg",
    );

    expect(url).toBe(
      `${IMAGE_URL_PREFIX}/products/La Roche-Posay Cicaplast B5.jpg`,
    );
  });
});

describe("legacyPathToStorageKey", () => {
  it("extracts the key from a Windows path", () => {
    expect(
      legacyPathToStorageKey(
        "C:\\Users\\someone\\Euro Glam BD\\public\\uploads\\products\\serum.jpg",
      ),
    ).toBe("products/serum.jpg");
  });

  it("extracts the key from a POSIX path", () => {
    expect(
      legacyPathToStorageKey("/srv/app/public/uploads/products/serum.jpg"),
    ).toBe("products/serum.jpg");
  });

  it("returns null for a path that is not one of ours", () => {
    // A path outside the uploads root is not ours to rewrite, and
    // guessing at it would be worse than leaving it alone.
    expect(legacyPathToStorageKey("C:\\Windows\\System32\\config.png")).toBe(
      null,
    );
  });

  it("returns null for a plain key", () => {
    expect(legacyPathToStorageKey("products/2026/10/abc.png")).toBe(null);
  });

  it("returns null for an empty string", () => {
    expect(legacyPathToStorageKey("")).toBe(null);
  });

  it("returns null when the uploads root is the whole path", () => {
    expect(legacyPathToStorageKey("/uploads/")).toBe(null);
  });
});

describe("firstImageUrl", () => {
  it("returns the first usable image", () => {
    expect(
      firstImageUrl(["products/2026/10/abc.png", "products/2026/10/def.png"]),
    ).toBe(`${IMAGE_URL_PREFIX}/products/2026/10/abc.png`);
  });

  it("returns null for an empty list", () => {
    expect(firstImageUrl([])).toBeNull();
  });

  it("skips an empty entry and takes the next one", () => {
    expect(firstImageUrl(["", "products/2026/10/abc.png"])).toBe(
      `${IMAGE_URL_PREFIX}/products/2026/10/abc.png`,
    );
  });
});

/**
 * The URL derivation follows the configured driver.
 *
 * `imageUrl()` is imported by client components, so it cannot import
 * the storage module — that would pull `node:fs` into the browser
 * bundle. It derives the URL from the driver's *name* instead, and the
 * name comes from `STORAGE_DRIVER`.
 *
 * The property that matters: with the Cloudinary driver selected, a
 * storage key must produce a Cloudinary URL and **not** a `/uploads`
 * path. A `/uploads` URL under Cloudinary resolves to nothing — the
 * file was never written to the local disk — so every product on the
 * storefront would show the typographic placeholder while the images
 * sat in Cloudinary where nothing looked for them.
 */
describe("the URL for the configured driver", () => {
  const originalDriver = process.env.STORAGE_DRIVER;
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;

  beforeEach(() => {
    process.env.STORAGE_DRIVER = "cloudinary";
    process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  });

  afterEach(() => {
    if (originalDriver === undefined) {
      delete process.env.STORAGE_DRIVER;
    } else {
      process.env.STORAGE_DRIVER = originalDriver;
    }

    if (originalCloudName === undefined) {
      delete process.env.CLOUDINARY_CLOUD_NAME;
    } else {
      process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
    }
  });

  it("derives a Cloudinary URL when the Cloudinary driver is selected", () => {
    expect(imageUrl("products/2026/11/abc123.png")).toBe(
      "https://res.cloudinary.com/test-cloud/image/upload/euro-glam-bd/products/2026/11/abc123",
    );
  });

  it("does not produce an uploads path under the Cloudinary driver", () => {
    // The whole point. A `/uploads` URL under Cloudinary resolves to
    // nothing at all.
    expect(imageUrl("products/2026/11/abc123.png")).not.toContain("/uploads");
  });

  it("matches the URL the Cloudinary driver itself produces", async () => {
    /*
     * The two must agree. A key that produced one URL in the admin
     * console and a different URL on the storefront would be two
     * separate cached copies of the same picture — the image optimiser
     * caches by URL.
     */
    const { CloudinaryStorageDriver } = await import(
      "@/lib/storage/cloudinary"
    );

    process.env.CLOUDINARY_API_KEY = "test-key";
    process.env.CLOUDINARY_API_SECRET = "test-secret";

    const key = "products/2026/11/abc123.png";
    const driver = new CloudinaryStorageDriver();

    expect(imageUrl(key)).toBe(driver.getUrl(key));
  });

  it("still passes an absolute URL through untouched", () => {
    expect(imageUrl("https://cdn.example.com/x.jpg")).toBe(
      "https://cdn.example.com/x.jpg",
    );
  });

  it("rewrites a legacy filesystem path before deriving the URL", () => {
    // The legacy path names a file on the *local* disk, which under
    // the Cloudinary driver is not where the file is. The path is
    // rewritten to its key first, and the key is then derived from
    // whichever driver is configured.
    expect(
      imageUrl("C:\\Users\\someone\\public\\uploads\\products\\serum.jpg"),
    ).toBe(
      "https://res.cloudinary.com/test-cloud/image/upload/euro-glam-bd/products/serum",
    );
  });

  it("falls back to the uploads path for any other driver name", () => {
    process.env.STORAGE_DRIVER = "local";

    expect(imageUrl("products/2026/11/abc123.png")).toBe(
      `${IMAGE_URL_PREFIX}/products/2026/11/abc123.png`,
    );
  });

  it("ignores the casing and whitespace of the driver name", () => {
    process.env.STORAGE_DRIVER = "  Cloudinary  ";

    expect(imageUrl("products/2026/11/abc123.png")).toContain(
      "res.cloudinary.com",
    );
  });
});
