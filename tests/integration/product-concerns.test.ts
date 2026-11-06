import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import { createProduct, updateProduct } from "@/lib/admin/catalog";
import { listAdminProducts } from "@/lib/admin/stats";
import { ApiError } from "@/lib/api/errors";
import { listProducts } from "@/lib/catalog/service";

/**
 * The "Shop by Concern" link between a product and the concern
 * vocabulary, against a real database.
 *
 * ── The properties these tests prove ─────────────────────────────────────
 *
 *   1. A product stores the **slugs** it was given, and no more — the
 *      service does not silently add or drop one.
 *   2. A slug that names **no concern** is **refused**, not dropped. A
 *      silent drop would make the admin's save *appear* to work while
 *      quietly losing the selection, leaving the product missing from
 *      the concern page the admin was targeting.
 *   3. A refused save writes **nothing** — no product, no audit entry.
 *   4. A product with **no** concerns is legitimate. It simply does not
 *      appear in a concern-filtered listing.
 *   5. Clearing the list is a deliberate act — an empty list is
 *      different from an absent one.
 *   6. The concerns are part of the admin **listing**, so an admin can
 *      see at a glance which products are tagged.
 *   7. The **storefront** filters by the concern — a product appears
 *      under the concerns it carries, and under no others.
 *   8. The concern filter is **not** the ingredient filter. A product
 *      that merely contains BHA is not thereby an acne product, and the
 *      two axes must stay apart.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdConcernIds: string[] = [];

const runId = `cnc${Date.now()}${Math.floor(Math.random() * 100000)}`;

let actor: AuditActor;

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Concern Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

/**
 * Creates a concern in the vocabulary.
 *
 * The slug is unique across the table, so each test gets its own.
 */
async function createConcern(slug: string): Promise<string> {
  const concern = await prisma.skinConcern.create({
    data: {
      name: slug,
      slug,
      tag: "BHA",
      relatedTags: [],
    },
    select: { id: true },
  });

  createdConcernIds.push(concern.id);
  return concern.id;
}

/**
 * A counter, so each test's product has a name of its own.
 *
 * The tests below assert on the *absence* of rows, and a shared name
 * would make one test's product look like another's.
 */
let productCounter = 0;

/**
 * The product body the admin form sends.
 */
function body(categoryId: string, concernSlugs?: string[]) {
  productCounter += 1;

  return {
    name: `${runId}_product_${productCounter}`,
    description: "A product that carries concerns.",
    categoryId,
    pricePaisa: 95_000,
    stockQuantity: 5,
    ingredientTags: ["BHA"],
    images: [],
    badges: [],
    isNewArrival: false,
    isBestSeller: false,
    ...(concernSlugs === undefined ? {} : { concernSlugs }),
  };
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the product " +
        "concern integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const admin = await prisma.user.create({
    data: {
      name: "Test Concern Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(admin.id);

  actor = {
    id: admin.id,
    name: "Test Concern Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  await prisma.adminAuditLog.deleteMany({
    where: { entityType: "product", entityId: { in: createdProductIds } },
  });
  await prisma.product.deleteMany({
    where: { id: { in: createdProductIds } },
  });
  await prisma.skinConcern.deleteMany({
    where: { id: { in: createdConcernIds } },
  });
  await prisma.category.deleteMany({
    where: { id: { in: createdCategoryIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: createdUserIds } },
  });
});

describe("createProduct — concerns", () => {
  it("stores the concern slugs it was given", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_create`);
    await createConcern(`${runId}-acne`);

    const product = await createProduct(
      actor,
      body(categoryId, [`${runId}-acne`]),
    );

    createdProductIds.push(product.id);

    expect(product.concernSlugs).toEqual([`${runId}-acne`]);
  });

  it("stores several concerns, in the order they were given", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_several`);
    await createConcern(`${runId}-dryness`);
    await createConcern(`${runId}-texture`);

    const product = await createProduct(
      actor,
      body(categoryId, [`${runId}-dryness`, `${runId}-texture`]),
    );

    createdProductIds.push(product.id);

    expect(product.concernSlugs).toEqual([
      `${runId}-dryness`,
      `${runId}-texture`,
    ]);
  });

  it("accepts a product with no concerns", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_none`);

    const product = await createProduct(actor, body(categoryId, []));

    createdProductIds.push(product.id);

    expect(product.concernSlugs).toEqual([]);
  });

  it("refuses a slug that names no concern", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_unknown`);

    await expect(
      createProduct(actor, body(categoryId, [`${runId}-does-not-exist`])),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("writes nothing when a slug names no concern", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_nowrite`);

    const name = `${runId}_product_refused`;

    const entriesBefore = await prisma.adminAuditLog.count({
      where: { entityType: "product", actorId: actor.id },
    });

    await expect(
      createProduct(
        actor,
        { ...body(categoryId, [`${runId}-does-not-exist`]), name },
      ),
    ).rejects.toBeInstanceOf(ApiError);

    // No product, and no audit entry for one. A refused save must leave
    // no trace at all.
    const products = await prisma.product.count({ where: { name } });

    expect(products).toBe(0);

    const entriesAfter = await prisma.adminAuditLog.count({
      where: { entityType: "product", actorId: actor.id },
    });

    expect(entriesAfter).toBe(entriesBefore);
  });

  it("names the unknown slug in the refusal", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_named`);

    await expect(
      createProduct(actor, body(categoryId, [`${runId}-nope`])),
    ).rejects.toThrow(/nope/);
  });
});

describe("updateProduct — concerns", () => {
  it("replaces the concern list", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_update`);
    await createConcern(`${runId}-before`);
    await createConcern(`${runId}-after`);

    const product = await createProduct(
      actor,
      body(categoryId, [`${runId}-before`]),
    );

    createdProductIds.push(product.id);

    const updated = await updateProduct(actor, product.id, {
      concernSlugs: [`${runId}-after`],
    });

    expect(updated.concernSlugs).toEqual([`${runId}-after`]);
  });

  it("clears the concerns when given an empty list", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_clear`);
    await createConcern(`${runId}-clearable`);

    const product = await createProduct(
      actor,
      body(categoryId, [`${runId}-clearable`]),
    );

    createdProductIds.push(product.id);

    const updated = await updateProduct(actor, product.id, { concernSlugs: [] });

    expect(updated.concernSlugs).toEqual([]);
  });

  it("leaves the concerns alone when the field is absent", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_untouched`);
    await createConcern(`${runId}-kept`);

    const product = await createProduct(actor, body(categoryId, [`${runId}-kept`]));

    createdProductIds.push(product.id);

    const updated = await updateProduct(actor, product.id, {
      name: `${runId}_renamed`,
    });

    expect(updated.concernSlugs).toEqual([`${runId}-kept`]);
  });

  it("refuses an update that names a concern that does not exist", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_badupdate`);

    const product = await createProduct(actor, body(categoryId, []));

    createdProductIds.push(product.id);

    await expect(
      updateProduct(actor, product.id, {
        concernSlugs: [`${runId}-missing`],
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // The refusal left the product's concerns as they were.
    const row = await prisma.product.findUnique({
      where: { id: product.id },
      select: { concernSlugs: true },
    });

    expect(row?.concernSlugs).toEqual([]);
  });
});

describe("the admin listing — concerns", () => {
  it("reports the concerns on a listed product", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_listed`);
    await createConcern(`${runId}-listed`);

    const product = await createProduct(actor, body(categoryId, [`${runId}-listed`]));

    createdProductIds.push(product.id);

    const result = await listAdminProducts({
      stock: "ALL",
      // The listing is paginated, so the search narrows it to this
      // test's own product rather than relying on it being on the
      // first page.
      search: product.name,
      page: 1,
      limit: 100,
    });

    const row = result.products.find((entry) => entry.id === product.id);

    expect(row).toBeDefined();
    expect(row?.concernSlugs).toEqual([`${runId}-listed`]);
  });
});

/**
 * The **storefront** side of the concern link.
 *
 * ── Why these tests exist ─────────────────────────────────────────────────
 *
 * The admin half — storing the slugs — is only half the feature. If the
 * storefront cannot filter by them, the whole thing is inert: an admin
 * tags a product, and nothing on the shop changes.
 *
 * And the filter is specifically **not** the ingredient filter. A
 * product carrying the "acne" concern is one the shop has decided is an
 * acne product; a product that merely *contains* BHA is one that
 * happens to hold an ingredient in the same family. These tests hold
 * the two apart — because collapsing them is exactly the mistake the
 * feature was built to fix.
 */
describe("the catalogue — the concern filter", () => {
  it("lists a product under the concern it carries", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_store`);
    await createConcern(`${runId}-storefront`);

    const product = await createProduct(
      actor,
      body(categoryId, [`${runId}-storefront`]),
    );

    createdProductIds.push(product.id);

    const result = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      concern: `${runId}-storefront`,
    });

    expect(result.products.map((entry) => entry.id)).toContain(product.id);
  });

  it("does not list the product under a concern it does not carry", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_notin`);
    await createConcern(`${runId}-here`);
    await createConcern(`${runId}-elsewhere`);

    const product = await createProduct(actor, body(categoryId, [`${runId}-here`]));

    createdProductIds.push(product.id);

    const result = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      concern: `${runId}-elsewhere`,
    });

    expect(result.products.map((entry) => entry.id)).not.toContain(product.id);
  });

  it("does not list a product with no concerns at all", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_noconcerns`);
    await createConcern(`${runId}-any`);

    const product = await createProduct(actor, body(categoryId, []));

    createdProductIds.push(product.id);

    const result = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      concern: `${runId}-any`,
    });

    expect(result.products.map((entry) => entry.id)).not.toContain(product.id);
  });

  it("lists a product that carries several concerns under each of them", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_multi`);
    await createConcern(`${runId}-first`);
    await createConcern(`${runId}-second`);

    const product = await createProduct(
      actor,
      body(categoryId, [`${runId}-first`, `${runId}-second`]),
    );

    createdProductIds.push(product.id);

    const first = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      concern: `${runId}-first`,
    });

    const second = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      concern: `${runId}-second`,
    });

    expect(first.products.map((entry) => entry.id)).toContain(product.id);
    expect(second.products.map((entry) => entry.id)).toContain(product.id);
  });

  it("counts the filtered rows, not the whole catalogue", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_counted`);
    await createConcern(`${runId}-counted`);

    const product = await createProduct(
      actor,
      body(categoryId, [`${runId}-counted`]),
    );

    createdProductIds.push(product.id);

    const result = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      concern: `${runId}-counted`,
    });

    // The count and the rows must agree. A count that reported the
    // unfiltered catalogue next to a filtered grid would put two
    // contradicting numbers on the same screen.
    expect(result.pagination.total).toBe(result.products.length);
    expect(result.pagination.total).toBeGreaterThan(0);
  });

  it("echoes the concern back as an applied filter", async () => {
    if (!databaseAvailable) return;

    const result = await listProducts({
      page: 1,
      limit: 20,
      sort: "newest",
      concern: `${runId}-echoed`,
    });

    expect(result.appliedFilters.concern).toBe(`${runId}-echoed`);
  });

  it("is a different filter from the ingredient one", async () => {
    if (!databaseAvailable) return;

    const categoryId = await createCategory(`${runId}_axis`);

    /*
      A product that **contains** BHA but carries no concern.

      This is the product the old storefront link would have shown on
      the "Acne" page — because the old link filtered on the ingredient
      tag. Under the concern filter it must not appear, because the shop
      has not said it is an acne product.
    */
    const product = await createProduct(
      actor,
      body(categoryId, []),
    );

    createdProductIds.push(product.id);

    const byConcern = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      concern: `${runId}-axis`,
    });

    const byIngredient = await listProducts({
      page: 1,
      limit: 100,
      sort: "newest",
      ingredient: "BHA",
    });

    // The ingredient axis finds it — the seeded tags are `["BHA"]`.
    expect(byIngredient.products.map((entry) => entry.id)).toContain(product.id);

    // The concern axis does not.
    expect(byConcern.products.map((entry) => entry.id)).not.toContain(product.id);
  });
});
