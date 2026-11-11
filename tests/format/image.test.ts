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
 * The storage-driver-aware URL.
 *
 * ── Why this block exists ─────────────────────────────────────────────────
 *
 * `imageUrl()` used to join the key onto a hardcoded `/uploads` prefix.
 * That was correct for the local filesystem driver and **wrong for every
 * other driver** — and the production configuration is Cloudinary.
 *
 * So a key written by Cloudinary (`brands/2026/10/abc.png`) was rendered
 * as `/uploads/brands/2026/10/abc.png`, which resolves to nothing on
 * Vercel. Every uploaded brand logo, category card and concern card
 * showed a broken image, and the admin's own preview did too.
 *
 * The URL is now derived from the driver that is actually configured,
 * and these tests pin that behaviour down.
 */
describe("imageUrl with the Cloudinary driver", () => {
  const originalDriver = process.env.STORAGE_DRIVER;
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;

  beforeEach(() => {
    process.env.STORAGE_DRIVER = "cloudinary";
    process.env.CLOUDINARY_CLOUD_NAME = "euro-glam-demo";
  });

  afterEach(() => {
    if (originalDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = originalDriver;

    if (originalCloudName === undefined)
      delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
  });

  it("resolves a key to the Cloudinary delivery URL", () => {
    expect(imageUrl("brands/2026/10/abc.png")).toBe(
      "https://res.cloudinary.com/euro-glam-demo/image/upload/euro-glam-bd/brands/2026/10/abc.png",
    );
  });

  it("resolves a category card image", () => {
    expect(imageUrl("categories/2026/10/abc.png")).toBe(
      "https://res.cloudinary.com/euro-glam-demo/image/upload/euro-glam-bd/categories/2026/10/abc.png",
    );
  });

  it("resolves a concern card image", () => {
    expect(imageUrl("concerns/2026/10/abc.png")).toBe(
      "https://res.cloudinary.com/euro-glam-demo/image/upload/euro-glam-bd/concerns/2026/10/abc.png",
    );
  });

  it("resolves a product image", () => {
    expect(imageUrl("products/2026/10/abc.png")).toBe(
      "https://res.cloudinary.com/euro-glam-demo/image/upload/euro-glam-bd/products/2026/10/abc.png",
    );
  });

  it("does not use the local uploads prefix", () => {
    // The regression this whole block guards against: a Cloudinary key
    // joined onto `/uploads`, which resolves to nothing.
    expect(imageUrl("brands/2026/10/abc.png")).not.toContain("/uploads/");
  });

  it("still passes an absolute URL through untouched", () => {
    expect(imageUrl("https://cdn.example.com/x.jpg")).toBe(
      "https://cdn.example.com/x.jpg",
    );
  });

  it("falls back to the local prefix when the cloud name is missing", () => {
    // A Cloudinary deployment with no cloud name cannot serve a
    // Cloudinary URL. Returning the local URL at least points at the
    // path the file would occupy on the local driver, and returning an
    // empty string would render nothing at all.
    delete process.env.CLOUDINARY_CLOUD_NAME;

    expect(imageUrl("brands/2026/10/abc.png")).toBe(
      `${IMAGE_URL_PREFIX}/brands/2026/10/abc.png`,
    );
  });
});

describe("imageUrl with the local driver", () => {
  const originalDriver = process.env.STORAGE_DRIVER;
  const originalPrefix = process.env.STORAGE_URL_PREFIX;

  beforeEach(() => {
    process.env.STORAGE_DRIVER = "local";
    delete process.env.STORAGE_URL_PREFIX;
  });

  afterEach(() => {
    if (originalDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = originalDriver;

    if (originalPrefix === undefined) delete process.env.STORAGE_URL_PREFIX;
    else process.env.STORAGE_URL_PREFIX = originalPrefix;
  });

  it("joins the key onto the uploads prefix", () => {
    expect(imageUrl("brands/2026/10/abc.png")).toBe(
      `${IMAGE_URL_PREFIX}/brands/2026/10/abc.png`,
    );
  });

  it("honours a configured URL prefix", () => {
    // A deployment that fronts the files with a CDN overrides the
    // prefix, and the URL has to follow it — otherwise every image
    // breaks on that deployment.
    process.env.STORAGE_URL_PREFIX = "https://cdn.example.com/shop/";

    expect(imageUrl("brands/2026/10/abc.png")).toBe(
      "https://cdn.example.com/shop/brands/2026/10/abc.png",
    );
  });
});
