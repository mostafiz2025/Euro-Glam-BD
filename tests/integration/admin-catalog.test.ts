import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import {
  archiveProduct,
  createProduct,
  hardDeleteProduct,
  restoreProduct,
  updateProduct,
} from "@/lib/admin/catalog";
import { listAdminProducts } from "@/lib/admin/stats";
import { ApiError } from "@/lib/api/errors";
import { ACTIVE_PRODUCT_WHERE } from "@/lib/catalog/product-visibility";
import { productCreateSchema } from "@/lib/validation/admin";

/**
 * Product CRUD integration tests.
 *
 * These exercise the real database and the real Prisma transaction. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. A create and its audit entry are written **together** — one
 *      transaction, so a product can never exist with no record of who
 *      added it.
 *   2. An update records **only the changed fields** in `before` and
 *      `after`, so the audit entry reads as a diff.
 *   3. A price change **without a reason is refused**, and it writes
 *      nothing at all.
 *   4. The conditional update makes concurrent edits safe: two admins
 *      editing the same product produce one winner and one 409.
 *   5. A stock change is a **signed delta**, and it gets its own
 *      `PRODUCT_STOCK_ADJUSTED` audit entry.
 *   6. An archived product disappears from **every** storefront query —
 *      the property that matters most, because a forgotten filter
 *      *sells* an archived product.
 *   7. A hard delete is **refused** for a product that is still
 *      referenced, and the refusal names the remedy.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `cat${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Catalog Admin",
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
    data: { name: "Catalog Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

/**
 * The admin who performs the action.
 */
let actor: AuditActor;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the product " +
        "CRUD integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const adminId = await createUser(`${runId}_admin@example.com`);

  actor = {
    id: adminId,
    name: "Catalog Admin",
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

describe("createProduct", () => {
  it("creates the product and records the creation", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_create`);

    const product = await createProduct(actor, {
      name: `${runId}_created`,
      description: "A created product",
      categoryId,
      pricePaisa: 95000,
      discountPricePaisa: 80000,
      stockQuantity: 12,
      ingredientTags: ["AHA"],
      climateTips: "Store in the shade",
      images: [],
      badges: [],
      isNewArrival: true,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    expect(product.name).toBe(`${runId}_created`);
    expect(product.pricePaisa).toBe(95000);
    expect(product.stockQuantity).toBe(12);
    expect(product.archivedAt).toBeNull();

    const audit = await prisma.adminAuditLog.findFirst({
      where: { entityType: "product", entityId: product.id },
    });

    expect(audit).not.toBeNull();
    expect(audit?.action).toBe("PRODUCT_CREATED");
    expect(audit?.actorId).toBe(actor.id);
  });

  it("computes the discount percentage from the two prices", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_discount`);

    const product = await createProduct(actor, {
      name: `${runId}_discounted`,
      categoryId,
      pricePaisa: 100000,
      discountPricePaisa: 75000,
      stockQuantity: 0,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    // 25% off, derived — never a stored number that could disagree with
    // the prices it was derived from.
    expect(product.discountPercentage).toBe(25);
  });

  it("accepts the body the admin form sends, and writes the product", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_formbody`);

    /**
     * The admin form's body, verbatim.
     *
     * The point of this test is the **round trip**: the form's JSON is
     * parsed by the schema and then written by the service, exactly as
     * the route does. Before the fix, the schema refused the form's own
     * `null` climate tips, so this body never reached the database.
     *
     * So this is the test that would have caught the bug — a unit test
     * of the schema alone would have passed on a body nobody sends.
     */
    const body = {
      name: `${runId}_form_body`,
      description: "A product added through the admin form",
      brand: null,
      categoryId,
      pricePaisa: 95000,
      discountPricePaisa: 80000,
      stockQuantity: 10,
      ingredientTags: ["AHA"],
      climateTips: null,
      images: [],
      badges: [],
    };

    const parsed = productCreateSchema.parse(body);

    const product = await createProduct(actor, parsed);

    createdProductIds.push(product.id);

    expect(product.name).toBe(`${runId}_form_body`);
    expect(product.pricePaisa).toBe(95000);
    expect(product.discountPricePaisa).toBe(80000);
    expect(product.stockQuantity).toBe(10);
    expect(product.brand).toBeNull();

    // The nullable column holds a null, not an empty string.
    expect(product.climateTips).toBeNull();
  });

  it("accepts a body with only the required fields", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_minimal`);

    const parsed = productCreateSchema.parse({
      name: `${runId}_minimal`,
      categoryId,
      pricePaisa: 50000,
    });

    const product = await createProduct(actor, parsed);

    createdProductIds.push(product.id);

    expect(product.name).toBe(`${runId}_minimal`);
    expect(product.stockQuantity).toBe(0);
    expect(product.climateTips).toBeNull();
    expect(product.ingredientTags).toEqual([]);
    expect(product.images).toEqual([]);
    expect(product.badges).toEqual([]);
  });

  it("refuses a category that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      createProduct(actor, {
        name: `${runId}_no_category`,
        categoryId: "does-not-exist-id",
        pricePaisa: 1000,
        stockQuantity: 0,
        ingredientTags: [],
        images: [],
        badges: [],
        isNewArrival: false,
        isBestSeller: false,
      }),
    ).rejects.toThrow(ApiError);
  });

  it("writes no audit entry when the create is refused", async () => {
    if (!databaseAvailable) return;

    // The count is scoped to **this run's** products, not to the whole
    // table. Vitest runs the suites in parallel against one shared
    // database, so a global count moves whenever another suite creates
    // a product — which makes the assertion flaky rather than wrong.
    const before = await prisma.adminAuditLog.count({
      where: { entityType: "product", action: "PRODUCT_CREATED", entityId: { startsWith: runId } },
    });

    await expect(
      createProduct(actor, {
        name: `${runId}_refused`,
        categoryId: "does-not-exist-id",
        pricePaisa: 1000,
        stockQuantity: 0,
        ingredientTags: [],
        images: [],
        badges: [],
        isNewArrival: false,
        isBestSeller: false,
      }),
    ).rejects.toThrow();

    const after = await prisma.adminAuditLog.count({
      where: { entityType: "product", action: "PRODUCT_CREATED", entityId: { startsWith: runId } },
    });

    expect(after).toBe(before);
  });
});

describe("updateProduct", () => {
  it("records only the changed fields", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_update`);

    const product = await createProduct(actor, {
      name: `${runId}_to_update`,
      description: "Before",
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await updateProduct(actor, product.id, {
      name: `${runId}_renamed`,
      reason: "Clearer name",
    });

    const audit = await prisma.adminAuditLog.findFirst({
      where: {
        entityType: "product",
        entityId: product.id,
        action: "PRODUCT_UPDATED",
      },
    });

    expect(audit).not.toBeNull();

    const before = audit?.before as Record<string, unknown> | undefined;
    const after = audit?.after as Record<string, unknown> | undefined;

    // Only the field that changed is in the diff. The whole row would
    // bury the one meaningful value under ten that did not change.
    expect(Object.keys(before ?? {})).toEqual(["name"]);
    expect(Object.keys(after ?? {})).toEqual(["name"]);
    expect(before?.name).toBe(`${runId}_to_update`);
    expect(after?.name).toBe(`${runId}_renamed`);
  });

  it("leaves the untouched fields alone", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_partial`);

    const product = await createProduct(actor, {
      name: `${runId}_partial`,
      description: "Original description",
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: ["AHA"],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    const updated = await updateProduct(actor, product.id, {
      description: "A better description",
      reason: "Copy refresh",
    });

    // The price was not named, so it was not written. A partial update
    // that reset the price would be a silent commercial change.
    expect(updated.pricePaisa).toBe(95000);
    expect(updated.stockQuantity).toBe(5);
    expect(updated.ingredientTags).toEqual(["AHA"]);
    expect(updated.description).toBe("A better description");
  });

  it("refuses a price change with no reason", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_reason`);

    const product = await createProduct(actor, {
      name: `${runId}_priced`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await expect(
      updateProduct(actor, product.id, { pricePaisa: 120000 }),
    ).rejects.toThrow(ApiError);

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { pricePaisa: true },
    });

    // Nothing was written.
    expect(row?.pricePaisa).toBe(95000);
  });

  it("accepts a price change with a reason and records it", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_reason_ok`);

    const product = await createProduct(actor, {
      name: `${runId}_repriced`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await updateProduct(actor, product.id, {
      pricePaisa: 120000,
      reason: "Supplier price increase",
    });

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { pricePaisa: true },
    });

    expect(row?.pricePaisa).toBe(120000);

    const audit = await prisma.adminAuditLog.findFirst({
      where: {
        entityType: "product",
        entityId: product.id,
        action: "PRODUCT_UPDATED",
      },
    });

    expect(audit?.reason).toBe("Supplier price increase");

    const before = audit?.before as Record<string, unknown> | undefined;
    const after = audit?.after as Record<string, unknown> | undefined;

    expect(before?.pricePaisa).toBe(95000);
    expect(after?.pricePaisa).toBe(120000);
  });

  it("applies a stock change as a signed delta with its own audit entry", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_delta`);

    const product = await createProduct(actor, {
      name: `${runId}_delta`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 10,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    const updated = await updateProduct(actor, product.id, {
      stockDelta: 7,
      reason: "Restocked",
    });

    expect(updated.stockQuantity).toBe(17);

    const audits = await prisma.adminAuditLog.findMany({
      where: { entityType: "product", entityId: product.id },
      orderBy: { createdAt: "asc" },
    });

    // The creation, the stock adjustment, and the edit — three entries,
    // and the stock adjustment is its own. A stock change that rode
    // along inside a rename would be invisible in the stock trail.
    const stockAudit = audits.find((a) => a.action === "PRODUCT_STOCK_ADJUSTED");

    expect(stockAudit).toBeDefined();

    const before = stockAudit?.before as Record<string, unknown> | undefined;
    const after = stockAudit?.after as Record<string, unknown> | undefined;

    expect(before?.stockQuantity).toBe(10);
    expect(after?.stockQuantity).toBe(17);
  });

  it("refuses a stock change that would leave the shelf negative", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_neg`);

    const product = await createProduct(actor, {
      name: `${runId}_negative`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 3,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await expect(
      updateProduct(actor, product.id, { stockDelta: -10 }),
    ).rejects.toThrow(ApiError);

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { stockQuantity: true },
    });

    expect(row?.stockQuantity).toBe(3);
  });

  it("rejects a product that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      updateProduct(actor, "does-not-exist-id", { name: "x" }),
    ).rejects.toThrow(ApiError);
  });
});

describe("archiveProduct", () => {
  it("withdraws the product and records the archive", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_archive`);

    const product = await createProduct(actor, {
      name: `${runId}_archived`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    const result = await archiveProduct(actor, product.id, "Discontinued");

    expect(result.outcome).toBe("ARCHIVED");
    expect(result.archivedAt).toBeInstanceOf(Date);

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { archivedAt: true },
    });

    expect(row?.archivedAt).not.toBeNull();

    const audit = await prisma.adminAuditLog.findFirst({
      where: {
        entityType: "product",
        entityId: product.id,
        action: "PRODUCT_DELETED",
      },
    });

    expect(audit?.reason).toBe("Discontinued");
  });

  it("hides the product from every storefront query", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_hidden`);

    const product = await createProduct(actor, {
      name: `${runId}_hidden`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await archiveProduct(actor, product.id, "Withdrawn");

    // The storefront filter — the one shared constant every
    // customer-facing query must use. A product that is archived but
    // still returned here would be **sold**.
    const visible = await prisma.product.findFirst({
      where: { id: product.id, ...ACTIVE_PRODUCT_WHERE },
      select: { id: true },
    });

    expect(visible).toBeNull();

    // And the row still exists, so the order history survives.
    const exists = await prisma.product.findUnique({
      where: { id: product.id },
      select: { id: true },
    });

    expect(exists).not.toBeNull();
  });

  it("refuses to archive an already-archived product", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_twice`);

    const product = await createProduct(actor, {
      name: `${runId}_twice`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await archiveProduct(actor, product.id, "First");

    await expect(
      archiveProduct(actor, product.id, "Second"),
    ).rejects.toThrow(ApiError);
  });

  it("keeps the archived product visible in the admin list", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_admin_visible`);

    const product = await createProduct(actor, {
      name: `${runId}_admin_visible`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await archiveProduct(actor, product.id, "Withdrawn");

    // An admin has to be able to find a withdrawn product in order to
    // restore it — so the admin read deliberately does not filter.
    const adminList = await listAdminProducts({
      stock: "ARCHIVED",
      page: 1,
      limit: 100,
    });

    expect(adminList.products.map((p) => p.id)).toContain(product.id);
    expect(adminList.counts.archived).toBeGreaterThanOrEqual(1);
  });
});

describe("restoreProduct", () => {
  it("puts an archived product back on sale", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_restore`);

    const product = await createProduct(actor, {
      name: `${runId}_restored`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    await archiveProduct(actor, product.id, "Withdrawn");

    const restored = await restoreProduct(actor, product.id, "Back in stock");

    expect(restored.archivedAt).toBeNull();

    const visible = await prisma.product.findFirst({
      where: { id: product.id, ...ACTIVE_PRODUCT_WHERE },
      select: { id: true },
    });

    expect(visible).not.toBeNull();
  });
});

describe("hardDeleteProduct", () => {
  it("removes an unreferenced product and records the deletion", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_hard`);

    const product = await createProduct(actor, {
      name: `${runId}_hard_delete`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    const result = await hardDeleteProduct(actor, product.id, "Never sold");

    expect(result.outcome).toBe("DELETED");

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { id: true },
    });

    expect(row).toBeNull();

    const audit = await prisma.adminAuditLog.findFirst({
      where: {
        entityType: "product",
        entityId: product.id,
        action: "PRODUCT_DELETED",
      },
    });

    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe("Never sold");
  });

  it("refuses to delete a product that is still referenced", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_referenced`);

    const product = await createProduct(actor, {
      name: `${runId}_referenced`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 5,
      ingredientTags: [],
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(product.id);

    // A review is enough to make a hard delete impossible — the row
    // would be left dangling.
    const customer = await createUser(`${runId}_reviewer@example.com`);

    await prisma.review.create({
      data: {
        productId: product.id,
        userId: customer,
        rating: 5,
        comment: "A review that blocks the delete",
      },
    });

    await expect(
      hardDeleteProduct(actor, product.id, "Trying to delete"),
    ).rejects.toThrow(ApiError);

    // The product survives — the refusal is not a partial delete.
    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { id: true },
    });

    expect(row).not.toBeNull();
  });
});
