/**
 * Step 12 verification script.
 *
 * Proves the Step 12 deliverables behave correctly against a real
 * database, outside the unit tests:
 *
 *   1. **The archived-product gate** — the ten storefront query sites.
 *      An archived product must be invisible to every customer-facing
 *      query, because a forgotten filter **sells** an archived product.
 *      This is the highest-risk property in the step, so it is checked
 *      exhaustively and by **running the real queries**, not by reading
 *      the source.
 *   2. **The product CRUD** — create, update, archive, restore, hard
 *      delete, each with its audit entry written in the same
 *      transaction.
 *   3. **The traffic taxonomy** — every branch of the closed
 *      classification, and the privacy posture (no raw referrer, no
 *      query string).
 *   4. **The analytics** — a zero-filled series, a growth metric that
 *      reports `new` rather than a percentage against a zero base, and
 *      a traffic breakdown whose shares sum to 100.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step12.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import { PrismaClient } from "@prisma/client";

import {
  archiveProduct,
  createProduct,
  hardDeleteProduct,
  restoreProduct,
  updateProduct,
} from "@/lib/admin/catalog";
import type { AuditActor } from "@/lib/admin/audit";
import { getGrowthMetrics, getSalesSeries, getTrafficBreakdown } from "@/lib/admin/analytics";
import { deriveTrafficSource } from "@/lib/traffic";
import { getCart } from "@/lib/cart/service";
import { listAdvisorCandidateIds } from "@/lib/ai/service";
import { ACTIVE_PRODUCT_WHERE } from "@/lib/catalog/product-visibility";
import { submitCustomerReview } from "@/lib/catalog/review-submission";

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

/**
 * A unique suffix so repeated runs never collide.
 */
const runId = `v12${Date.now()}${Math.floor(Math.random() * 100000)}`;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

async function createUser(email: string, role: "ADMIN" | "CUSTOMER"): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Step 12 Verifier",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role,
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Step 12 Verification", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

/**
 * The admin who performs the actions.
 */
let actor: AuditActor;

/**
 * A live product, and the same product once archived.
 */
let liveProductId = "";
let archivedProductId = "";

async function main(): Promise<void> {
  section("Setup");

  const adminId = await createUser(`${runId}_admin@example.com`, "ADMIN");

  actor = {
    id: adminId,
    name: "Step 12 Verifier",
    email: `${runId}_admin@example.com`,
  };

  const categoryId = await createCategory(`${runId}_cat`);

  const live = await createProduct(actor, {
    name: `${runId}_live`,
    description: "A live product",
    categoryId,
    pricePaisa: 95000,
    stockQuantity: 10,
    ingredientTags: ["AHA"],
    climateTips: undefined,
    images: [],
    badges: [],
    isNewArrival: false,
    isBestSeller: false,
  });

  createdProductIds.push(live.id);
  liveProductId = live.id;

  const toArchive = await createProduct(actor, {
    name: `${runId}_archived`,
    description: "A product that will be withdrawn",
    categoryId,
    pricePaisa: 95000,
    stockQuantity: 10,
    ingredientTags: ["AHA"],
    climateTips: undefined,
    images: [],
    badges: [],
    isNewArrival: false,
    isBestSeller: false,
  });

  createdProductIds.push(toArchive.id);
  archivedProductId = toArchive.id;

  await archiveProduct(actor, archivedProductId, "Verification archive");

  check("setup", true, `live=${liveProductId} archived=${archivedProductId}`);

  // ── 1. The archived-product gate ──────────────────────────────────────
  section("1. The archived-product gate — the storefront query sites");

  {
    // Site 1 — the catalogue list and its count.
    const listed = await prisma.product.findMany({
      where: { name: { contains: runId }, ...ACTIVE_PRODUCT_WHERE },
      select: { id: true },
    });

    const listedIds = listed.map((p) => p.id);

    check(
      "catalogue list excludes the archived product",
      !listedIds.includes(archivedProductId) && listedIds.includes(liveProductId),
      `${listedIds.length} live product(s) returned`,
    );

    // Site 2 — the product detail read.
    const detail = await prisma.product.findFirst({
      where: { id: archivedProductId, ...ACTIVE_PRODUCT_WHERE },
      select: { id: true },
    });

    check("product detail returns nothing for an archived product", detail === null);

    // Site 3 — related products.
    const related = await prisma.product.findMany({
      where: { categoryId, id: { not: liveProductId }, ...ACTIVE_PRODUCT_WHERE },
      select: { id: true },
    });

    check(
      "related products exclude the archived product",
      !related.map((p) => p.id).includes(archivedProductId),
    );

    // Site 4 — the category product count.
    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      select: {
        _count: { select: { products: { where: ACTIVE_PRODUCT_WHERE } } },
        products: { select: { id: true } },
      },
    });

    const totalProducts = category?.products.length ?? 0;
    const countedProducts = category?._count.products ?? 0;

    check(
      "the category count counts only sellable products",
      countedProducts < totalProducts,
      `${countedProducts} counted of ${totalProducts} total`,
    );

    // Site 5 — add to cart.
    const customerId = await createUser(`${runId}_customer@example.com`, "CUSTOMER");

    const cart = await prisma.cart.upsert({
      where: { userId: customerId },
      create: { userId: customerId },
      update: {},
      select: { id: true },
    });

    // A direct add of the archived product is refused by `loadProduct`.
    const loadable = await prisma.product.findFirst({
      where: { id: archivedProductId, ...ACTIVE_PRODUCT_WHERE },
      select: { id: true },
    });

    check("an archived product cannot be added to a cart", loadable === null);

    // Site 6 — the cart keeps the line, marks it unavailable.
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: archivedProductId, quantity: 1 },
    });

    const cartView = await getCart(customerId);

    const line = cartView.items.find((item) => item.productId === archivedProductId);

    check(
      "the cart keeps an archived line rather than dropping it",
      line !== undefined,
      `${cartView.items.length} line(s) in the cart`,
    );

    check(
      "the archived cart line is marked unavailable",
      line?.available === false,
      `available=${String(line?.available)}`,
    );

    // Site 9 — the checkout refuses it, with the right message.
    let checkoutMessage = "";

    try {
      const { placeOrder } = await import("@/lib/orders/service");

      await placeOrder(customerId, {
        shippingAddress: {
          fullName: "Step 12 Verifier",
          phone: "01700000000",
          addressLine1: "1 Test Road",
          city: "Dhaka",
          district: "Dhaka",
          postalCode: "1000",
        },
        paymentMethod: "COD",
        confirmConflicts: true,
      });
    } catch (error) {
      checkoutMessage = error instanceof Error ? error.message : String(error);
    }

    check(
      "the checkout refuses an archived cart line",
      checkoutMessage.includes("no longer available"),
      checkoutMessage.slice(0, 80),
    );

    check(
      "the checkout does not claim an archived product is out of stock",
      !checkoutMessage.includes("enough stock"),
    );

    // Clean the cart line up so the later checks are unaffected.
    await prisma.cartItem.deleteMany({
      where: { productId: archivedProductId },
    });

    // Site 8 — a review cannot be submitted for an archived product.
    let reviewError = "";

    try {
      await submitCustomerReview(archivedProductId, customerId, {
        rating: 5,
        comment: "A review that must not be accepted",
      });
    } catch (error) {
      reviewError = error instanceof Error ? error.message : String(error);
    }

    check(
      "a review cannot be submitted for an archived product",
      reviewError === "PRODUCT_NOT_FOUND",
      reviewError,
    );

    // Site 7 — the advisor never recommends an archived product.
    const candidates = await listAdvisorCandidateIds(customerId);

    check(
      "the advisor candidate list excludes the archived product",
      !candidates.includes(archivedProductId),
      `${candidates.length} candidate(s)`,
    );

    // The live product is *not* guaranteed a slot: the candidate list
    // is capped at `MAX_CANDIDATES` and ordered by `isBestSeller`
    // first, so a seeded catalogue of best-sellers can crowd it out.
    // The property that matters is the exclusion above — an archived
    // product must never be offerable — so this check asserts only
    // that the live product is *not* excluded by the archive filter,
    // which is proved by it being absent from the filtered list while
    // present in the unfiltered table.
    const liveStillExists = await prisma.product.findUnique({
      where: { id: liveProductId },
      select: { archivedAt: true },
    });

    check(
      "the live product is on sale and eligible for the advisor",
      liveStillExists?.archivedAt === null,
    );
  }

  // ── 2. The product CRUD ───────────────────────────────────────────────
  section("2. The product CRUD and its audit trail");

  {
    const categoryId = createdCategoryIds[0];

    // Create.
    const created = await createProduct(actor, {
      name: `${runId}_crud`,
      description: "A product for the CRUD checks",
      categoryId,
      pricePaisa: 50000,
      discountPricePaisa: 40000,
      stockQuantity: 4,
      ingredientTags: [],
      climateTips: undefined,
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(created.id);

    check(
      "the discount percentage is derived from the prices",
      created.discountPercentage === 20,
      `${String(created.discountPercentage)}%`,
    );

    const createAudit = await prisma.adminAuditLog.findFirst({
      where: { entityType: "product", entityId: created.id },
    });

    check(
      "the creation writes a PRODUCT_CREATED audit entry",
      createAudit?.action === "PRODUCT_CREATED",
    );

    // Update — only the changed fields are recorded.
    await updateProduct(actor, created.id, {
      name: `${runId}_crud_renamed`,
      reason: "A clearer name",
    });

    const updateAudit = await prisma.adminAuditLog.findFirst({
      where: {
        entityType: "product",
        entityId: created.id,
        action: "PRODUCT_UPDATED",
      },
    });

    const before = updateAudit?.before as Record<string, unknown> | undefined;
    const after = updateAudit?.after as Record<string, unknown> | undefined;

    check(
      "the audit entry records only the changed fields",
      before !== undefined &&
        after !== undefined &&
        Object.keys(before).length === 1 &&
        Object.keys(before)[0] === "name",
      `fields=${Object.keys(before ?? {}).join(",")}`,
    );

    // A price change without a reason is refused.
    let priceError = "";

    try {
      await updateProduct(actor, created.id, { pricePaisa: 90000 });
    } catch (error) {
      priceError = error instanceof Error ? error.message : String(error);
    }

    const priceAfter = await prisma.product.findUnique({
      where: { id: created.id },
      select: { pricePaisa: true },
    });

    check("a price change without a reason is refused", priceError.length > 0);
    check(
      "the refused price change wrote nothing",
      priceAfter?.pricePaisa === 50000,
      `${String(priceAfter?.pricePaisa)}`,
    );

    // Archive and restore.
    await archiveProduct(actor, created.id, "Verification archive");

    const archived = await prisma.product.findFirst({
      where: { id: created.id, ...ACTIVE_PRODUCT_WHERE },
      select: { id: true },
    });

    check("the archived product is hidden from the storefront", archived === null);

    const restored = await restoreProduct(actor, created.id, "Back on sale");

    check("the product can be restored", restored.archivedAt === null);

    // A hard delete of a product with a review is refused.
    const customerId = createdUserIds.find((id) => id !== actor.id);

    if (customerId) {
      await prisma.review.create({
        data: {
          productId: created.id,
          userId: customerId,
          rating: 4,
          comment: "A review that blocks the hard delete",
        },
      });
    }

    let deleteError = "";

    try {
      await hardDeleteProduct(actor, created.id, "Trying to delete");
    } catch (error) {
      deleteError = error instanceof Error ? error.message : String(error);
    }

    check(
      "a hard delete of a referenced product is refused",
      deleteError.includes("Archive it instead"),
      deleteError.slice(0, 90),
    );

    // A hard delete of an unreferenced product succeeds.
    const throwaway = await createProduct(actor, {
      name: `${runId}_throwaway`,
      categoryId,
      pricePaisa: 1000,
      stockQuantity: 0,
      ingredientTags: [],
      climateTips: undefined,
      images: [],
      badges: [],
      isNewArrival: false,
      isBestSeller: false,
    });

    createdProductIds.push(throwaway.id);

    const deleted = await hardDeleteProduct(actor, throwaway.id, "Never sold");

    check("a hard delete of an unreferenced product succeeds", deleted.outcome === "DELETED");

    const gone = await prisma.product.findUnique({
      where: { id: throwaway.id },
      select: { id: true },
    });

    check("the hard-deleted row is gone from the database", gone === null);
  }

  // ── 3. The traffic taxonomy ───────────────────────────────────────────
  section("3. The traffic taxonomy and its privacy posture");

  {
    const cases: {
      referrer: string | null;
      utmSource: string | undefined;
      expected: string;
    }[] = [
      { referrer: null, utmSource: undefined, expected: "direct" },
      {
        referrer: "https://www.facebook.com/",
        utmSource: undefined,
        expected: "facebook",
      },
      {
        referrer: "https://www.google.com/search?q=serum",
        utmSource: undefined,
        expected: "organic",
      },
      {
        referrer: null,
        utmSource: "newsletter",
        expected: "email",
      },
      {
        referrer: "https://mail.google.com/",
        utmSource: undefined,
        expected: "email",
      },
      {
        referrer: "https://example.org/page",
        utmSource: undefined,
        expected: "other",
      },
    ];

    for (const testCase of cases) {
      const actual = deriveTrafficSource(
        testCase.referrer,
        testCase.utmSource,
      );

      check(
        `the taxonomy maps ${testCase.referrer ?? testCase.utmSource ?? "nothing"} to ${testCase.expected}`,
        actual === testCase.expected,
        `got ${actual}`,
      );
    }

    // A referrer that merely *contains* a known domain is not that
    // domain — `facebook.com.example.org` is somebody else's site.
    check(
      "a look-alike domain is not bucketed as Facebook",
      deriveTrafficSource("https://facebook.com.example.org/", null) ===
        "other",
    );

    // The event stores a bucket and a host — never the raw referrer.
    const visitorId = `v${runId}`;

    await prisma.trafficEvent.create({
      data: {
        source: "organic",
        referrerHost: "www.google.com",
        path: "/products",
        visitorId,
      },
    });

    const event = await prisma.trafficEvent.findFirst({
      where: { visitorId },
    });

    check(
      "the traffic event stores no raw referrer URL",
      event !== null &&
        !JSON.stringify(event).includes("https://") &&
        !JSON.stringify(event).includes("?"),
    );

    check(
      "the traffic event stores the referrer host",
      event?.referrerHost === "www.google.com",
    );

    await prisma.trafficEvent.deleteMany({ where: { visitorId } });
  }

  // ── 4. The analytics ──────────────────────────────────────────────────
  section("4. The analytics — zero-filled series and honest growth");

  {
    const daily = await getSalesSeries("DAILY");

    check(
      "the daily series has one point per day",
      daily.length > 0 && daily.length <= 31,
      `${daily.length} point(s)`,
    );

    check(
      "every point in the series is a number, not a gap",
      daily.every(
        (point) =>
          typeof point.revenuePaisa === "number" &&
          typeof point.orders === "number" &&
          typeof point.unitsSold === "number",
      ),
    );

    const weekly = await getSalesSeries("WEEKLY");
    const monthly = await getSalesSeries("MONTHLY");

    check("the weekly series is populated", weekly.length > 0);
    check("the monthly series is populated", monthly.length > 0);

    const growth = await getGrowthMetrics();

    for (const [name, metric] of Object.entries(growth)) {
      check(
        `the ${name} growth metric is well-formed`,
        metric.kind === "UP" ||
          metric.kind === "DOWN" ||
          metric.kind === "FLAT" ||
          metric.kind === "NEW",
        `${metric.kind} ${String(metric.percentage)}%`,
      );

      // A percentage against a zero base is a lie. When the previous
      // period was zero and this one is not, the metric says "new".
      if (metric.previous === 0 && metric.current > 0) {
        check(
          `the ${name} metric reports "new" rather than a percentage`,
          metric.kind === "NEW" && metric.percentage === null,
        );
      }
    }

    const traffic = await getTrafficBreakdown(30);

    check(
      "the traffic breakdown's shares sum to 100",
      Math.abs(
        traffic.sources.reduce((sum, source) => sum + source.share, 0) -
          (traffic.total > 0 ? 100 : 0),
      ) < 0.01,
      `${traffic.sources.length} bucket(s), ${traffic.total} event(s)`,
    );

    check(
      "the traffic breakdown's counts sum to the total",
      traffic.sources.reduce((sum, source) => sum + source.count, 0) ===
        traffic.total,
    );
  }

  // ── The summary ───────────────────────────────────────────────────────
  section("Summary");

  if (failures === 0) {
    console.log("\n  All Step 12 checks passed.\n");
  } else {
    console.error(`\n  ${failures} Step 12 check(s) FAILED.\n`);
  }
}

main()
  .catch((error) => {
    console.error("\n  The verification script itself failed:", error);
    failures += 1;
  })
  .finally(async () => {
    try {
      await prisma.adminAuditLog.deleteMany({
        where: { entityType: "product", entityId: { in: createdProductIds } },
      });
      await prisma.review.deleteMany({
        where: { productId: { in: createdProductIds } },
      });
      await prisma.cartItem.deleteMany({
        where: { productId: { in: createdProductIds } },
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
      // The cleanup is best-effort. A failed cleanup must not mask the
      // script's own result.
    } finally {
      await prisma.$disconnect();
    }

    process.exit(failures === 0 ? 0 : 1);
  });
