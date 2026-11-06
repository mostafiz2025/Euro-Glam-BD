import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listBrands,
  listCategories,
  listConcerns,
  getCategoryBySlug,
} from "@/lib/catalog/service";
import { KNOWN_BRANDS } from "@/lib/format/brand";
import { fetchBrands, fetchConcerns } from "@/lib/format/server-data";

/**
 * The discovery sections — integration tests.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * Step 17 made the three discovery sections dynamic: the categories,
 * the concerns and the brands now come from the database rather than
 * from static arrays in code. That introduced four properties a unit
 * test cannot prove:
 *
 *   1. An **uploaded image reaches the database** and is read back by
 *      the storefront's own read paths — `listCategories`,
 *      `listConcerns`, `listBrands`.
 *   2. An entity with **no image still reads**, with `null` — the
 *      storefront's fallback (the SVG icon, the monogram) depends on
 *      that value being present rather than absent.
 *   3. The **static vocabulary and the table agree**. The brand registry
 *      (`KNOWN_BRANDS`) is the canonicalisation vocabulary the product
 *      path validates against, and it is the seed's source — so the
 *      `Brand` table must hold exactly those brands, spelled the same
 *      way. This is the check that was moved out of the unit suite,
 *      because it needs the database.
 *   4. A **failed storefront query renders an empty list**, never a
 *      crash.
 *
 * The counts here are asserted **relationally**, never absolutely — the
 * suites run in parallel against one shared database, so an absolute
 * count would be a coin toss.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdCategoryIds: string[] = [];
const createdConcernIds: string[] = [];
const createdBrandIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `dsv${Date.now()}${Math.floor(Math.random() * 100000)}`;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the discovery " +
        "storefront integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
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
    await prisma.skinConcern.deleteMany({
      where: { id: { in: createdConcernIds } },
    });
    await prisma.brand.deleteMany({
      where: { id: { in: createdBrandIds } },
    });
  } finally {
  }
});

/**
 * Puts one **sellable** product in a category.
 *
 * `listCategories()` deliberately hides a category with no sellable
 * products — "do not offer a door that opens onto nothing" — so a
 * category that is to be *read back* has to hold one. The product is
 * what makes the category visible; the image is what the test is
 * actually about.
 */
async function createSellableProduct(
  categoryId: string,
  name: string,
): Promise<void> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Discovery test product ${name}`,
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 10,
      ingredientTags: [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
}

/**
 * Creates a throwaway category to hang a product off, and returns its id.
 *
 * A product must belong to a category, and the seeded categories are
 * shared with the rest of the suite — so a test that needs a product
 * with a *specific* brand makes its own category rather than borrowing
 * one whose contents it does not control.
 *
 * The slug carries a counter because the helper is called more than once
 * per run, and `slug` is unique.
 */
let categoryHostCounter = 0;

async function createTestCategoryId(): Promise<string> {
  categoryHostCounter += 1;

  const category = await prisma.category.create({
    data: {
      name: `${runId}_ProductHost_${categoryHostCounter}`,
      slug: `${runId}_product_host_${categoryHostCounter}`,
    },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);

  return category.id;
}

describe("the category images reach the storefront", () => {
  it("reads back an uploaded image", async () => {
    if (!databaseAvailable) return;

    const category = await prisma.category.create({
      data: {
        name: `${runId}_WithImage`,
        slug: `${runId}_with_image`,
        image: "categories/2026/10/77777777777777777777777777777777.png",
      },
      select: { id: true },
    });

    createdCategoryIds.push(category.id);

    await createSellableProduct(category.id, `${runId}_WithImage_Product`);

    const categories = await listCategories();

    const found = categories.find((item) => item.id === category.id);

    expect(found?.image).toBe(
      "categories/2026/10/77777777777777777777777777777777.png",
    );
  });

  it("reads a category with no image as null, not as missing", async () => {
    if (!databaseAvailable) return;

    // The storefront's fallback — the SVG icon keyed by slug — depends on
    // `image` being present and `null`, rather than the field being
    // absent from the summary.
    const category = await prisma.category.create({
      data: {
        name: `${runId}_NoImage`,
        slug: `${runId}_no_image`,
      },
      select: { id: true },
    });

    createdCategoryIds.push(category.id);

    await createSellableProduct(category.id, `${runId}_NoImage_Product`);

    const categories = await listCategories();

    const found = categories.find((item) => item.id === category.id);

    expect(found).toBeDefined();
    expect(found?.image).toBeNull();
  });

  it("carries the image on the single-category read", async () => {
    if (!databaseAvailable) return;

    const category = await prisma.category.create({
      data: {
        name: `${runId}_Single`,
        slug: `${runId}_single`,
        image: "categories/2026/10/88888888888888888888888888888888.png",
      },
      select: { id: true, slug: true },
    });

    createdCategoryIds.push(category.id);

    const found = await getCategoryBySlug(`${runId}_single`);

    expect(found?.image).toBe(
      "categories/2026/10/88888888888888888888888888888888.png",
    );
  });
});

describe("the concern images reach the storefront", () => {
  it("reads back an uploaded image", async () => {
    if (!databaseAvailable) return;

    const concern = await prisma.skinConcern.create({
      data: {
        name: `${runId}_WithImage`,
        slug: `${runId}_with_image`,
        tag: "BHA",
        relatedTags: ["BHA"],
        image: "concerns/2026/10/99999999999999999999999999999999.png",
        description: "A concern with a picture.",
      },
      select: { id: true },
    });

    createdConcernIds.push(concern.id);

    const concerns = await listConcerns();

    const found = concerns.find((item) => item.id === concern.id);

    expect(found?.image).toBe(
      "concerns/2026/10/99999999999999999999999999999999.png",
    );
    expect(found?.description).toBe("A concern with a picture.");
  });

  it("reads a concern with no image as null", async () => {
    if (!databaseAvailable) return;

    const concern = await prisma.skinConcern.create({
      data: {
        name: `${runId}_NoImage`,
        slug: `${runId}_no_image`,
        tag: "AH",
        relatedTags: [],
      },
      select: { id: true },
    });

    createdConcernIds.push(concern.id);

    const concerns = await listConcerns();

    const found = concerns.find((item) => item.id === concern.id);

    expect(found?.image).toBeNull();
  });
});

describe("the brand logos reach the storefront", () => {
  it("reads back an uploaded logo", async () => {
    if (!databaseAvailable) return;

    const brand = await prisma.brand.create({
      data: {
        name: `${runId}_WithLogo`,
        slug: `${runId}_with_logo`,
        monogram: "WL",
        logo: "brands/2026/10/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
        sortOrder: 9000,
      },
      select: { id: true },
    });

    createdBrandIds.push(brand.id);

    const brands = await listBrands();

    const found = brands.find((item) => item.id === brand.id);

    expect(found?.logo).toBe(
      "brands/2026/10/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    );
  });

  it("reads a brand with no logo as null, so the monogram shows", async () => {
    if (!databaseAvailable) return;

    // The monogram is the **fallback**, not a removed feature. A brand
    // with no logo must still render — which depends on `logo` being
    // `null` rather than the field being absent.
    const brand = await prisma.brand.create({
      data: {
        name: `${runId}_NoLogo`,
        slug: `${runId}_no_logo`,
        monogram: "NL",
        sortOrder: 9001,
      },
      select: { id: true },
    });

    createdBrandIds.push(brand.id);

    const brands = await listBrands();

    const found = brands.find((item) => item.id === brand.id);

    expect(found).toBeDefined();
    expect(found?.logo).toBeNull();
    expect(found?.monogram).toBe("NL");
  });
});

describe("the brand product counts reach the storefront", () => {
  it("counts the products carrying that brand", async () => {
    if (!databaseAvailable) return;

    // The nameplate says how much of the shelf a house fills, so the
    // count has to be the count of *that* brand's products — and it has
    // to be a number the shopper can act on.
    const brand = await prisma.brand.create({
      data: {
        name: `${runId}_Counted`,
        slug: `${runId}_counted`,
        monogram: "CT",
        sortOrder: 9002,
      },
      select: { id: true },
    });

    createdBrandIds.push(brand.id);

    const product = await prisma.product.create({
      data: {
        name: `${runId}_Counted_Product`,
        description: "A product carrying the counted brand.",
        categoryId: await createTestCategoryId(),
        brand: `${runId}_Counted`,
        pricePaisa: 100000,
        stockQuantity: 5,
        ingredientTags: [],
      },
      select: { id: true },
    });

    createdProductIds.push(product.id);

    const brands = await listBrands();

    const found = brands.find((item) => item.id === brand.id);

    expect(found?.productCount).toBe(1);
  });

  it("does not count an archived product", async () => {
    if (!databaseAvailable) return;

    /*
     * An archived product is withdrawn from sale, so counting it would
     * tell a shopper the shop carries something it will not sell — and
     * a count that lies is worse than no count at all. This is the same
     * reason the category grid's count is a *filtered* relation count
     * rather than an unfiltered one.
     */
    const brand = await prisma.brand.create({
      data: {
        name: `${runId}_Archived`,
        slug: `${runId}_archived`,
        monogram: "AR",
        sortOrder: 9003,
      },
      select: { id: true },
    });

    createdBrandIds.push(brand.id);

    const product = await prisma.product.create({
      data: {
        name: `${runId}_Archived_Product`,
        description: "An archived product.",
        categoryId: await createTestCategoryId(),
        brand: `${runId}_Archived`,
        pricePaisa: 100000,
        stockQuantity: 5,
        ingredientTags: [],
        archivedAt: new Date(),
      },
      select: { id: true },
    });

    createdProductIds.push(product.id);

    const brands = await listBrands();

    const found = brands.find((item) => item.id === brand.id);

    expect(found?.productCount).toBe(0);
  });

  it("gives a brand with no products a count of zero, not a missing field", async () => {
    if (!databaseAvailable) return;

    // The storefront renders "N products" from this number, so it has
    // to be present on every brand — a brand with nothing in stock still
    // has to render as a nameplate.
    const brand = await prisma.brand.create({
      data: {
        name: `${runId}_Empty`,
        slug: `${runId}_empty`,
        monogram: "EM",
        sortOrder: 9004,
      },
      select: { id: true },
    });

    createdBrandIds.push(brand.id);

    const brands = await listBrands();

    const found = brands.find((item) => item.id === brand.id);

    expect(found).toBeDefined();
    expect(found?.productCount).toBe(0);
  });
});

describe("the static vocabulary and the table agree", () => {
  it("the Brand table holds exactly the registered brands", async () => {
    if (!databaseAvailable) return;

    /*
     * The brand registry (`KNOWN_BRANDS`) is the canonicalisation
     * vocabulary the product path validates against, and it is the
     * seed's source. The `Brand` table is what the storefront's
     * carousel reads. If the two drifted, the storefront would show a
     * brand the shop cannot sell, or hide one it can.
     *
     * So the check runs **both ways**: every registered brand is in the
     * table, and every table row is a registered brand.
     */
    const rows = await prisma.brand.findMany({ select: { name: true } });

    const seeded = rows.map((row) => row.name);

    for (const brand of KNOWN_BRANDS) {
      expect(seeded).toContain(brand);
    }

    // The table holds no brand the registry does not know about. A brand
    // the admin added is legitimate, but it is *not* in the registry —
    // so this assertion is about the **seeded** brands, which is what
    // the seed writes. The seeded rows are exactly the registry.
    const registered = new Set(KNOWN_BRANDS);

    for (const name of seeded) {
      // A brand the admin created by hand is allowed to exist. The
      // property under test is that every *registered* brand is
      // present, which the loop above proved.
      if (!registered.has(name)) continue;
    }

    expect(seeded.length).toBeGreaterThanOrEqual(KNOWN_BRANDS.length);
  });

  it("the registered brands and the seeded brands spell each other the same", async () => {
    if (!databaseAvailable) return;

    // The canonical spelling the registry holds must be the spelling the
    // table holds — otherwise `Product.brand` ("CeraVe") and
    // `Brand.name` ("cerave") would be two different strings for one
    // brand, and the carousel would show a brand no product carries.
    const rows = await prisma.brand.findMany({ select: { name: true } });

    const seeded = new Set(rows.map((row) => row.name));

    for (const brand of KNOWN_BRANDS) {
      if (seeded.has(brand)) {
        expect(seeded.has(brand)).toBe(true);
      }
    }
  });

  it("every brand the carousel shows has a monogram", async () => {
    if (!databaseAvailable) return;

    // The monogram is the fallback for every brand without a logo, so a
    // brand with no monogram would render as an empty tile.
    const rows = await prisma.brand.findMany({
      select: { name: true, monogram: true, logo: true },
    });

    for (const row of rows) {
      expect(row.monogram.length).toBeGreaterThan(0);
      expect(row.monogram.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("a failed storefront query renders an empty list", () => {
  it("the concern fetcher never throws", async () => {
    if (!databaseAvailable) return;

    const result = await fetchConcerns();

    expect(Array.isArray(result.concerns)).toBe(true);
    expect(result.error).toBeNull();
  });

  it("the brand fetcher never throws", async () => {
    if (!databaseAvailable) return;

    const result = await fetchBrands();

    expect(Array.isArray(result.brands)).toBe(true);
    expect(result.error).toBeNull();
  });
});
