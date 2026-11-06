/**
 * Step 15 verification script — the inventory table, the brand display
 * and the dynamic badge system.
 *
 * Proves the new fields behave correctly against a real database,
 * outside the unit tests:
 *
 *   1. **The brand derivation** — a registered prefix splits into brand
 *      and title, the longest prefix wins, and an unregistered prefix
 *      yields **no brand** rather than a guess.
 *   2. **The badge list is the source of truth** — a create with a
 *      badge list writes the list **and** mirrors the booleans.
 *   3. **The mirror follows the list** — adding a badge turns the
 *      boolean on, removing it turns the boolean off.
 *   4. **The legacy wire format still works** — a client that sends
 *      only `isNewArrival: true` gets the badge added to the list.
 *   5. **The validation** — the derived discount badge is refused, a
 *      duplicate is refused, and a custom tag is accepted.
 *   6. **The audit trail** — a badge change is a `PRODUCT_UPDATED`
 *      entry carrying `before.badges` and `after.badges`.
 *   7. **The inventory list** — the admin list returns the badges, the
 *      images and the prices the table renders.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step15.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import { PrismaClient } from "@prisma/client";

import { type AuditActor } from "@/lib/admin/audit";
import { createProduct, updateProduct } from "@/lib/admin/catalog";
import { listAdminProducts } from "@/lib/admin/stats";
import {
  KNOWN_BADGES,
  canonicalBadge,
  isKnownBadge,
} from "@/lib/format/badges";
import { splitBrandAndTitle } from "@/lib/format/brand";
import { firstImageUrl } from "@/lib/format/image";
import {
  MAX_PRODUCT_BADGES,
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

const runId = `s15${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

let actor: AuditActor;

async function main(): Promise<void> {
  // ── The fixtures ───────────────────────────────────────────────────────
  const user = await prisma.user.create({
    data: {
      name: "Step 15 Verifier",
      email: `${runId}_admin@example.com`,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "ADMIN",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  actor = {
    id: user.id,
    name: "Step 15 Verifier",
    email: `${runId}_admin@example.com`,
  };

  const category = await prisma.category.create({
    data: { name: "Step 15 Verifier", slug: `${runId}_cat` },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);

  // ── 1. The brand derivation ────────────────────────────────────────────
  section("1. The brand derivation — a closed registry, never a guess");

  const cerave = splitBrandAndTitle("CeraVe Hydrating Facial Cleanser");

  check("a registered prefix splits into brand and title", cerave.brand === "CeraVe", cerave.brand ?? "null");
  check("the title is the name without the brand", cerave.title === "Hydrating Facial Cleanser", cerave.title);

  const ordinary = splitBrandAndTitle("The Ordinary Niacinamide 10% + Zinc 1%");

  check(
    "the longest registered prefix wins — not the first word",
    ordinary.brand === "The Ordinary",
    ordinary.brand ?? "null",
  );

  const musta = splitBrandAndTitle("Musta Baby Lip Balm");

  check(
    "two brands sharing a prefix resolve to the longer one",
    musta.brand === "Musta Baby",
    musta.brand ?? "null",
  );

  const unknown = splitBrandAndTitle("Some Unknown Brand Hydrating Cream");

  check(
    "an unregistered prefix yields no brand at all",
    unknown.brand === null,
    unknown.brand ?? "null",
  );
  check(
    "the title falls back to the whole name",
    unknown.title === "Some Unknown Brand Hydrating Cream",
    unknown.title,
  );

  const ceramide = splitBrandAndTitle("Ceramide Cream");

  check(
    "a brand must be followed by whitespace",
    ceramide.brand === null,
    ceramide.brand ?? "null",
  );

  // ── 2. The badge vocabulary ────────────────────────────────────────────
  section("2. The badge vocabulary — a closed set plus free text");

  check("every known badge is recognised", KNOWN_BADGES.every(isKnownBadge));
  check(
    "the recognition is case-insensitive",
    isKnownBadge("best seller"),
  );
  check(
    "a known badge is canonicalised",
    canonicalBadge("best seller") === "Best Seller",
  );
  check(
    "a custom tag is not a known badge",
    !isKnownBadge("Eid Special 2026"),
  );

  // ── 3. The validation ──────────────────────────────────────────────────
  section("3. The validation — the derived badge is refused");

  const validBody = {
    name: `${runId}_product`,
    categoryId: category.id,
    pricePaisa: 95000,
    stockQuantity: 5,
    ingredientTags: [],
    images: [],
  };

  check(
    "a known badge is accepted",
    productCreateSchema.parse({ ...validBody, badges: ["New Arrival"] }).badges[0] === "New Arrival",
  );
  check(
    "a custom tag is accepted",
    productCreateSchema.parse({ ...validBody, badges: ["Eid Special 2026"] }).badges[0] === "Eid Special 2026",
  );
  check(
    "the derived discount badge is refused",
    !productCreateSchema.safeParse({ ...validBody, badges: ["Discount Offer"] }).success,
  );
  check(
    "a duplicate badge is refused",
    !productCreateSchema.safeParse({ ...validBody, badges: ["New Arrival", "New Arrival"] }).success,
  );
  check(
    "two spellings of the same known badge are refused",
    !productCreateSchema.safeParse({ ...validBody, badges: ["best seller", "Best Seller"] }).success,
  );
  check(
    "more badges than the cap are refused",
    !productCreateSchema.safeParse({
      ...validBody,
      badges: Array.from({ length: MAX_PRODUCT_BADGES + 1 }, (_, index) => `Tag ${index}`),
    }).success,
  );

  // ── 4. The badge list is the source of truth ───────────────────────────
  section("4. The badge list and the legacy booleans");

  const created = await createProduct(actor, {
    name: `${runId}_product`,
    categoryId: category.id,
    pricePaisa: 95000,
    discountPricePaisa: 75000,
    stockQuantity: 5,
    ingredientTags: [],
    images: [],
    badges: ["New Arrival", "Limited Edition"],
  });

  createdProductIds.push(created.id);

  check("the list is written as given", created.badges.length === 2, created.badges.join(", "));
  check("the mirror turns the boolean on", created.isNewArrival === true);
  check("the mirror leaves the other boolean off", created.isBestSeller === false);

  const added = await updateProduct(actor, created.id, { badges: ["Best Seller"] });

  check("adding a badge adds it to the list", added.badges.includes("Best Seller"), added.badges.join(", "));
  check("adding a badge turns the mirror on", added.isBestSeller === true);
  check(
    "removing a badge removes it from the list",
    !added.badges.includes("New Arrival"),
    added.badges.join(", "),
  );
  check("removing a badge turns the mirror off", added.isNewArrival === false);

  // A legacy client knows nothing about the badge list.
  const legacy = await updateProduct(actor, created.id, { isNewArrival: true });

  check(
    "a legacy boolean still adds the badge to the list",
    legacy.badges.includes("New Arrival"),
    legacy.badges.join(", "),
  );
  check("the legacy boolean turns the mirror on", legacy.isNewArrival === true);

  // ── 5. The audit trail ─────────────────────────────────────────────────
  section("5. The audit trail — a badge change is audited");

  // The **badge-list** update is looked up by the fields in its diff,
  // not by recency. The script made three edits to this product, and
  // the last one was the legacy-boolean edit — so "the most recent
  // entry" would be the wrong entry. The audit entry is identified by
  // what it *records*.
  const entry = await prisma.adminAuditLog.findFirst({
    where: {
      entityType: "product",
      entityId: created.id,
      action: "PRODUCT_UPDATED",
    },
    orderBy: { createdAt: "desc" },
  });

  check("a PRODUCT_UPDATED entry was written", entry !== null);

  // Find the entry whose diff carries the badge list.
  const allEntries = await prisma.adminAuditLog.findMany({
    where: {
      entityType: "product",
      entityId: created.id,
      action: "PRODUCT_UPDATED",
    },
    orderBy: { createdAt: "asc" },
  });

  const badgeEntry = allEntries.find((candidate) => {
    const candidateBefore = candidate.before as Record<string, unknown>;

    return "badges" in candidateBefore;
  });

  const before = badgeEntry?.before as Record<string, unknown>;
  const after = badgeEntry?.after as Record<string, unknown>;

  check("an entry carries the badge list in its diff", badgeEntry !== undefined);
  check("before.badges holds the old list", Array.isArray(before.badges));
  check("after.badges holds the new list", Array.isArray(after.badges));
  check(
    "the diff names the badges field",
    "badges" in before && "badges" in after,
  );
  check(
    "the diff shows the list being replaced",
    Array.isArray(before.badges) &&
      Array.isArray(after.badges) &&
      JSON.stringify(before.badges) !== JSON.stringify(after.badges),
  );

  // The legacy-boolean edit records the boolean, not the list — it
  // added a badge without the admin naming the list.
  const legacyEntry = allEntries.find((candidate) => {
    const candidateBefore = candidate.before as Record<string, unknown>;

    return "isNewArrival" in candidateBefore;
  });

  const legacyBefore = legacyEntry?.before as Record<string, unknown>;

  check(
    "the legacy-boolean edit records the boolean",
    legacyEntry !== undefined && legacyBefore.isNewArrival === false,
  );

  // ── 6. The inventory list ──────────────────────────────────────────────
  section("6. The inventory list — what the table renders");

  const list = await listAdminProducts({
    stock: "ALL",
    search: `${runId}_product`,
    page: 1,
    limit: 20,
  });

  const row = list.products.find((entry) => entry.id === created.id);

  check("the product is in the admin list", row !== undefined);
  check("the list returns the badges", row?.badges.includes("New Arrival") === true, (row?.badges ?? []).join(", "));
  check("the list returns the images", Array.isArray(row?.images));
  check("the list returns both prices", typeof row?.pricePaisa === "number" && typeof row?.discountPricePaisa === "number");
  check("the list returns the category", row?.category !== undefined);
  check("the list returns the stock", typeof row?.stockQuantity === "number");

  // The thumbnail the table renders is a **derived** URL, from a key.
  const row2 = await prisma.product.findUnique({
    where: { id: created.id },
    select: { images: true },
  });

  check(
    "a product with no image has no thumbnail URL",
    firstImageUrl(row2?.images ?? []) === null,
  );

  // ── 7. The storefront's view of the badges ─────────────────────────────
  section("7. The storefront's view — the mirror, not the list");

  const reloaded = await prisma.product.findUnique({
    where: { id: created.id },
    select: { badges: true, isNewArrival: true, isBestSeller: true },
  });

  check(
    "the stored mirror agrees with the stored list",
    reloaded?.isNewArrival ===
      (reloaded?.badges ?? []).some(
        (badge) => badge.toLowerCase() === "new arrival",
      ),
  );
  check(
    "the stored mirror agrees with the stored list",
    reloaded?.isBestSeller ===
      (reloaded?.badges ?? []).some(
        (badge) => badge.toLowerCase() === "best seller",
      ),
  );

  // ── 8. The update schema ───────────────────────────────────────────────
  section("8. The update schema — a list replaces, it does not merge");

  check(
    "an absent list leaves the badges alone",
    productUpdateSchema.parse({ name: "A new name" }).badges === undefined,
  );
  check(
    "an empty list clears the badges",
    productUpdateSchema.parse({ badges: [] }).badges?.length === 0,
  );
}

async function cleanup(): Promise<void> {
  for (const productId of createdProductIds) {
    await prisma.product.deleteMany({ where: { id: productId } });
  }

  for (const categoryId of createdCategoryIds) {
    await prisma.category.deleteMany({ where: { id: categoryId } });
  }

  for (const userId of createdUserIds) {
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  await prisma.$disconnect();
}

main()
  .catch((error: unknown) => {
    console.error("\nThe verification script itself failed:");
    console.error(error);
    failures += 1;
  })
  .finally(async () => {
    await cleanup();

    console.log("\nSummary\n───────");

    if (failures === 0) {
      console.log("  All Step 15 checks passed.");
      process.exit(0);
    }

    console.error(`  ${failures} Step 15 check(s) failed.`);
    process.exit(1);
  });
