import { afterEach, describe, expect, it } from "vitest";

import {
  CLOUDINARY_FOLDER,
  cloudinaryDeliveryUrl,
  toCloudinaryPublicId,
} from "@/lib/storage/cloudinary-url";

/**
 * The Cloudinary URL and `public_id` conversions.
 *
 * ── Why these tests exist ─────────────────────────────────────────────────
 *
 * Two bugs lived in this conversion, and both were invisible in the
 * rendered page:
 *
 *   1. **The folder was added twice.** The key `products/xyz.png` became
 *      `euro-glam-bd/euro-glam-bd/products/xyz.png`, so every URL was a
 *      404 and every image was broken.
 *
 *   2. **The extension was kept in the `public_id`.** Cloudinary stores
 *      the format in a separate field, so the asset's real identifier is
 *      `euro-glam-bd/products/xyz` — not `…/xyz.png`. The Admin API
 *      looks the asset up by that identifier, so `exists()` reported
 *      every object as missing and `delete()` silently left every object
 *      in place while the images kept rendering perfectly.
 *
 * The second one is the dangerous kind: the storefront looked correct
 * the whole time.
 */
describe("toCloudinaryPublicId", () => {
  it("adds the folder to a scope-relative key", () => {
    expect(toCloudinaryPublicId("products/abc123.png")).toBe(
      `${CLOUDINARY_FOLDER}/products/abc123`,
    );
  });

  it("removes the extension", () => {
    // Cloudinary identifies the asset by the extension-less id, so
    // keeping the extension makes the asset unfindable.
    expect(toCloudinaryPublicId("brands/abc123.png")).not.toContain(".png");
  });

  it("does not add the folder twice", () => {
    const publicId = toCloudinaryPublicId(
      `${CLOUDINARY_FOLDER}/products/abc123.png`,
    );

    expect(publicId).toBe(`${CLOUDINARY_FOLDER}/products/abc123`);
    expect(publicId.match(/euro-glam-bd/g)).toHaveLength(1);
  });

  it("is idempotent", () => {
    // Converting twice must give the same answer, or a key that has
    // already been through the conversion would be corrupted by a
    // second pass.
    const once = toCloudinaryPublicId("products/abc123.png");
    const twice = toCloudinaryPublicId(once);

    expect(twice).toBe(once);
  });

  it("keeps a dot that belongs to a folder segment", () => {
    // `v1.2/abc` — the dot is in the folder, not the filename, so it is
    // not an extension and must not be stripped.
    expect(toCloudinaryPublicId("v1.2/abc.png")).toBe(
      `${CLOUDINARY_FOLDER}/v1.2/abc`,
    );
  });

  it("handles a key with no extension", () => {
    expect(toCloudinaryPublicId("products/abc123")).toBe(
      `${CLOUDINARY_FOLDER}/products/abc123`,
    );
  });

  it("ignores a leading slash", () => {
    expect(toCloudinaryPublicId("/products/abc123.png")).toBe(
      `${CLOUDINARY_FOLDER}/products/abc123`,
    );
  });
});

describe("cloudinaryDeliveryUrl", () => {
  const originalCloudName = process.env.CLOUDINARY_CLOUD_NAME;

  afterEach(() => {
    if (originalCloudName === undefined)
      delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = originalCloudName;
  });

  it("builds the delivery URL for a key", () => {
    process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud";

    expect(cloudinaryDeliveryUrl("brands/abc123.png")).toBe(
      "https://res.cloudinary.com/demo-cloud/image/upload/euro-glam-bd/brands/abc123.png",
    );
  });

  it("keeps the extension in the delivery URL", () => {
    // The extension is optional in a delivery URL — Cloudinary serves
    // the same asset either way — and keeping it matches what the
    // upload response reports.
    process.env.CLOUDINARY_CLOUD_NAME = "demo-cloud";

    expect(cloudinaryDeliveryUrl("brands/abc123.png")).toContain(".png");
  });

  it("returns null when the cloud name is not configured", () => {
    // A URL for an account that does not exist resolves to nothing, so
    // returning one would be a lie. The caller falls back instead.
    delete process.env.CLOUDINARY_CLOUD_NAME;

    expect(cloudinaryDeliveryUrl("brands/abc123.png")).toBeNull();
  });

  it("returns null for a blank cloud name", () => {
    process.env.CLOUDINARY_CLOUD_NAME = "   ";

    expect(cloudinaryDeliveryUrl("brands/abc123.png")).toBeNull();
  });
});
