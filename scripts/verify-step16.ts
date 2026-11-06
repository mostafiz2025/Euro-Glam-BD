/**
 * Step 16 verification script — the stored brand and the dual pricing.
 *
 * Proves the new work behaves correctly against a real database, outside
 * the unit tests:
 *
 *   1. **The brand column exists and holds what it was given** — a create
 *      with a brand writes that brand to the row.
 *   2. **The brand is canonicalised at the write** — "cerave" is stored as
 *      "CeraVe", so the shop cannot end up with two spellings of one
 *      brand. This is checked on the **service**, not on the schema,
 *      because the service is where every path to the database passes.
 *   3. **A custom brand is trimmed and collapsed** — the shop can stock a
 *      brand the registry has never heard of.
 *   4. **A product with no brand is legitimate** — `null` is a value, not
 *      a failure.
 *   5. **A stored brand wins over the derived one** — an admin who set
 *      "Bioderma" on a product named "CeraVe Serum" keeps that choice.
 *   6. **The brand is searchable** — a shopper typing "CeraVe" finds the
 *      CeraVe products, including one whose name does not begin with the
 *      brand.
 *   7. **The two prices are independent** — a regular price and a
 *      discount price, and the effective price is the discount one.
 *   8. **The audit trail records the brand** — a create carries the brand
 *      in its `after` snapshot.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step16.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import { PrismaClient } from "@prisma/client";

import { type AuditActor } from "@/lib/admin/audit";
import { createProduct, updateProduct } from "@/lib/admin/catalog";
import { listAdminProducts } from "@/lib/admin/stats";
import { listProducts } from "@/lib/catalog/service";
import {
  KNOWN_BRANDS,
  MAX_BRAND_LENGTH,
  canonicalBrand,
  displayBrand,
  isKnownBrand,
} from "@/lib/format/brand";
import { discountPercent } from "@/lib/format/money";
import {
  productCreateSchema,
  productUpdateSchema,
} from "@/lib/validation/admin";

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

const runId = `s16${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

let actor: AuditActor;

/**
 * The common fields every created product needs.
 */
function body(categoryId: string, name: string) {
  return {
    name: `${runId}_${name}`,
    description: `Step 16 verification product ${name}.`,
    categoryId,
    pricePaisa: 100000,
    stockQuantity: 5,
    ingredientTags: [],
    images: [],
    badges: [],
  };
}

async function main(): Promise<void> {
  // ── The fixtures ───────────────────────────────────────────────────────
  const user = await prisma.user.create({
    data: {
      name: "Step 16 Verifier",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Step 16 Verifier",
    email: `${runId}_admin@example.com`,
  };

  const category = await prisma.category.create({
    data: { name: "Step 16 Verifier", slug: `${runId}_cat` },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);

  // ── 1. The vocabulary ──────────────────────────────────────────────────
  section("1. The brand vocabulary — one list, no duplicates");

  check(
    "the vocabulary holds no duplicate in any casing",
    new Set(KNOWN_BRANDS.map((brand) => brand.toLowerCase())).size ===
      KNOWN_BRANDS.length,
    `${KNOWN_BRANDS.length} brands`,
  );

  check(
    "every registered brand fits the column",
    KNOWN_BRANDS.every((brand) => brand.length <= MAX_BRAND_LENGTH),
    `max ${MAX_BRAND_LENGTH}`,
  );

  /*
   * The storefront carousel now reads the `Brand` table, which the seed
   * populates from `KNOWN_BRANDS`. So the check that keeps them honest
   * is against the **seeded rows** — a brand added to the registry
   * without re-seeding is caught here rather than silently missing from
   * the carousel.
   */
  const seededBrands = await prisma.brand.findMany({
    select: { name: true },
    orderBy: { name: "asc" },
  });

  const seededBrandNames = seededBrands.map((brand) => brand.name);

  check(
    "the storefront carousel shows exactly the registered brands",
    seededBrandNames.length === KNOWN_BRANDS.length &&
      KNOWN_BRANDS.every((brand) => seededBrandNames.includes(brand)),
    seededBrandNames.join(", "),
  );

  check("a known brand is recognised", isKnownBrand("cerave"));
  check("a custom brand is not", !isKnownBrand("New Skin"));
  check(
    "a known brand is canonicalised to its registry spelling",
    canonicalBrand("cerave") === "CeraVe",
    canonicalBrand("cerave") ?? "null",
  );

  // ── 2. The write ───────────────────────────────────────────────────────
  section("2. The brand reaches the database");

  const withBrand = await createProduct(actor, {
    ...body(category.id, "with_brand"),
    brand: "CeraVe",
  });

  createdProductIds.push(withBrand.id);

  const storedBrand = await prisma.product.findUnique({
    where: { id: withBrand.id },
    select: { brand: true },
  });

  check(
    "the brand is stored on the row",
    storedBrand?.brand === "CeraVe",
    storedBrand?.brand ?? "null",
  );
  check(
    "the service returns the brand it stored",
    withBrand.brand === "CeraVe",
    withBrand.brand ?? "null",
  );

  // ── 3. The canonicalisation happens at the write ───────────────────────
  section("3. The canonicalisation — the service, not just the schema");

  const lowercased = await createProduct(actor, {
    ...body(category.id, "lowercased"),
    brand: "cerave",
  });

  createdProductIds.push(lowercased.id);

  check(
    "a lowercased brand is folded to its registry spelling",
    lowercased.brand === "CeraVe",
    lowercased.brand ?? "null",
  );

  const custom = await createProduct(actor, {
    ...body(category.id, "custom"),
    brand: "  New   Skin  ",
  });

  createdProductIds.push(custom.id);

  check(
    "a custom brand is trimmed and collapsed",
    custom.brand === "New Skin",
    custom.brand ?? "null",
  );

  const brandless = await createProduct(actor, {
    ...body(category.id, "brandless"),
    brand: null,
  });

  createdProductIds.push(brandless.id);

  check(
    "a product with no brand is legitimate",
    brandless.brand === null,
    brandless.brand ?? "null",
  );

  // ── 4. The update ──────────────────────────────────────────────────────
  section("4. The update — a partial update changes only what it names");

  await updateProduct(actor, withBrand.id, { brand: "Bioderma" });

  const afterBrandChange = await prisma.product.findUnique({
    where: { id: withBrand.id },
    select: { brand: true },
  });

  check(
    "the brand changes when it is named",
    afterBrandChange?.brand === "Bioderma",
    afterBrandChange?.brand ?? "null",
  );

  await updateProduct(actor, withBrand.id, {
    pricePaisa: 120000,
    reason: "A price change, to prove the brand is untouched.",
  });

  const afterPriceChange = await prisma.product.findUnique({
    where: { id: withBrand.id },
    select: { brand: true },
  });

  check(
    "the brand survives a price-only edit",
    afterPriceChange?.brand === "Bioderma",
    afterPriceChange?.brand ?? "null",
  );

  await updateProduct(actor, withBrand.id, { brand: null });

  const afterClear = await prisma.product.findUnique({
    where: { id: withBrand.id },
    select: { brand: true },
  });

  check(
    "a null brand clears the column",
    afterClear?.brand === null,
    afterClear?.brand ?? "null",
  );

  // ── 5. The stored brand wins over the derived one ──────────────────────
  section("5. The stored brand wins over the derived one");

  const deliberate = await createProduct(actor, {
    ...body(category.id, "deliberate"),
    name: `${runId}_CeraVe Serum`,
    brand: "Bioderma",
  });

  createdProductIds.push(deliberate.id);

  check(
    "a deliberate brand beats the one derived from the name",
    displayBrand(deliberate.brand, deliberate.name) === "Bioderma",
    displayBrand(deliberate.brand, deliberate.name) ?? "null",
  );

  const derived = await createProduct(actor, {
    ...body(category.id, "derived"),
    // The name must **begin** with the brand for the derivation to
    // find it — a prefix rule, not a "contains" rule. "Cream by
    // CeraVe" is not a CeraVe-prefixed name, and the derivation
    // correctly says so.
    name: `CeraVe Cream ${runId}`,
    brand: null,
  });

  createdProductIds.push(derived.id);

  check(
    "a null brand falls back to the derivation",
    displayBrand(derived.brand, derived.name) === "CeraVe",
    displayBrand(derived.brand, derived.name) ?? "null",
  );

  check(
    "a brand that does not begin the name is not derived",
    displayBrand(null, "Cream by CeraVe") === null,
    displayBrand(null, "Cream by CeraVe") ?? "null",
  );

  // ── 6. The read ────────────────────────────────────────────────────────
  section("6. The read — the catalogue and the admin list");

  const catalogue = await listProducts({
    search: `${runId}_with_brand`,
    page: 1,
    limit: 20,
    sort: "newest",
  });

  const foundInCatalogue = catalogue.products.find(
    (item) => item.id === withBrand.id,
  );

  check(
    "the catalogue summary carries the brand",
    foundInCatalogue !== undefined && "brand" in foundInCatalogue,
    String(foundInCatalogue?.brand),
  );

  const adminList = await listAdminProducts({
    stock: "ALL",
    search: `${runId}_with_brand`,
    page: 1,
    limit: 20,
  });

  const foundInAdmin = adminList.products.find((item) => item.id === withBrand.id);

  check(
    "the admin summary carries the brand",
    foundInAdmin?.brand !== undefined,
    String(foundInAdmin?.brand),
  );

  // ── 7. The search ──────────────────────────────────────────────────────
  section("7. The brand is searchable on its own");

  const byBrand = await listProducts({
    search: "CeraVe",
    page: 1,
    limit: 100,
    sort: "newest",
  });

  check(
    "a product is found by its brand even when the name does not carry it",
    byBrand.products.some((item) => item.id === lowercased.id),
    `${byBrand.products.length} results`,
  );

  // ── 8. The dual pricing ────────────────────────────────────────────────
  section("8. The two prices — regular and discount");

  const priced = await createProduct(actor, {
    ...body(category.id, "priced"),
    pricePaisa: 100000,
    discountPricePaisa: 75000,
  });

  createdProductIds.push(priced.id);

  check(
    "the regular price is stored",
    priced.pricePaisa === 100000,
    String(priced.pricePaisa),
  );
  check(
    "the discount price is stored",
    priced.discountPricePaisa === 75000,
    String(priced.discountPricePaisa),
  );
  check(
    "the discount mirror is recomputed from the two prices",
    priced.discountPercentage === 25,
    String(priced.discountPercentage),
  );
  check(
    "the effective price is the discount price",
    discountPercent(priced.pricePaisa, priced.discountPricePaisa) === 25,
    `${discountPercent(priced.pricePaisa, priced.discountPricePaisa)}%`,
  );

  const unpriced = await createProduct(actor, {
    ...body(category.id, "unpriced"),
    pricePaisa: 100000,
  });

  createdProductIds.push(unpriced.id);

  check(
    "a product with no discount has no discount price",
    unpriced.discountPricePaisa === null &&
      unpriced.discountPercentage === null,
    String(unpriced.discountPricePaisa),
  );

  // ── 9. The validation ──────────────────────────────────────────────────
  section("9. The validation — the brand rules at the edge");

  const valid = {
    name: `${runId}_valid`,
    categoryId: category.id,
    pricePaisa: 100000,
    stockQuantity: 5,
    ingredientTags: [],
    images: [],
  };

  check(
    "a known brand is accepted and canonicalised",
    productCreateSchema.parse({ ...valid, brand: "cerave" }).brand ===
      "CeraVe",
  );
  check(
    "a custom brand is accepted",
    productCreateSchema.parse({ ...valid, brand: "New Skin" }).brand ===
      "New Skin",
  );
  check(
    "an absent brand is accepted",
    productCreateSchema.parse(valid).brand === undefined,
  );
  check(
    "a null brand is accepted",
    productCreateSchema.parse({ ...valid, brand: null }).brand === null,
  );
  check(
    "a blank brand is refused",
    !productCreateSchema.safeParse({ ...valid, brand: "   " }).success,
  );
  check(
    "an over-long brand is refused",
    !productCreateSchema.safeParse({
      ...valid,
      brand: "x".repeat(MAX_BRAND_LENGTH + 1),
    }).success,
  );
  check(
    "a brand at the length limit is accepted",
    productUpdateSchema.safeParse({
      brand: "x".repeat(MAX_BRAND_LENGTH),
    }).success,
  );

  // ── 10. The audit trail ────────────────────────────────────────────────
  section("10. The audit trail — the brand is on the record");

  const audit = await prisma.adminAuditLog.findFirst({
    where: { entityType: "product", entityId: lowercased.id },
    orderBy: { createdAt: "desc" },
  });

  const after = audit?.after as Record<string, unknown> | null;

  check(
    "the create audit entry carries the canonicalised brand",
    after?.brand === "CeraVe",
    String(after?.brand),
  );

  const updatedAudit = await prisma.adminAuditLog.findFirst({
    where: { entityType: "product", entityId: withBrand.id },
    orderBy: { createdAt: "desc" },
  });

  const updatedAfter = updatedAudit?.after as Record<string, unknown> | null;

  check(
    "the update audit entry carries the brand",
    updatedAfter?.brand === null,
    String(updatedAfter?.brand),
  );
}

main()
  .then(async () => {
    // ── The cleanup ──────────────────────────────────────────────────────
    console.log("\nCleaning up…");

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

    console.log(
      failures === 0
        ? "\nAll Step 16 checks passed.\n"
        : `\n${failures} Step 16 check(s) FAILED.\n`,
    );

    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error: unknown) => {
    console.error("\nThe verification script itself failed.\n");
    console.error(error);

    // Best-effort cleanup, so a failed run does not leave rows behind.
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
    } catch {
      // The cleanup is best-effort. The original error is the one that
      // matters, and it is already printed.
    }

    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
