import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import { createProduct, updateProduct } from "@/lib/admin/catalog";
import { listAdminProducts } from "@/lib/admin/stats";

/**
 * The badge list, end to end.
 *
 * ── What these tests prove ───────────────────────────────────────────────
 *
 * The badge list is the **source of truth** for a product's promotional
 * labels, and the two legacy booleans — `isNewArrival` and
 * `isBestSeller` — are a *mirror* of two entries in it. The storefront
 * reads the booleans, so the mirror has to be kept in step with the
 * list by the service, on every write:
 *
 *   1. A create with a badge list writes the list **and** the booleans.
 *   2. An update that adds "New Arrival" turns the boolean on.
 *   3. An update that removes "New Arrival" turns the boolean off.
 *   4. A legacy client that sends only `isNewArrival: true` still gets
 *      the badge added to the list — the old wire format keeps working.
 *   5. The audit entry records the badge change as a **diff**.
 *   6. The admin inventory list returns the badges, so the table can
 *      render them.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `bdg${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Badge Admin",
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
    data: { name: "Badge Test", slug },
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
      "\n[integration] PostgreSQL is not reachable — skipping the badge " +
        "persistence integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const adminId = await createUser(`${runId}_admin@example.com`);

  actor = {
    id: adminId,
    name: "Test Badge Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) return;

  await prisma.product.deleteMany({
    where: { id: { in: createdProductIds } },
  });

  await prisma.category.deleteMany({
    where: { id: { in: createdCategoryIds } },
  });

  await prisma.user.deleteMany({
    where: { id: { in: createdUserIds } },
  });
});

describe("the badge list", () => {
  it("writes the list and mirrors the booleans on create", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_create`);

    const product = await createProduct(actor, {
      name: `${runId}_create`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 3,
      ingredientTags: [],
      images: [],
      badges: ["New Arrival", "Limited Edition"],
    });

    createdProductIds.push(product.id);

    expect(product.badges).toEqual(["New Arrival", "Limited Edition"]);

    // The mirror: the storefront reads the booleans, so the service
    // sets them from the list.
    expect(product.isNewArrival).toBe(true);
    expect(product.isBestSeller).toBe(false);

    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { badges: true, isNewArrival: true, isBestSeller: true },
    });

    expect(row?.badges).toEqual(["New Arrival", "Limited Edition"]);
    expect(row?.isNewArrival).toBe(true);
    expect(row?.isBestSeller).toBe(false);
  });

  it("turns the boolean on when the badge is added", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_add`);

    const product = await createProduct(actor, {
      name: `${runId}_add`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 3,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    expect(product.isBestSeller).toBe(false);

    const updated = await updateProduct(actor, product.id, {
      badges: ["Best Seller"],
    });

    expect(updated.badges).toEqual(["Best Seller"]);
    expect(updated.isBestSeller).toBe(true);
    expect(updated.isNewArrival).toBe(false);
  });

  it("turns the boolean off when the badge is removed", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_remove`);

    const product = await createProduct(actor, {
      name: `${runId}_remove`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 3,
      ingredientTags: [],
      images: [],
      badges: ["New Arrival", "Best Seller"],
    });

    createdProductIds.push(product.id);

    expect(product.isNewArrival).toBe(true);
    expect(product.isBestSeller).toBe(true);

    const updated = await updateProduct(actor, product.id, {
      badges: ["Best Seller"],
    });

    expect(updated.badges).toEqual(["Best Seller"]);
    expect(updated.isNewArrival).toBe(false);
    expect(updated.isBestSeller).toBe(true);
  });

  it("accepts a legacy client that sends only the boolean", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_legacy`);

    const product = await createProduct(actor, {
      name: `${runId}_legacy`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 3,
      ingredientTags: [],
      images: [],
      badges: [],
    });

    createdProductIds.push(product.id);

    // An older client knows nothing about the badge list. It sends the
    // boolean, and the service folds it into the list — so the old wire
    // format keeps working and the mirror never drifts.
    const updated = await updateProduct(actor, product.id, {
      isNewArrival: true,
    });

    expect(updated.badges).toEqual(["New Arrival"]);
    expect(updated.isNewArrival).toBe(true);
  });

  it("records a badge change in the audit entry", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_audit`);

    const product = await createProduct(actor, {
      name: `${runId}_audit`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 3,
      ingredientTags: [],
      images: [],
      badges: ["New Arrival"],
    });

    createdProductIds.push(product.id);

    await updateProduct(actor, product.id, { badges: ["Eid Special 2026"] });

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

    expect(before.badges).toEqual(["New Arrival"]);
    expect(after.badges).toEqual(["Eid Special 2026"]);
  });

  it("returns the badges in the admin inventory list", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_list`);

    const product = await createProduct(actor, {
      name: `${runId}_list`,
      categoryId,
      pricePaisa: 95000,
      stockQuantity: 3,
      ingredientTags: [],
      images: [],
      badges: ["Limited Edition"],
    });

    createdProductIds.push(product.id);

    const result = await listAdminProducts({
      stock: "ALL",
      search: `${runId}_list`,
      page: 1,
      limit: 20,
    });

    const row = result.products.find((entry) => entry.id === product.id);

    expect(row).toBeDefined();
    expect(row?.badges).toEqual(["Limited Edition"]);
  });
});
