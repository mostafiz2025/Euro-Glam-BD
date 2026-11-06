import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import { createProduct, updateProduct } from "@/lib/admin/catalog";
import { uploadProductImages } from "@/lib/admin/product-images";
import { LocalStorageDriver } from "@/lib/storage/local-driver";

/**
 * The product-image upload flow, against a real database.
 *
 * ── What this proves that a unit test cannot ─────────────────────────────
 *
 * The upload and the catalogue write are **two separate requests**, and
 * this is the one place where that separation could go wrong: an image
 * that is stored but never attached, or attached but never stored.
 *
 * So the properties proved here are:
 *
 *   1. An uploaded key can be attached to a product, and the product
 *      reads it back.
 *   2. The change is **audited** — the `PRODUCT_UPDATED` entry carries
 *      the image list in its diff, because an image change is a
 *      mutation and every mutation in this codebase is audited.
 *   3. The key stored in the database is the **key**, not the URL, so
 *      the driver can be swapped without rewriting the row.
 *   4. An image added to a product is rendered by the storefront's
 *      `imageUrl()` — the join between the column and the URL.
 *
 * The storage runs against a temporary directory, so the suite never
 * touches the real `public/uploads`.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `img${Date.now()}${Math.floor(Math.random() * 100000)}`;

let uploadRoot: string;
let driver: LocalStorageDriver;

let actor: AuditActor;

/**
 * A valid 1×1 PNG.
 */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/**
 * A plain-text file — the classic "renamed to .png" payload.
 */
const TEXT_FILE = Buffer.from(
  "This is not an image, whatever the filename says.",
  "utf8",
);

function makeFile(bytes: Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the product " +
        "image integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  uploadRoot = await mkdtemp(path.join(tmpdir(), "egb-product-images-"));
  driver = new LocalStorageDriver({ root: uploadRoot });

  const user = await prisma.user.create({
    data: {
      name: "Test Image Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Test Image Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (databaseAvailable) {
    try {
      await prisma.adminAuditLog.deleteMany({
        where: { entityType: "product", entityId: { in: createdProductIds } },
      });
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
      await prisma.category.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    } finally {
    }
  } else {
  }

  if (uploadRoot) {
    await rm(uploadRoot, { recursive: true, force: true });
  }
});

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Image Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

describe("the product image upload flow", () => {
  it("stores an image and returns a key, not a URL", async () => {
    if (!databaseAvailable) return;

    const [uploaded] = await uploadProductImages(
      [makeFile(PNG_1X1, "serum.png", "image/png")],
      driver,
    );

    // The key is what goes in the database — the column is documented
    // as holding storage adapter keys so the driver can be swapped.
    expect(uploaded.key).toMatch(
      /^products\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
    );

    // The URL is derived at render time.
    expect(uploaded.url).toBe(`/uploads/${uploaded.key}`);

    // And the file really is on disk.
    const stored = await driver.read(uploaded.key);

    expect(stored.equals(PNG_1X1)).toBe(true);
  });

  it("attaches an uploaded image to a product", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_attach`);

    const [uploaded] = await uploadProductImages(
      [makeFile(PNG_1X1, "serum.png", "image/png")],
      driver,
    );

    const product = await createProduct(actor, {
      name: `${runId}_attach`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 1,
      ingredientTags: [],
      images: [uploaded.key],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    expect(product.images).toEqual([uploaded.key]);

    // The row in the database holds the key, not the URL. This is the
    // property that lets the storage driver be swapped for a bucket
    // without rewriting a single row.
    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { images: true },
    });

    expect(row?.images).toEqual([uploaded.key]);
    expect(row?.images[0]).not.toContain("/uploads");
  });

  it("audits an image change as a PRODUCT_UPDATED diff", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_audit`);

    const product = await createProduct(actor, {
      name: `${runId}_audit`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 1,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    const [uploaded] = await uploadProductImages(
      [makeFile(PNG_1X1, "serum.png", "image/png")],
      driver,
    );

    await updateProduct(actor, product.id, {
      images: [uploaded.key],
      reason: "Adding the campaign photograph.",
    });

    const entries = await prisma.adminAuditLog.findMany({
      where: { entityType: "product", entityId: product.id },
      orderBy: { createdAt: "desc" },
    });

    expect(entries.length).toBe(2);

    const entry = entries[0];

    expect(entry.action).toBe("PRODUCT_UPDATED");
    expect(entry.reason).toBe("Adding the campaign photograph.");

    // The diff carries the image list — before it was empty, after it
    // holds the key. An image change is a mutation, and every mutation
    // in this codebase is audited.
    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;

    expect(before.images).toEqual([]);
    expect(after.images).toEqual([uploaded.key]);
  });

  it("records only the changed fields when images change", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_diff`);

    const product = await createProduct(actor, {
      name: `${runId}_diff`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 1,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    const [uploaded] = await uploadProductImages(
      [makeFile(PNG_1X1, "serum.png", "image/png")],
      driver,
    );

    await updateProduct(actor, product.id, { images: [uploaded.key] });

    const entry = await prisma.adminAuditLog.findFirst({
      where: {
        entityType: "product",
        entityId: product.id,
        action: "PRODUCT_UPDATED",
      },
      orderBy: { createdAt: "desc" },
    });

    const before = entry?.before as Record<string, unknown>;
    const after = entry?.after as Record<string, unknown>;

    // The name did not change, so it is not in the diff. An audit log
    // that reproduces the whole row on every save is a log nobody
    // reads.
    expect("name" in before).toBe(false);
    expect("name" in after).toBe(false);

    expect("images" in before).toBe(true);
    expect("images" in after).toBe(true);
  });

  it("refuses a renamed payload", async () => {
    if (!databaseAvailable) return;

    await expect(
      uploadProductImages(
        [makeFile(TEXT_FILE, "payload.png", "image/png")],
        driver,
      ),
    ).rejects.toThrow();
  });

  it("serves the stored image through the storefront's URL helper", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_serve`);

    const [uploaded] = await uploadProductImages(
      [makeFile(PNG_1X1, "serum.png", "image/png")],
      driver,
    );

    const product = await createProduct(actor, {
      name: `${runId}_serve`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 1,
      ingredientTags: [],
      images: [uploaded.key],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    // The storefront reads the key and derives the URL. This is the
    // join between the column and the public path — if it were broken,
    // every uploaded product would show the typographic placeholder.
    const { firstImageUrl } = await import("@/lib/format/image");

    expect(firstImageUrl(product.images)).toBe(`/uploads/${uploaded.key}`);
  });
});
