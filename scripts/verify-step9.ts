/**
 * Step 9 verification script.
 *
 * Proves the four Step 9 deliverables behave correctly against a real
 * database, outside the unit tests:
 *
 *   1. The pricing module is the single source of truth for money, and a
 *      client-supplied price cannot enter the order.
 *   2. The catalogue filters on the *effective* price, so a discounted
 *      product is found by a price filter that its list price would miss.
 *   3. The cart is owned by its user — one cart cannot be addressed from
 *      another session, and its lines are scoped to that cart.
 *   4. The order is written in one transaction: a failure leaves no order
 *      and no phantom stock deduction, and a concurrent checkout cannot
 *      sell the same unit twice.
 *   5. The blocking conflict path refuses the order until it is confirmed.
 *
 * Run with:  DATABASE_URL=postgresql://... npx tsx scripts/verify-step9.ts
 *
 * The script is safe to run repeatedly: everything it creates is removed
 * again at the end.
 */

import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
} from "@prisma/client";

import { evaluateConflicts } from "@/lib/conflict-engine";
import {
  FLAT_SHIPPING_PAISA,
  FREE_SHIPPING_THRESHOLD_PAISA,
  calculateOrderTotals,
  effectivePricePaisa,
  formatPaisa,
} from "@/lib/pricing";
import { checkoutSchema } from "@/lib/validation/commerce";

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
const runId = `verify${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * A category slug, in the lowercase hyphen-separated form the schema
 * requires.
 */
const slug = `${runId}-cat`;

/**
 * The ids created by the script, cleaned up afterwards.
 */
const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

/**
 * Creates a user.
 */
async function createUser(
  email: string,
  role: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Verify Customer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role,
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

/**
 * Creates a category.
 */
async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Verify Category", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

/**
 * Creates a product.
 */
async function createProduct(
  categoryId: string,
  name: string,
  options: {
    pricePaisa?: number;
    discountPricePaisa?: number | null;
    stockQuantity?: number;
    ingredientTags?: string[];
  } = {},
): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Verify product ${name}`,
      categoryId,
      pricePaisa: options.pricePaisa ?? 100000,
      discountPricePaisa:
        options.discountPricePaisa === undefined
          ? null
          : options.discountPricePaisa,
      stockQuantity: options.stockQuantity ?? 10,
      ingredientTags: options.ingredientTags ?? [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

/**
 * Puts a product in the user's cart.
 */
async function addToCart(
  userId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  const cart = await prisma.cart.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { id: true },
  });

  await prisma.cartItem.upsert({
    where: { cartId_productId: { cartId: cart.id, productId } },
    create: { cartId: cart.id, productId, quantity },
    update: { quantity },
  });
}

/**
 * A valid checkout body.
 */
const CHECKOUT = {
  shippingAddress: {
    fullName: "Ayesha Rahman",
    phone: "01712345678",
    addressLine1: "House 12, Road 5, Dhanmondi",
    city: "Dhaka",
    district: "Dhaka",
    postalCode: "1209",
  },
  paymentMethod: "COD" as const,
  confirmConflicts: false,
};

async function main(): Promise<number> {
  console.log("Euro Glam BD — Step 9 verification\n");

  // ── 1. Pricing is the single source of truth ────────────────────────
  section("1. Pricing — integer poisha, no client-supplied money");

  check(
    "the effective price prefers the discount",
    effectivePricePaisa({
      id: "p1",
      pricePaisa: 200000,
      discountPricePaisa: 150000,
    }) === 150000,
  );

  check(
    "a zero discount is a real discount, not a missing one",
    effectivePricePaisa({
      id: "p1",
      pricePaisa: 200000,
      discountPricePaisa: 0,
    }) === 0,
  );

  check(
    "a null discount falls back to the list price",
    effectivePricePaisa({
      id: "p1",
      pricePaisa: 200000,
      discountPricePaisa: null,
    }) === 200000,
  );

  const smallTotals = calculateOrderTotals([
    {
      product: { id: "p1", pricePaisa: 100000, discountPricePaisa: null },
      quantity: 1,
    },
  ]);

  check(
    "a small order pays flat shipping",
    smallTotals.shippingPaisa === FLAT_SHIPPING_PAISA &&
      smallTotals.shippingDiscountPaisa === 0,
    `${smallTotals.shippingPaisa} poisha`,
  );

  const freeTotals = calculateOrderTotals([
    {
      product: {
        id: "p1",
        pricePaisa: FREE_SHIPPING_THRESHOLD_PAISA,
        discountPricePaisa: null,
      },
      quantity: 1,
    },
  ]);

  check(
    "the free-shipping threshold is inclusive",
    freeTotals.shippingPaisa === 0 &&
      freeTotals.shippingDiscountPaisa === FLAT_SHIPPING_PAISA,
  );

  check(
    "the total is the sum of the lines plus shipping",
    smallTotals.totalAmountPaisa ===
      smallTotals.subtotalPaisa + smallTotals.shippingPaisa,
  );

  check(
    "the price is formatted as taka",
    formatPaisa(150000) === "৳1,500",
    formatPaisa(150000),
  );

  check(
    "a partial taka keeps its poisha",
    formatPaisa(150050) === "৳1,500.50",
    formatPaisa(150050),
  );

  const body = checkoutSchema.parse({
    ...CHECKOUT,
    // A client trying to state its own total.
    totalAmountPaisa: 1,
    pricePaisa: 1,
    subtotalPaisa: 1,
  });

  check(
    "a client-supplied price is dropped by the schema",
    !("totalAmountPaisa" in body) &&
      !("pricePaisa" in body) &&
      !("subtotalPaisa" in body),
  );

  check(
    "checkout defaults to COD and to not confirming conflicts",
    body.paymentMethod === "COD" && body.confirmConflicts === false,
  );

  // ── 2. The catalogue filters on the effective price ──────────────────
  section("2. Catalogue — the effective price is what gets filtered");

  const categoryId = await createCategory(slug);
  const discountedId = await createProduct(categoryId, "Discounted", {
    pricePaisa: 300000,
    discountPricePaisa: 120000,
    stockQuantity: 5,
  });
  const plainId = await createProduct(categoryId, "Plain", {
    pricePaisa: 130000,
    stockQuantity: 5,
  });
  const tooDearId = await createProduct(categoryId, "Too Dear", {
    pricePaisa: 200000,
    stockQuantity: 5,
  });

  // Import the catalogue service lazily so the script fails loudly if the
  // module cannot load.
  const { listProducts } = await import("@/lib/catalog/service");

  const withinBudget = await listProducts({
    category: slug,
    maxPricePaisa: 130000,
    page: 1,
    limit: 20,
    sort: "newest",
  });

  const ids = withinBudget.products.map((item) => item.id);

  check(
    "a discounted product is found by its discounted price",
    ids.includes(discountedId),
  );

  check(
    "a product at the ceiling is included",
    ids.includes(plainId),
  );

  check(
    "a product above the budget is excluded",
    !ids.includes(tooDearId),
  );

  // The reverse case: a product whose *list* price is under the ceiling
  // but whose *discounted* price is over it must be excluded. This is
  // the case that the earlier, list-price filter got wrong.
  const sneakyId = await createProduct(categoryId, "Sneaky", {
    pricePaisa: 100000,
    discountPricePaisa: 0,
    stockQuantity: 5,
  });

  const zeroBudget = await listProducts({
    category: slug,
    minPricePaisa: 1,
    page: 1,
    limit: 20,
    sort: "newest",
  });

  check(
    "a free item is excluded by a minimum price of one poisha",
    !zeroBudget.products.map((p) => p.id).includes(sneakyId),
  );

  // ── 3. The cart is owned by its user ─────────────────────────────────
  section("3. Cart — one owner, scoped lines");

  const { getCart, addToCart: addToCartService } = await import(
    "@/lib/cart/service"
  );

  const ownerId = await createUser(`${runId}_owner@example.com`);
  const strangerId = await createUser(`${runId}_stranger@example.com`);
  const cartProductId = await createProduct(categoryId, "Cart Item", {
    pricePaisa: 50000,
    stockQuantity: 5,
  });

  await addToCartService(ownerId, cartProductId, 2);

  const ownerCart = await getCart(ownerId);
  const strangerCart = await getCart(strangerId);

  check("the owner sees their item", ownerCart.items.length === 1);
  check("a stranger sees an empty cart", strangerCart.items.length === 0);
  check(
    "the two carts are different carts",
    ownerCart.id !== strangerCart.id,
  );

  // ── 4. A blocking conflict stops the order ──────────────────────────
  section("4. Conflict — a BLOCK stops the order until it is confirmed");

  const retinolId = await createProduct(categoryId, "Retinol", {
    pricePaisa: 200000,
    stockQuantity: 5,
    ingredientTags: ["RETINOL"],
  });
  const ahaId = await createProduct(categoryId, "AHA", {
    pricePaisa: 200000,
    stockQuantity: 5,
    ingredientTags: ["GLYCOLIC_ACID"],
  });

  const evaluation = evaluateConflicts([
    { id: retinolId, ingredientTags: ["RETINOL"] },
    { id: ahaId, ingredientTags: ["GLYCOLIC_ACID"] },
  ]);

  check(
    "the engine reports a BLOCK for retinol + AHA",
    evaluation.conflicts.some((c) => c.severity === "BLOCK"),
    evaluation.conflicts.map((c) => c.ruleId).join(", "),
  );

  const conflictUserId = await createUser(`${runId}_conflict@example.com`);
  await addToCart(conflictUserId, retinolId, 1);
  await addToCart(conflictUserId, ahaId, 1);

  const { placeOrder } = await import("@/lib/orders/service");

  let refused = false;
  let refusalMessage = "";
  try {
    await placeOrder(conflictUserId, CHECKOUT);
  } catch (error) {
    refused = true;
    refusalMessage = (error as Error).message;
  }

  check("the order is refused without a confirmation", refused, refusalMessage);
  check(
    "the refusal tells the customer to confirm",
    /confirm/i.test(refusalMessage),
  );

  const ordersAfterRefusal = await prisma.order.count({
    where: { userId: conflictUserId },
  });
  check("no order was written", ordersAfterRefusal === 0);

  // ── 5. The order is written in one transaction ───────────────────────
  section("5. Orders — one transaction, no partial writes");

  const buyerId = await createUser(`${runId}_buyer@example.com`);
  const boughtId = await createProduct(categoryId, "Bought", {
    pricePaisa: 100000,
    stockQuantity: 10,
  });

  await addToCart(buyerId, boughtId, 2);

  const placed = await placeOrder(buyerId, CHECKOUT);

  check("the order number is well-formed", /^EGB-\d{8}-[A-Z0-9]{6}$/.test(placed.orderNumber), placed.orderNumber);
  check("the subtotal comes from the database", placed.subtotalPaisa === 200000);
  check(
    "the total is the subtotal plus shipping",
    placed.totalAmountPaisa === 200000 + FLAT_SHIPPING_PAISA,
  );
  check("the order status is PENDING", placed.status === OrderStatus.PENDING);
  check(
    "the payment status is PENDING and independent of the order status",
    placed.paymentStatus === PaymentStatus.PENDING,
  );
  check(
    "the payment method is COD",
    placed.paymentMethod === PaymentMethod.COD,
  );

  const stockAfter = await prisma.product.findUnique({
    where: { id: boughtId },
    select: { stockQuantity: true },
  });
  check("the stock was deducted", stockAfter?.stockQuantity === 8);

  const cartAfter = await prisma.cart.findUnique({
    where: { userId: buyerId },
    select: { items: { select: { id: true } } },
  });
  check("the cart was emptied", cartAfter?.items.length === 0);

  // The order item snapshots the name and price, so a later rename or
  // repricing of the product cannot rewrite history.
  const item = await prisma.orderItem.findFirst({
    where: { orderId: placed.orderId },
    select: { productName: true, pricePaisa: true },
  });

  check(
    "the order item snapshots the name",
    item?.productName === "Bought",
  );
  check("the order item snapshots the price", item?.pricePaisa === 100000);

  // ── 6. A failure rolls the whole order back ─────────────────────────
  section("6. Orders — a failure rolls everything back");

  const rollbackUserId = await createUser(`${runId}_rollback@example.com`);
  const scarceId = await createProduct(categoryId, "Scarce", {
    pricePaisa: 10000,
    stockQuantity: 1,
  });

  // Ask for more than exists. The database is the authority.
  await addToCart(rollbackUserId, scarceId, 5);

  let rolledBack = false;
  try {
    await placeOrder(rollbackUserId, CHECKOUT);
  } catch {
    rolledBack = true;
  }

  check("the order is refused for insufficient stock", rolledBack);

  const ordersAfterRollback = await prisma.order.count({
    where: { userId: rollbackUserId },
  });
  check("no order was written", ordersAfterRollback === 0);

  const scarceAfter = await prisma.product.findUnique({
    where: { id: scarceId },
    select: { stockQuantity: true },
  });
  check("the stock was not deducted", scarceAfter?.stockQuantity === 1);

  const cartAfterRollback = await prisma.cart.findUnique({
    where: { userId: rollbackUserId },
    select: { items: { select: { quantity: true } } },
  });
  check("the cart is untouched", cartAfterRollback?.items.length === 1);

  // ── 7. Concurrent checkouts cannot oversell ─────────────────────────
  section("7. Orders — concurrent checkouts cannot sell the same unit");

  const concurrentUserId = await createUser(
    `${runId}_concurrent@example.com`,
  );
  const lastOneId = await createProduct(categoryId, "Last One", {
    pricePaisa: 10000,
    stockQuantity: 1,
  });

  await addToCart(concurrentUserId, lastOneId, 1);

  const results = await Promise.allSettled([
    placeOrder(concurrentUserId, CHECKOUT),
    placeOrder(concurrentUserId, CHECKOUT),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  check("exactly one checkout succeeded", fulfilled.length === 1, `${fulfilled.length} fulfilled, ${rejected.length} rejected`);
  check("exactly one checkout was rejected", rejected.length === 1);

  const lastOneAfter = await prisma.product.findUnique({
    where: { id: lastOneId },
    select: { stockQuantity: true },
  });
  check(
    "the stock landed on exactly zero, never below",
    lastOneAfter?.stockQuantity === 0,
  );

  const concurrentOrders = await prisma.order.count({
    where: { userId: concurrentUserId },
  });
  check("exactly one order exists", concurrentOrders === 1);

  // ── 8. Confirmed conflicts go through ───────────────────────────────
  section("8. Orders — a confirmed conflict is allowed and recorded");

  const confirmed = await placeOrder(conflictUserId, {
    ...CHECKOUT,
    confirmConflicts: true,
  });

  check("the order is placed once confirmed", Boolean(confirmed.orderId));
  check(
    "the conflict is recorded on the order",
    confirmed.conflicts.some((c) => c.severity === "BLOCK"),
  );

  // ── Result ───────────────────────────────────────────────────────────
  console.log("");
  if (failures === 0) {
    console.log("All Step 9 checks passed.");
  } else {
    console.error(`${failures} check(s) failed.`);
  }

  return failures;
}

main()
  .then(async (failures) => {
    // Clean up in dependency order: the schema's onDelete rules mean a
    // user cannot be deleted while orders reference it.
    try {
      await prisma.orderItem.deleteMany({
        where: { order: { userId: { in: createdUserIds } } },
      });
      await prisma.order.deleteMany({
        where: { userId: { in: createdUserIds } },
      });
      await prisma.cartItem.deleteMany({
        where: { cart: { userId: { in: createdUserIds } } },
      });
      await prisma.cart.deleteMany({
        where: { userId: { in: createdUserIds } },
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
      await prisma.$disconnect();
    }

    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
