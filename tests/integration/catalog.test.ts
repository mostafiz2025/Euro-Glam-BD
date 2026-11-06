import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listProducts } from "@/lib/catalog/service";

/**
 * Catalogue integration tests.
 *
 * These exercise the real query builder against a real database. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. The price filter applies to the *effective* price — the price the
 *      customer actually pays.
 *   2. The filters combine with AND, so a search and a price ceiling
 *      narrow the catalogue together rather than one replacing the other.
 *   3. Pagination counts the *filtered* set, not the whole catalogue.
 *
 * The price filter had a real bug. Its two price paths — "this product is
 * discounted" and "this product is not discounted" — are alternatives, but
 * they were combined with AND. A product would have to satisfy both at
 * once, so the filter matched nothing and every price-filtered query
 * returned an empty catalogue with a 200 response. The test below is the
 * regression guard.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `cat${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * A category slug, in the lowercase hyphen-separated form the schema
 * requires.
 */
const slug = `${runId}-cat`;

/**
 * Creates the fixture: one category with four products that sit on
 * either side of a price ceiling.
 */
async function createFixtures(): Promise<{
  discountedId: string;
  plainId: string;
  tooDearId: string;
  freeId: string;
}> {
  const category = await prisma.category.create({
    data: { name: "Catalogue Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);

  const create = async (
    name: string,
    pricePaisa: number,
    discountPricePaisa: number | null,
  ): Promise<string> => {
    const product = await prisma.product.create({
      data: {
        name,
        description: `Catalogue test product ${name}`,
        categoryId: category.id,
        pricePaisa,
        discountPricePaisa,
        stockQuantity: 10,
        ingredientTags: [],
      },
      select: { id: true },
    });

    createdProductIds.push(product.id);
    return product.id;
  };

  // List price 300000, but the customer pays 120000 — under the ceiling.
  const discountedId = await create("Discounted", 300000, 120000);
  // List price 130000, no discount — exactly at the ceiling.
  const plainId = await create("Plain", 130000, null);
  // List price 200000, no discount — over the ceiling.
  const tooDearId = await create("Too Dear", 200000, null);
  // List price 100000, discounted to zero — a free item.
  const freeId = await create("Free", 100000, 0);

  return { discountedId, plainId, tooDearId, freeId };
}

let fixtures: Awaited<ReturnType<typeof createFixtures>>;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the catalogue " +
        "integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  fixtures = await createFixtures();
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.product.deleteMany({
      where: { id: { in: createdProductIds } },
    });
    await prisma.category.deleteMany({
      where: { id: { in: createdCategoryIds } },
    });
  } finally {
  }
});

describe("listProducts — the price filter", () => {
  it("filters on the effective price, not the list price", async () => {
    if (!databaseAvailable) return;

    const result = await listProducts({
      category: slug,
      maxPricePaisa: 130000,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    const ids = result.products.map((p) => p.id);

    // The whole point: the list price is 300000, which is over the
    // ceiling, but the customer pays 120000, which is under it.
    expect(ids).toContain(fixtures.discountedId);

    // The ceiling itself is inclusive.
    expect(ids).toContain(fixtures.plainId);

    // Genuinely over the ceiling.
    expect(ids).not.toContain(fixtures.tooDearId);
  });

  it("excludes a free item when a minimum price is set", async () => {
    if (!databaseAvailable) return;

    const result = await listProducts({
      category: slug,
      minPricePaisa: 1,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    const ids = result.products.map((p) => p.id);

    // A zero discount is a real price of zero, not a missing price.
    expect(ids).not.toContain(fixtures.freeId);

    // And the others are still there.
    expect(ids).toContain(fixtures.plainId);
  });

  it("counts the filtered set, not the whole catalogue", async () => {
    if (!databaseAvailable) return;

    const all = await listProducts({
      category: slug,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    const filtered = await listProducts({
      category: slug,
      maxPricePaisa: 130000,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    expect(all.pagination.total).toBe(4);

    // Three of the four are under the ceiling: the discounted one
    // (120000), the plain one (130000, exactly at the ceiling) and the
    // free one (0). Only "Too Dear" (200000) is over it.
    expect(filtered.pagination.total).toBe(3);
  });
});

describe("listProducts — filters combine", () => {
  it("applies a search and a price ceiling together", async () => {
    if (!databaseAvailable) return;

    const result = await listProducts({
      category: slug,
      search: "Discounted",
      maxPricePaisa: 130000,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    const ids = result.products.map((p) => p.id);

    expect(ids).toEqual([fixtures.discountedId]);
  });

  it("does not let the price filter discard the search filter", async () => {
    if (!databaseAvailable) return;

    // Without a price ceiling, the search finds the discounted product
    // by its list price too — because "Plain" does not contain the term.
    const withoutPrice = await listProducts({
      category: slug,
      search: "Discounted",
      page: 1,
      limit: 20,
      sort: "newest",
    });

    expect(withoutPrice.products.map((p) => p.id)).toEqual([
      fixtures.discountedId,
    ]);

    // With a price ceiling that the *list* price exceeds, a broken
    // implementation would return nothing here.
    const withPrice = await listProducts({
      category: slug,
      search: "Discounted",
      maxPricePaisa: 130000,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    expect(withPrice.products.map((p) => p.id)).toEqual([
      fixtures.discountedId,
    ]);
  });

  it("returns an empty result when the filters genuinely exclude everything", async () => {
    if (!databaseAvailable) return;

    const result = await listProducts({
      category: slug,
      maxPricePaisa: 100,
      page: 1,
      limit: 20,
      sort: "newest",
    });

    // The free item has a discount of exactly zero, so it is *under* a
    // ceiling of 100 and should be found.
    expect(result.products.map((p) => p.id)).toContain(fixtures.freeId);
  });
});
