import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import { createProduct, updateProduct } from "@/lib/admin/catalog";
import { listAdminProducts } from "@/lib/admin/stats";
import { listProducts } from "@/lib/catalog/service";
import { MAX_BRAND_LENGTH } from "@/lib/format/brand";
import { productUpdateSchema } from "@/lib/validation/admin";

/**
 * The stored brand — integration tests.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The brand used to be *derived* from the product's name. It is now a
 * **stored column**, and the derivation survives only as the fallback.
 * That change introduces three properties a unit test cannot prove:
 *
 *   1. The brand actually **reaches the database** — through the create
 *      path, through the update path, and through the read path.
 *   2. The brand is **canonicalised on the way in** — "cerave" is stored
 *      as "CeraVe", so the shop cannot end up with three spellings of one
 *      brand on the storefront.
 *   3. The brand is **searchable** — a shopper typing "CeraVe" finds the
 *      CeraVe products, including one whose *name* does not start with
 *      the brand.
 *
 * The fourth property — that a **stored** brand wins over the derived
 * one — is proved in `tests/format/brand.test.ts`, which is where it
 * belongs: it is a property of the function, not of the database.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `brd${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Brand Admin",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Brand Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

let actor: AuditActor;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the brand " +
        "integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const adminId = await createUser(`${runId}_admin@example.com`);

  actor = {
    id: adminId,
    name: "Brand Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

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
});

describe("creating a product with a brand", () => {
  it("stores the brand on the row", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c1`);

    const product = await createProduct(actor, {
      name: `${runId}_CeraVe Hydrating Cream`,
      description: "A test product with a brand.",
      brand: "CeraVe",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    expect(product.brand).toBe("CeraVe");

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { brand: true },
    });

    expect(row?.brand).toBe("CeraVe");
  });

  it("canonicalises a known brand to its registry spelling", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c2`);

    // "cerave" and "CeraVe" are one brand. If the server stored what
    // the admin typed, the shop could end up with two brands that look
    // identical on the storefront and filter differently in the
    // catalogue.
    const product = await createProduct(actor, {
      name: `${runId}_canonical`,
      description: "A test product with a lowercase brand.",
      brand: "cerave",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    expect(product.brand).toBe("CeraVe");
  });

  it("stores a custom brand trimmed and collapsed", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c3`);

    // A brand the registry has never heard of must have somewhere to
    // go — the shop stocks things the code was written before.
    const product = await createProduct(actor, {
      name: `${runId}_custom`,
      description: "A test product with a custom brand.",
      brand: "  New   Skin  ",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    expect(product.brand).toBe("New Skin");
  });

  it("accepts a product with no brand at all", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c4`);

    // A `null` brand is a legitimate value. A product genuinely may have
    // no brand, and the column is nullable for exactly that reason.
    const product = await createProduct(actor, {
      name: `${runId}_no_brand`,
      description: "A test product with no brand.",
      brand: null,
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    expect(product.brand).toBeNull();
  });

  it("records the brand in the create audit entry", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c5`);

    const product = await createProduct(actor, {
      name: `${runId}_audited`,
      description: "A test product with an audited brand.",
      brand: "Bioderma",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { entityType: "product", entityId: product.id },
    });

    expect(audit).not.toBeNull();
    expect(audit?.action).toBe("PRODUCT_CREATED");

    // The audit entry is the record of who added what. A brand that
    // was not recorded would be a brand that could not be traced.
    const after = audit?.after as Record<string, unknown> | null;

    expect(after?.brand).toBe("Bioderma");
  });
});

describe("updating a product's brand", () => {
  it("changes the brand and records it", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c6`);

    const product = await createProduct(actor, {
      name: `${runId}_updatable`,
      description: "A test product whose brand changes.",
      brand: "CeraVe",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    await updateProduct(actor, product.id, { brand: "Bioderma" });

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { brand: true },
    });

    expect(row?.brand).toBe("Bioderma");
  });

  it("clears the brand when null is sent", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c7`);

    const product = await createProduct(actor, {
      name: `${runId}_clearable`,
      description: "A test product whose brand is cleared.",
      brand: "CeraVe",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    await updateProduct(actor, product.id, { brand: null });

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { brand: true },
    });

    expect(row?.brand).toBeNull();
  });

  it("leaves the brand alone when it is not mentioned", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c8`);

    const product = await createProduct(actor, {
      name: `${runId}_untouched`,
      description: "A test product whose brand is not in the update.",
      brand: "Vichy",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    // A partial update changes only what it names. A price-only edit
    // must not clear the brand.
    //
    // The reason is required because a *price* changed — that is the
    // service's rule, and it is not what this test is about.
    await updateProduct(actor, product.id, {
      pricePaisa: 120000,
      reason: "A price change, to prove the brand is untouched.",
    });

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { brand: true },
    });

    expect(row?.brand).toBe("Vichy");
  });

  it("refuses a brand that is too long", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c9`);

    const product = await createProduct(actor, {
      name: `${runId}_too_long`,
      description: "A test product with an over-long brand.",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    // The validation layer owns the length limit, so the service is
    // never asked to write a brand that could not be displayed.
    const parsed = productUpdateSchema.safeParse({
      brand: "x".repeat(MAX_BRAND_LENGTH + 1),
    });

    expect(parsed.success).toBe(false);
  });
});

describe("reading the brand", () => {
  it("returns the brand on the catalogue summary", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c10`);

    const product = await createProduct(actor, {
      name: `${runId}_readable`,
      description: "A test product whose brand is read back.",
      brand: "La Roche-Posay",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    const result = await listProducts({
      search: `${runId}_readable`,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    const found = result.products.find((item) => item.id === product.id);

    expect(found?.brand).toBe("La Roche-Posay");
  });

  it("returns the brand on the admin summary", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c11`);

    const product = await createProduct(actor, {
      name: `${runId}_admin_readable`,
      description: "A test product whose brand is read by the admin list.",
      brand: "Neutrogena",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    const result = await listAdminProducts({
      stock: "ALL",
      search: `${runId}_admin_readable`,
      page: 1,
      limit: 20,
    });

    const found = result.products.find((item) => item.id === product.id);

    expect(found?.brand).toBe("Neutrogena");
  });

  it("finds a product by its brand when the name does not contain it", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_c12`);

    // The whole reason the brand is searchable as its own column: a
    // shopper typing "CeraVe" must find the CeraVe products, even
    // when the product's name does not begin with the brand.
    const product = await createProduct(actor, {
      name: `${runId}_unnamed_face_cream`,
      description: "A test product found by its brand alone.",
      brand: "CeraVe",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    const result = await listProducts({
      search: "CeraVe",
      page: 1,
      limit: 100,
      sort: "newest",
    });

    expect(result.products.map((item) => item.id)).toContain(product.id);
  });
});
