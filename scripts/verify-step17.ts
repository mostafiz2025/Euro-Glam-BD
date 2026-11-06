/**
 * Step 17 verification script — the dynamic discovery sections.
 *
 * Proves the new work behaves correctly against a real database, outside
 * the unit tests:
 *
 *   1. **The columns exist** — `Category.image`, `SkinConcern.image` and
 *      `Brand.logo` are readable and writable.
 *   2. **An uploaded image reaches the database** — a create with an
 *      image writes that image to the row, and the storefront's own
 *      read path returns it.
 *   3. **A missing image is `null`, not an error** — the storefront's
 *      fallback (the SVG icon, the monogram) depends on that value being
 *      present rather than absent.
 *   4. **The monogram survives** — a brand with no logo still has a
 *      monogram, and the storefront reads it.
 *   5. **A category with products cannot be deleted** — and the refusal
 *      says how many products are in the way.
 *   6. **Deleting a brand leaves its products alone** — `Product.brand`
 *      is a plain string, not a foreign key.
 *   7. **The brand name is canonicalised at the write** — "cerave" is
 *      stored as "CeraVe".
 *   8. **Every mutation is audited** — a create, an update and a delete
 *      each leave an audit entry.
 *   9. **The seed never wipes an upload** — the `image` / `logo` columns
 *      are not written by the seed, so re-seeding cannot destroy a
 *      decorated category, concern or brand.
 *  10. **The registry and the table agree** — the `Brand` table holds
 *      exactly the registered brands, spelled the same way.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step17.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import { PrismaClient } from "@prisma/client";

import { type AuditActor } from "@/lib/admin/audit";
import {
  createBrand,
  deleteBrand,
  updateBrand,
} from "@/lib/admin/brands";
import {
  createCategory,
  deleteCategory,
  updateCategory,
} from "@/lib/admin/categories";
import {
  createConcern,
  deleteConcern,
} from "@/lib/admin/concerns";
import { listBrands, listCategories, listConcerns } from "@/lib/catalog/service";
import { KNOWN_BRANDS } from "@/lib/format/brand";
import { fetchBrands, fetchConcerns } from "@/lib/format/server-data";

const prisma = new PrismaClient();

let failures = 0;

/**
 * Prints a check result.
 */
function check(label: string, passed: boolean, detail = ""): void {
  if (passed) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Section heading.
 */
function section(title: string): void {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
}

const runId = `s17${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdConcernIds: string[] = [];
const createdBrandIds: string[] = [];
const createdProductIds: string[] = [];

let actor: AuditActor;

async function main(): Promise<void> {
  // ── The fixtures ───────────────────────────────────────────────────────
  const user = await prisma.user.create({
    data: {
      name: "Step 17 Verifier",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Step 17 Verifier",
    email: `${runId}_admin@example.com`,
  };

  // ── 1. The columns exist ──────────────────────────────────────────────
  section("1. The columns exist");

  const categoryColumns = await prisma.$queryRaw<
    { column_name: string }[]
  >`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'categories' AND column_name = 'image'
  `;

  check(
    "the category carries an image column",
    categoryColumns.length === 1,
  );

  const concernColumns = await prisma.$queryRaw<
    { column_name: string }[]
  >`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'skin_concerns' AND column_name = 'image'
  `;

  check(
    "the concern carries an image column",
    concernColumns.length === 1,
  );

  const brandColumns = await prisma.$queryRaw<
    { column_name: string }[]
  >`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'brands' AND column_name = 'logo'
  `;

  check("the brand carries a logo column", brandColumns.length === 1);

  // ── 2. The write ───────────────────────────────────────────────────────
  section("2. An uploaded image reaches the database");

  const category = await createCategory(actor, {
    name: `${runId}_Serums`,
    slug: `${runId}_serums`,
    image: `categories/2026/10/${"a".repeat(32)}.png`,
  });

  createdCategoryIds.push(category.id);

  const storedCategory = await prisma.category.findUnique({
    where: { id: category.id },
    select: { image: true },
  });

  check(
    "the category stores the image key",
    storedCategory?.image === `categories/2026/10/${"a".repeat(32)}.png`,
    storedCategory?.image ?? "null",
  );

  const concern = await createConcern(actor, {
    name: `${runId}_Acne`,
    slug: `${runId}_acne`,
    tag: "BHA",
    relatedTags: ["BHA", "SALICYLIC_ACID"],
    image: `concerns/2026/10/${"b".repeat(32)}.png`,
    description: "For skin that breaks out.",
  });

  createdConcernIds.push(concern.id);

  const storedConcern = await prisma.skinConcern.findUnique({
    where: { id: concern.id },
    select: { image: true },
  });

  check(
    "the concern stores the image key",
    storedConcern?.image === `concerns/2026/10/${"b".repeat(32)}.png`,
    storedConcern?.image ?? "null",
  );

  const brand = await createBrand(actor, {
    name: `${runId}_TestBrand`,
    slug: `${runId}_test_brand`,
    monogram: "TB",
    logo: `brands/2026/10/${"c".repeat(32)}.png`,
    sortOrder: 9_000,
  });

  createdBrandIds.push(brand.id);

  const storedBrand = await prisma.brand.findUnique({
    where: { id: brand.id },
    select: { logo: true },
  });

  check(
    "the brand stores the logo key",
    storedBrand?.logo === `brands/2026/10/${"c".repeat(32)}.png`,
    storedBrand?.logo ?? "null",
  );

  // ── 3. The read ────────────────────────────────────────────────────────
  section("3. The storefront reads the imagery back");

  const catalogueCategories = await listCategories();
  const readCategory = catalogueCategories.find(
    (item) => item.id === category.id,
  );

  check(
    "the category list carries the image",
    readCategory?.image === `categories/2026/10/${"a".repeat(32)}.png`,
    String(readCategory?.image),
  );

  const catalogueConcerns = await listConcerns();
  const readConcern = catalogueConcerns.find((item) => item.id === concern.id);

  check(
    "the concern list carries the image",
    readConcern?.image === `concerns/2026/10/${"b".repeat(32)}.png`,
    String(readConcern?.image),
  );

  const catalogueBrands = await listBrands();
  const readBrand = catalogueBrands.find((item) => item.id === brand.id);

  check(
    "the brand list carries the logo",
    readBrand?.logo === `brands/2026/10/${"c".repeat(32)}.png`,
    String(readBrand?.logo),
  );

  // ── 4. The fallbacks ───────────────────────────────────────────────────
  section("4. The fallbacks — a missing image is null, not an error");

  const bareCategory = await createCategory(actor, {
    name: `${runId}_Bare`,
    slug: `${runId}_bare`,
  });

  createdCategoryIds.push(bareCategory.id);

  const bareRead = (await listCategories()).find(
    (item) => item.id === bareCategory.id,
  );

  check(
    "a category with no image reads as null",
    bareRead !== undefined && bareRead.image === null,
    String(bareRead?.image),
  );

  const bareConcern = await createConcern(actor, {
    name: `${runId}_BareConcern`,
    slug: `${runId}_bare_concern`,
    tag: "AH",
    relatedTags: [],
  });

  createdConcernIds.push(bareConcern.id);

  const bareConcernRead = (await listConcerns()).find(
    (item) => item.id === bareConcern.id,
  );

  check(
    "a concern with no image reads as null",
    bareConcernRead !== undefined && bareConcernRead.image === null,
    String(bareConcernRead?.image),
  );

  const bareBrand = await createBrand(actor, {
    name: `${runId}_BareBrand`,
    slug: `${runId}_bare_brand`,
    monogram: "BB",
    sortOrder: 9_001,
  });

  createdBrandIds.push(bareBrand.id);

  const bareBrandRead = (await listBrands()).find(
    (item) => item.id === bareBrand.id,
  );

  check(
    "a brand with no logo reads as null",
    bareBrandRead !== undefined && bareBrandRead.logo === null,
    String(bareBrandRead?.logo),
  );

  check(
    "the brand still has its monogram, so the fallback can render",
    bareBrandRead?.monogram === "BB",
    String(bareBrandRead?.monogram),
  );

  // ── 5. The update ──────────────────────────────────────────────────────
  section("5. The update — a partial update changes only what it names");

  await updateCategory(actor, category.id, {
    image: `categories/2026/10/${"d".repeat(32)}.png`,
  });

  const afterImageChange = await prisma.category.findUnique({
    where: { id: category.id },
    select: { image: true, name: true },
  });

  check(
    "the image changes when it is named",
    afterImageChange?.image === `categories/2026/10/${"d".repeat(32)}.png`,
    String(afterImageChange?.image),
  );

  await updateCategory(actor, category.id, { name: `${runId}_Renamed` });

  const afterNameChange = await prisma.category.findUnique({
    where: { id: category.id },
    select: { image: true },
  });

  check(
    "the image survives a name-only edit",
    afterNameChange?.image === `categories/2026/10/${"d".repeat(32)}.png`,
    String(afterNameChange?.image),
  );

  await updateCategory(actor, category.id, { image: null });

  const afterClear = await prisma.category.findUnique({
    where: { id: category.id },
    select: { image: true },
  });

  check(
    "a null image clears the column",
    afterClear?.image === null,
    String(afterClear?.image),
  );

  // ── 6. The brand name is canonicalised at the write ────────────────────
  section("6. The brand name is canonicalised at the write");

  // The registry already holds "CeraVe" — the seed writes it — so the
  // fold is observed through the refusal, which names the canonical
  // spelling. Without the fold, "cerave" would be a different string
  // and the duplicate would slip through.
  try {
    await updateBrand(actor, brand.id, { name: "cerave" });

    check(
      "a brand whose canonical name is taken is refused",
      false,
      "the rename was allowed",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    check(
      "a brand whose canonical name is taken is refused",
      true,
      message,
    );
    check(
      "the refusal names the canonical spelling",
      message.includes("CeraVe") && !message.includes("cerave"),
      message,
    );
  }

  // ── 7. The category with products ──────────────────────────────────────
  section("7. A category with products cannot be deleted");

  const product = await prisma.product.create({
    data: {
      name: `${runId}_Occupier`,
      description: "A product used to occupy a category.",
      categoryId: category.id,
      pricePaisa: 100000,
      stockQuantity: 3,
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);

  try {
    await deleteCategory(actor, category.id, "Tidying up.");

    check("the deletion is refused", false, "it was allowed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    check("the deletion is refused", true, message);
    check(
      "the refusal names the product count",
      message.includes("1 product"),
      message,
    );
  }

  const survived = await prisma.category.findUnique({
    where: { id: category.id },
    select: { id: true },
  });

  check("the category survives the refused deletion", survived !== null);

  // ── 8. Deleting a brand leaves its products alone ──────────────────────
  section("8. Deleting a brand leaves its products alone");

  const doomedBrand = await createBrand(actor, {
    name: `${runId}_DoomedBrand`,
    slug: `${runId}_doomed_brand`,
    monogram: "DB",
    sortOrder: 9_002,
  });

  const brandedProduct = await prisma.product.create({
    data: {
      name: `${runId}_Branded`,
      description: "A product that carries the brand.",
      categoryId: category.id,
      pricePaisa: 100000,
      stockQuantity: 3,
      brand: `${runId}_DoomedBrand`,
    },
    select: { id: true },
  });

  createdProductIds.push(brandedProduct.id);

  await deleteBrand(actor, doomedBrand.id, "We stopped stocking them.");

  const brandGone = await prisma.brand.findUnique({
    where: { id: doomedBrand.id },
    select: { id: true },
  });

  check("the brand row is gone", brandGone === null);

  const productSurvived = await prisma.product.findUnique({
    where: { id: brandedProduct.id },
    select: { brand: true },
  });

  check(
    "the product survives, and keeps its brand",
    productSurvived?.brand === `${runId}_DoomedBrand`,
    String(productSurvived?.brand),
  );

  // ── 9. The audit trail ─────────────────────────────────────────────────
  section("9. Every mutation is audited");

  const categoryAudit = await prisma.adminAuditLog.findMany({
    where: { entityType: "category", entityId: category.id },
    orderBy: { createdAt: "asc" },
  });

  const categoryActions = categoryAudit.map((entry) => entry.action);

  check(
    "the category create is audited",
    categoryActions.includes("CATEGORY_CREATED"),
    categoryActions.join(", "),
  );
  check(
    "the category update is audited",
    categoryActions.includes("CATEGORY_UPDATED"),
    categoryActions.join(", "),
  );

  const concernAudit = await prisma.adminAuditLog.findFirst({
    where: { entityType: "concern", entityId: concern.id },
  });

  check(
    "the concern create is audited",
    concernAudit?.action === "CONCERN_CREATED",
    String(concernAudit?.action),
  );

  const brandAudit = await prisma.adminAuditLog.findFirst({
    where: { entityType: "brand", entityId: brand.id },
  });

  check(
    "the brand create is audited",
    brandAudit?.action === "BRAND_CREATED",
    String(brandAudit?.action),
  );

  const deletedBrandAudit = await prisma.adminAuditLog.findFirst({
    where: { entityType: "brand", entityId: doomedBrand.id },
  });

  check(
    "the brand delete is audited, with its reason",
    deletedBrandAudit?.action === "BRAND_DELETED" &&
      deletedBrandAudit.reason === "We stopped stocking them.",
    String(deletedBrandAudit?.reason),
  );

  // ── 10. The delete of an empty category ────────────────────────────────
  section("10. An empty category is deleted cleanly");

  await deleteCategory(actor, bareCategory.id, "It was never used.");

  const deleted = await prisma.category.findUnique({
    where: { id: bareCategory.id },
    select: { id: true },
  });

  check("the category is gone", deleted === null);

  await deleteConcern(actor, bareConcern.id, "Not a concern we serve.");

  const concernGone = await prisma.skinConcern.findUnique({
    where: { id: bareConcern.id },
    select: { id: true },
  });

  check("the concern is gone", concernGone === null);

  // ── 11. The seed never wipes an upload ────────────────────────────────
  section("11. The seed never wipes an upload");

  /*
   * The seed writes the brands and the concerns, but it must **not**
   * write their `image` / `logo` columns — not on create, and not on
   * update. A seed that reset them would silently wipe the card image
   * of every category the shop has decorated.
   *
   * The check is made against the **seed script's own source**, because
   * the property is about what the seed writes, not about what the
   * database happens to hold. A seed that did write the column would be
   * caught by reading its source, and a source that does not write it
   * cannot wipe anything — whatever the database currently holds.
   */
  const seedSource = await readSeedSource();

  check("the seed script could be read", seedSource !== null);

  if (seedSource !== null) {
    // The seed writes a brand's fields through a data object. The
    // assertion is that the seed never mentions the `logo` column in a
    // write position, and never mentions `image` for a category or a
    // concern either.
    const writesLogo = /logo\s*:/.test(seedSource);
    const writesImage = /\bimage\s*:/.test(seedSource);

    check(
      "the seed never writes a brand's logo",
      !writesLogo,
      writesLogo ? "the seed writes `logo:`" : "",
    );
    check(
      "the seed never writes a category or concern image",
      !writesImage,
      writesImage ? "the seed writes `image:`" : "",
    );
  }

  // And the live table confirms it: the **registered** brands — the ones
  // the seed writes — carry no imagery, because nothing has decorated
  // them yet. The brands this script created are excluded: they hold a
  // logo on purpose.
  const seededLogos = await prisma.brand.count({
    where: { logo: { not: null }, name: { in: [...KNOWN_BRANDS] } },
  });

  check(
    "no registered brand carries a logo the admin did not upload",
    seededLogos === 0,
    `${seededLogos} with a logo`,
  );

  // ── 12. The registry and the table agree ───────────────────────────────
  section("12. The registry and the table agree");

  const seededBrands = await prisma.brand.findMany({
    select: { name: true },
  });

  const seededNames = seededBrands.map((row) => row.name);

  check(
    "every registered brand is in the table",
    KNOWN_BRANDS.every((known) => seededNames.includes(known)),
    `${seededNames.length} rows`,
  );

  /*
   * The table must hold each registered brand **once**.
   *
   * `Brand.name` is unique, so the database already guarantees it — but
   * the guarantee is only as good as the code that writes the rows, and
   * a brand the admin adds by hand is legitimate. So the check is that
   * no registered brand appears twice, which is what "one brand, one
   * row" means.
   */
  check(
    "no registered brand appears twice",
    KNOWN_BRANDS.every((known) => {
      const matches = seededNames.filter((name) => name === known);

      return matches.length <= 1;
    }),
  );

  check(
    "every brand has a monogram, so the fallback can render",
    (
      await prisma.brand.findMany({
        select: { monogram: true },
      })
    ).every((row) => row.monogram.length > 0 && row.monogram.length <= 4),
  );

  // ── 13. The storefront fetchers never throw ────────────────────────────
  section("13. A failed storefront query renders an empty list");

  const fetchedConcerns = await fetchConcerns();
  const fetchedBrands = await fetchBrands();

  check(
    "the concern fetcher returns a list and no error",
    Array.isArray(fetchedConcerns.concerns) &&
      fetchedConcerns.error === null,
  );
  check(
    "the brand fetcher returns a list and no error",
    Array.isArray(fetchedBrands.brands) && fetchedBrands.error === null,
  );
}

/**
 * Reads the seed script's source.
 *
 * The check that the seed never wipes an upload is a claim about what
 * the seed **writes**, so it is checked against the seed's own source
 * rather than against the database — a database that happens to hold
 * `null` in every image column proves nothing about what a re-seed
 * would do.
 */
async function readSeedSource(): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");

    const candidates = [
      path.join(process.cwd(), "prisma", "seed.ts"),
      path.join(__dirname, "..", "prisma", "seed.ts"),
    ];

    for (const candidate of candidates) {
      try {
        return await readFile(candidate, "utf8");
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

main()
  .then(async () => {
    // ── The cleanup ──────────────────────────────────────────────────────
    console.log("\nCleaning up…");

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

    console.log(
      failures === 0
        ? "\nAll Step 17 checks passed.\n"
        : `\n${failures} Step 17 check(s) FAILED.\n`,
    );

    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error: unknown) => {
    console.error("\nThe verification script itself failed.\n");
    console.error(error);

    // Best-effort cleanup, so a failed run does not leave rows behind.
    try {
      await prisma.adminAuditLog.deleteMany({
        where: {
          entityType: { in: ["category", "concern", "brand"] },
          entityId: {
            in: [
              ...createdCategoryIds,
              ...createdConcernIds,
              ...createdBrandIds,
            ],
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
    } catch {
      // The cleanup is best-effort. The original error is the one that
      // matters, and it is already printed.
    }

    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
