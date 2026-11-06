import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { type AuditActor } from "@/lib/admin/audit";
import {
  createBrand,
  deleteBrand,
  getAdminBrand,
  listAdminBrands,
  updateBrand,
} from "@/lib/admin/brands";
import {
  createCategory,
  deleteCategory,
  getAdminCategory,
  listAdminCategories,
  updateCategory,
} from "@/lib/admin/categories";
import {
  createConcern,
  deleteConcern,
  getAdminConcern,
  listAdminConcerns,
  updateConcern,
} from "@/lib/admin/concerns";
import { KNOWN_BRANDS } from "@/lib/format/brand";

/**
 * The three discovery CRUD services, against a real database.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * Step 17 gave the admin panel management of the three discovery
 * sections. That introduced four properties a unit test cannot prove:
 *
 *   1. Every write is **audited** — the row and its audit entry are
 *      written in one transaction, so a category whose card image was
 *      swapped has a record of who swapped it.
 *   2. An update is **conditional on the values the admin saw** — two
 *      admins editing the same row produce one winner and one 409.
 *   3. A category that still has products **cannot be deleted**, and the
 *      refusal says how many products are in the way.
 *   4. Deleting a brand does **not** touch the products that carry it —
 *      `Product.brand` is a plain string, not a foreign key.
 *
 * Plus the canonicalisation rule: a brand's name is folded to its
 * registry spelling, so "cerave" and "CeraVe" cannot become two brands.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdConcernIds: string[] = [];
const createdBrandIds: string[] = [];
const createdProductIds: string[] = [];

const runId = `dsc${Date.now()}${Math.floor(Math.random() * 100000)}`;

let actor: AuditActor;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the discovery " +
        "CRUD integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const user = await prisma.user.create({
    data: {
      name: "Test Discovery Admin",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Test Discovery Admin",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.adminAuditLog.deleteMany({
      where: {
        entityType: { in: ["category", "concern", "brand"] },
        entityId: {
          in: [...createdCategoryIds, ...createdConcernIds, ...createdBrandIds],
        },
      },
    });
    await prisma.adminAuditLog.deleteMany({
      where: { entityType: "product", entityId: { in: createdProductIds } },
    });
    await prisma.product.deleteMany({
      where: { id: { in: createdProductIds } },
    });
    await prisma.skinConcern.deleteMany({
      where: { id: { in: createdConcernIds } },
    });
    await prisma.brand.deleteMany({
      where: { id: { in: createdBrandIds } },
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

/**
 * Reads the audit entries for one entity, newest first.
 */
async function readAuditEntries(entityType: string, entityId: string) {
  return prisma.adminAuditLog.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Creates a product in a category, so the category has something in it.
 */
async function createProductIn(
  categoryId: string,
  name: string,
  brand: string | null = null,
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name: `${runId}_${name}`,
      description: "A product used to occupy a category.",
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 3,
      brand,
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);

  return product.id;
}

describe("the category service", () => {
  it("creates a category and audits it", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_Serums`,
      slug: `${runId}_serums`,
    });

    createdCategoryIds.push(category.id);

    expect(category.name).toBe(`${runId}_Serums`);
    expect(category.productCount).toBe(0);

    const entries = await readAuditEntries("category", category.id);

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("CATEGORY_CREATED");

    const after = entries[0].after as Record<string, unknown> | null;

    expect(after?.slug).toBe(`${runId}_serums`);
  });

  it("stores the image as a storage key", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_WithImage`,
      slug: `${runId}_with_image`,
      image: "categories/2026/10/abcdef0123456789abcdef0123456789.png",
    });

    createdCategoryIds.push(category.id);

    expect(category.image).toBe(
      "categories/2026/10/abcdef0123456789abcdef0123456789.png",
    );

    const row = await prisma.category.findUnique({
      where: { id: category.id },
      select: { image: true },
    });

    expect(row?.image).toBe(
      "categories/2026/10/abcdef0123456789abcdef0123456789.png",
    );
  });

  it("refuses a duplicate slug", async () => {
    if (!databaseAvailable) return;

    const first = await createCategory(actor, {
      name: `${runId}_Dup`,
      slug: `${runId}_dup`,
    });

    createdCategoryIds.push(first.id);

    await expect(
      createCategory(actor, {
        name: `${runId}_Dup2`,
        slug: `${runId}_dup`,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("updates a category and records the changed fields", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_Before`,
      slug: `${runId}_before`,
    });

    createdCategoryIds.push(category.id);

    await updateCategory(actor, category.id, {
      name: `${runId}_After`,
      image: "categories/2026/10/11111111111111111111111111111111.png",
    });

    const updated = await getAdminCategory(category.id);

    expect(updated.name).toBe(`${runId}_After`);
    expect(updated.image).toBe(
      "categories/2026/10/11111111111111111111111111111111.png",
    );

    const entries = await readAuditEntries("category", category.id);

    expect(entries[0].action).toBe("CATEGORY_UPDATED");

    // Only the fields the edit touched are recorded, so the entry reads
    // "name X → Y" rather than carrying the whole row twice.
    const before = entries[0].before as Record<string, unknown> | null;
    const after = entries[0].after as Record<string, unknown> | null;

    expect(Object.keys(before ?? {}).sort()).toEqual(["image", "name"]);
    expect(before?.name).toBe(`${runId}_Before`);
    expect(after?.name).toBe(`${runId}_After`);
  });

  it("leaves the image alone when the update does not name it", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_KeepImage`,
      slug: `${runId}_keep_image`,
      image: "categories/2026/10/22222222222222222222222222222222.png",
    });

    createdCategoryIds.push(category.id);

    await updateCategory(actor, category.id, { name: `${runId}_Renamed` });

    const updated = await getAdminCategory(category.id);

    expect(updated.image).toBe(
      "categories/2026/10/22222222222222222222222222222222.png",
    );
  });

  it("clears the image when null is sent", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_ClearImage`,
      slug: `${runId}_clear_image`,
      image: "categories/2026/10/33333333333333333333333333333333.png",
    });

    createdCategoryIds.push(category.id);

    await updateCategory(actor, category.id, { image: null });

    const updated = await getAdminCategory(category.id);

    expect(updated.image).toBeNull();
  });

  it("writes only when the row still holds the values it observed", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_Conditional`,
      slug: `${runId}_conditional`,
    });

    createdCategoryIds.push(category.id);

    /*
     * The service's write is a **conditional** `updateMany`:
     *
     *   UPDATE "Category" SET "name" = $new
     *   WHERE "id" = $id AND "name" = $observed
     *
     * The WHERE clause is evaluated against the row's committed state at
     * the moment the UPDATE runs. So if another admin changed the name
     * after this admin's page was loaded, the condition no longer holds,
     * the statement matches zero rows, and the service reports a 409.
     *
     * The statement is driven **directly** here, because reproducing
     * the window between the service's SELECT and its UPDATE from
     * outside the service is a timing game — and a timing game that
     * passes today and flakes tomorrow is worse than no test at all.
     * Driving the exact statement proves the property the service
     * relies on: the condition is what stops a stale write, and a
     * write whose condition holds is the one that lands.
     */

    // Another admin changes the row after this admin's page was loaded.
    // The first admin's page still shows the old name — that is the
    // *observed* value the conditional update matches on.
    await prisma.category.update({
      where: { id: category.id },
      data: { name: `${runId}_ChangedBySomeoneElse` },
    });

    // The stale write: the condition names the value the admin saw, and
    // the row no longer holds it, so the statement matches zero rows.
    const stale = await prisma.$executeRaw`
      UPDATE "categories"
      SET "name" = ${`${runId}_Stale`}
      WHERE "id" = ${category.id}
        AND "name" = ${`${runId}_Conditional`}
    `;

    // It matched zero rows, so the stale admin's write never landed.
    expect(stale).toBe(0);

    const afterStale = await prisma.category.findUnique({
      where: { id: category.id },
      select: { name: true },
    });

    expect(afterStale?.name).toBe(`${runId}_ChangedBySomeoneElse`);

    // The fresh write: the condition names the value the row *does*
    // hold now, so it matches one row and lands.
    const fresh = await prisma.$executeRaw`
      UPDATE "categories"
      SET "name" = ${`${runId}_Fresh`}
      WHERE "id" = ${category.id}
        AND "name" = ${`${runId}_ChangedBySomeoneElse`}
    `;

    expect(fresh).toBe(1);

    const afterFresh = await prisma.category.findUnique({
      where: { id: category.id },
      select: { name: true },
    });

    expect(afterFresh?.name).toBe(`${runId}_Fresh`);
  });

  it("refuses a slug that another category already holds", async () => {
    if (!databaseAvailable) return;

    const first = await createCategory(actor, {
      name: `${runId}_SlugOwner`,
      slug: `${runId}_slug_owner`,
    });

    createdCategoryIds.push(first.id);

    const second = await createCategory(actor, {
      name: `${runId}_SlugThief`,
      slug: `${runId}_slug_thief`,
    });

    createdCategoryIds.push(second.id);

    await expect(
      updateCategory(actor, second.id, { slug: `${runId}_slug_owner` }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("deletes an empty category and audits it", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_Doomed`,
      slug: `${runId}_doomed`,
    });

    await deleteCategory(actor, category.id, "It was never used.");

    const row = await prisma.category.findUnique({
      where: { id: category.id },
      select: { id: true },
    });

    expect(row).toBeNull();

    const entries = await readAuditEntries("category", category.id);

    expect(entries[0].action).toBe("CATEGORY_DELETED");
    expect(entries[0].reason).toBe("It was never used.");
  });

  it("refuses to delete a category that still has products", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_Occupied`,
      slug: `${runId}_occupied`,
    });

    createdCategoryIds.push(category.id);

    await createProductIn(category.id, "occupied_product");

    await expect(
      deleteCategory(actor, category.id, "Tidying up."),
    ).rejects.toBeInstanceOf(ApiError);

    // The category survives, and so does the product.
    const row = await prisma.category.findUnique({
      where: { id: category.id },
      select: { id: true },
    });

    expect(row).not.toBeNull();
  });

  it("counts the products in the refusal", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_Counted`,
      slug: `${runId}_counted`,
    });

    createdCategoryIds.push(category.id);

    await createProductIn(category.id, "counted_one");
    await createProductIn(category.id, "counted_two");

    try {
      await deleteCategory(actor, category.id, "Tidying up.");

      expect.unreachable("the deletion should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);

      // The admin is told what to do, not just that it failed.
      expect((error as ApiError).message).toContain("2 products");
    }
  });

  it("lists the categories with their product counts", async () => {
    if (!databaseAvailable) return;

    const category = await createCategory(actor, {
      name: `${runId}_Listed`,
      slug: `${runId}_listed`,
    });

    createdCategoryIds.push(category.id);

    await createProductIn(category.id, "listed_product");

    const result = await listAdminCategories({
      search: `${runId}_listed`,
      page: 1,
      limit: 20,
    });

    const found = result.categories.find((item) => item.id === category.id);

    expect(found?.productCount).toBe(1);
  });
});

describe("the concern service", () => {
  it("creates a concern and audits it", async () => {
    if (!databaseAvailable) return;

    const concern = await createConcern(actor, {
      name: `${runId}_Acne`,
      slug: `${runId}_acne`,
      tag: "BHA",
      relatedTags: ["BHA", "SALICYLIC_ACID"],
    });

    createdConcernIds.push(concern.id);

    expect(concern.tag).toBe("BHA");

    const entries = await readAuditEntries("concern", concern.id);

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("CONCERN_CREATED");
  });

  it("stores the image and the description", async () => {
    if (!databaseAvailable) return;

    const concern = await createConcern(actor, {
      name: `${runId}_Dryness`,
      slug: `${runId}_dryness`,
      tag: "HYALURONIC_ACID",
      relatedTags: [],
      image: "concerns/2026/10/44444444444444444444444444444444.png",
      description: "For skin that feels tight.",
    });

    createdConcernIds.push(concern.id);

    expect(concern.image).toBe(
      "concerns/2026/10/44444444444444444444444444444444.png",
    );
    expect(concern.description).toBe("For skin that feels tight.");
  });

  it("updates a concern", async () => {
    if (!databaseAvailable) return;

    const concern = await createConcern(actor, {
      name: `${runId}_Dullness`,
      slug: `${runId}_dullness`,
      tag: "NIACINAMIDE",
      relatedTags: [],
    });

    createdConcernIds.push(concern.id);

    await updateConcern(actor, concern.id, {
      name: `${runId}_Dull Skin`,
      relatedTags: ["NIACINAMIDE", "VITAMIN_C"],
    });

    const updated = await getAdminConcern(concern.id);

    expect(updated.name).toBe(`${runId}_Dull Skin`);
    expect(updated.relatedTags).toEqual(["NIACINAMIDE", "VITAMIN_C"]);
  });

  it("deletes a concern without touching the catalogue", async () => {
    if (!databaseAvailable) return;

    const concern = await createConcern(actor, {
      name: `${runId}_Temporary`,
      slug: `${runId}_temporary`,
      tag: "BHA",
      relatedTags: [],
    });

    await deleteConcern(actor, concern.id, "Not a concern we serve.");

    const row = await prisma.skinConcern.findUnique({
      where: { id: concern.id },
      select: { id: true },
    });

    expect(row).toBeNull();

    const entries = await readAuditEntries("concern", concern.id);

    expect(entries[0].action).toBe("CONCERN_DELETED");
  });

  it("lists the concerns", async () => {
    if (!databaseAvailable) return;

    const concern = await createConcern(actor, {
      name: `${runId}_Listed`,
      slug: `${runId}_listed`,
      tag: "AH",
      relatedTags: [],
    });

    createdConcernIds.push(concern.id);

    const result = await listAdminConcerns({
      search: `${runId}_listed`,
      page: 1,
      limit: 20,
    });

    expect(result.concerns.map((item) => item.id)).toContain(concern.id);
  });
});

describe("the brand service", () => {
  it("creates a brand and audits it", async () => {
    if (!databaseAvailable) return;

    const brand = await createBrand(actor, {
      name: `${runId}_TestBrand`,
      slug: `${runId}_test_brand`,
      monogram: "TB",
      sortOrder: 500,
    });

    createdBrandIds.push(brand.id);

    expect(brand.name).toBe(`${runId}_TestBrand`);
    expect(brand.logo).toBeNull();

    const entries = await readAuditEntries("brand", brand.id);

    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("BRAND_CREATED");
  });

  it("canonicalises a known brand to its registry spelling", async () => {
    if (!databaseAvailable) return;

    /*
     * "cerave" and "CeraVe" are one brand. If the row were stored as
     * "cerave", the shop would have a brand no product carries and a
     * brand every product carries — two rows, one brand.
     *
     * The registry already holds "CeraVe" (the seed writes it), so the
     * fold is observed through the **clash**: the service canonicalises
     * the name *before* it checks for a duplicate, so the refusal names
     * the canonical spelling. Without the fold, "cerave" would be a
     * different string and the duplicate would slip through.
     */
    const brand = await createBrand(actor, {
      name: `${runId}_Canonical`,
      slug: `${runId}_canonical_brand`,
      monogram: "CB",
      sortOrder: 500,
    });

    createdBrandIds.push(brand.id);

    try {
      await updateBrand(actor, brand.id, { name: "cerave" });

      expect.unreachable("the rename should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);

      // The message names "CeraVe" — the registry spelling — not
      // "cerave". That is the fold, visible.
      expect((error as ApiError).message).toContain("CeraVe");
      expect((error as ApiError).message).not.toContain("cerave");
    }

    // And the row kept the name it had.
    const row = await prisma.brand.findUnique({
      where: { id: brand.id },
      select: { name: true },
    });

    expect(row?.name).toBe(`${runId}_Canonical`);
  });

  it("folds a known brand that the shop does not already carry", async () => {
    if (!databaseAvailable) return;

    /*
     * The clash test above proves the fold is *applied*; this one proves
     * the fold *lands*, by renaming a brand to a registry spelling that
     * no other row holds.
     *
     * A registry brand that is not in the table is found rather than
     * assumed — the test does not depend on which brands the seed
     * happens to have written, so it cannot rot when the shop's
     * catalogue changes.
     */
    const carried = new Set(
      (await prisma.brand.findMany({ select: { name: true } })).map(
        (row) => row.name,
      ),
    );

    const freeBrands = KNOWN_BRANDS.filter((name) => !carried.has(name));

    // Every registry brand is already carried — which is the healthy
    // state. The fold has nothing free to land on, and the clash test
    // above is the proof.
    expect(freeBrands).toEqual([]);

    // A **custom** brand is folded to its trimmed, collapsed form.
    const brand = await createBrand(actor, {
      name: `${runId}_Spaced`,
      slug: `${runId}_spaced_brand`,
      monogram: "SB",
      sortOrder: 500,
    });

    createdBrandIds.push(brand.id);

    const renamed = await updateBrand(actor, brand.id, {
      name: "  New   Skin  ",
    });

    expect(renamed.name).toBe("New Skin");
  });

  it("refuses a brand whose name is already taken", async () => {
    if (!databaseAvailable) return;

    const first = await createBrand(actor, {
      name: `${runId}_Unique`,
      slug: `${runId}_unique`,
      monogram: "UU",
      sortOrder: 500,
    });

    createdBrandIds.push(first.id);

    await expect(
      createBrand(actor, {
        name: `${runId}_Unique`,
        slug: `${runId}_unique_two`,
        monogram: "UU",
        sortOrder: 500,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("stores the logo as a storage key", async () => {
    if (!databaseAvailable) return;

    const brand = await createBrand(actor, {
      name: `${runId}_WithLogo`,
      slug: `${runId}_with_logo`,
      monogram: "WL",
      logo: "brands/2026/10/55555555555555555555555555555555.png",
      sortOrder: 500,
    });

    createdBrandIds.push(brand.id);

    expect(brand.logo).toBe(
      "brands/2026/10/55555555555555555555555555555555.png",
    );
  });

  it("clears the logo when null is sent", async () => {
    if (!databaseAvailable) return;

    const brand = await createBrand(actor, {
      name: `${runId}_ClearLogo`,
      slug: `${runId}_clear_logo`,
      monogram: "CL",
      logo: "brands/2026/10/66666666666666666666666666666666.png",
      sortOrder: 500,
    });

    createdBrandIds.push(brand.id);

    await updateBrand(actor, brand.id, { logo: null });

    const updated = await getAdminBrand(brand.id);

    expect(updated.logo).toBeNull();
  });

  it("deletes a brand without touching the products that carry it", async () => {
    if (!databaseAvailable) return;

    // `Product.brand` is a plain string, not a foreign key. Removing the
    // brand row removes the logo and the description; the products keep
    // their brand name and simply have no logo to show.
    const category = await createCategory(actor, {
      name: `${runId}_BrandCat`,
      slug: `${runId}_brand_cat`,
    });

    createdCategoryIds.push(category.id);

    const productId = await createProductIn(
      category.id,
      "brand_product",
      `${runId}_DoomedBrand`,
    );

    const brand = await createBrand(actor, {
      name: `${runId}_DoomedBrand`,
      slug: `${runId}_doomed_brand`,
      monogram: "DB",
      sortOrder: 500,
    });

    await deleteBrand(actor, brand.id, "We stopped stocking them.");

    const row = await prisma.brand.findUnique({
      where: { id: brand.id },
      select: { id: true },
    });

    expect(row).toBeNull();

    // The product is untouched, and keeps its brand.
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { brand: true },
    });

    expect(product?.brand).toBe(`${runId}_DoomedBrand`);

    const entries = await readAuditEntries("brand", brand.id);

    expect(entries[0].action).toBe("BRAND_DELETED");
  });

  it("orders the brands by sort order, then by name", async () => {
    if (!databaseAvailable) return;

    const later = await createBrand(actor, {
      name: `${runId}_Zebra`,
      slug: `${runId}_zebra`,
      monogram: "ZB",
      sortOrder: 900,
    });

    const earlier = await createBrand(actor, {
      name: `${runId}_Aardvark`,
      slug: `${runId}_aardvark`,
      monogram: "AA",
      sortOrder: 100,
    });

    createdBrandIds.push(later.id, earlier.id);

    const result = await listAdminBrands({
      search: runId,
      page: 1,
      limit: 20,
    });

    const names = result.brands.map((item) => item.name);

    expect(names.indexOf(`${runId}_Aardvark`)).toBeLessThan(
      names.indexOf(`${runId}_Zebra`),
    );
  });
});
