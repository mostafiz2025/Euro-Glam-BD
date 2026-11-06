import { OrderStatus, PaymentMethod, PaymentStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { trackOrder } from "@/lib/orders/tracking";
import { MAX_TRACKING_ATTEMPTS_PER_HOUR } from "@/lib/validation/tracking";

/**
 * The guest order-tracking integration tests.
 *
 * These exercise the real database, because the two properties that matter
 * most about this endpoint **are** database properties:
 *
 *   1. **A match requires the contact detail.** An order number alone must
 *      never be enough — it is printed on a parcel.
 *
 *   2. **The limit is counted in the database.** A process-local counter
 *      would be reset on every restart and would not be shared between
 *      instances, which is exactly when a cap is needed. So the counter has
 *      to survive a restart and be visible to a second reader — and only a
 *      real database can prove that.
 *
 * The ledger is also where the **non-enumeration** property lives: a
 * failure against a number that belongs to nobody has to move the counter
 * exactly as a failure against a real order does. Otherwise the limit
 * itself becomes an oracle that tells the attacker which numbers are real.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdOrderIds: string[] = [];

const runId = `trk${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * Every order number the tests touch.
 *
 * The ledger rows are keyed by the order number, and the limit is
 * counted from them — so a test that used a fixed number would consume
 * the budget of the *next* run, and would count against a real order
 * that happens to share the number.
 *
 * So the numbers are **unique per run**, and every one of them is
 * registered here so the cleanup can remove the ledger rows afterwards.
 */
const touchedOrderNumbers = new Set<string>();

/**
 * Builds an order number in the shop's real shape.
 *
 * The shape matters: the service refuses anything that is not shaped
 * like an order number before it reaches the database, and a test
 * number that did not parse would prove nothing.
 *
 * The date part is eight **decimal** digits — that is what the
 * normaliser's pattern accepts — and the timestamp's last eight digits
 * are both decimal and unique enough for a test run. The random part is
 * six hex characters, which is the shop's own shape.
 */
function makeOrderNumber(suffix: string): string {
  const number = `EGB-${Date.now().toString().slice(-8)}-${suffix
    .padEnd(6, "0")
    .toUpperCase()}`;

  touchedOrderNumbers.add(number);

  return number;
}

/**
 * The canonical order number the tests look up.
 */
const REAL_ORDER_NUMBER = makeOrderNumber("A1B2C3");

/**
 * A second real order number, used for the "a different order" cases.
 */
const OTHER_ORDER_NUMBER = makeOrderNumber("D4E5F6");

/**
 * An order number that belongs to nobody.
 */
const UNKNOWN_ORDER_NUMBER = makeOrderNumber("ABCDEF");

/**
 * The email address of the customer who owns the orders.
 */
const OWNER_EMAIL = `${runId}_owner@example.com`;

/**
 * The phone on the orders' shipping address.
 */
const DELIVERY_PHONE = "01712345678";

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Tracking Customer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Tracking Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);

  return category.id;
}

async function createProduct(categoryId: string, name: string): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Tracking test product ${name}`,
      categoryId,
      pricePaisa: 250000,
      stockQuantity: 50,
      ingredientTags: [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);

  return product.id;
}

/**
 * Creates an order with two lines.
 *
 * The two lines matter: the total quantity is derived from the lines, so a
 * single-line order could not prove that the derivation reads every line
 * rather than the first.
 */
async function createOrder(
  userId: string,
  productId: string,
  orderNumber: string,
  phone: string = DELIVERY_PHONE,
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId,
      orderNumber,
      status: OrderStatus.PROCESSING,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: PaymentMethod.COD,
      subtotalPaisa: 250000 * 2 + 150000,
      totalAmountPaisa: 250000 * 2 + 150000 + 8000,
      shippingAmountPaisa: 8000,
      discountAmountPaisa: 0,
      shippingAddress: {
        fullName: "Ayesha Rahman",
        phone,
        addressLine1: "House 12, Road 5, Dhanmondi",
        city: "Dhaka",
        district: "Dhaka",
        postalCode: "1209",
      },
      items: {
        create: [
          {
            productId,
            productName: "Tracking Cream",
            pricePaisa: 250000,
            quantity: 2,
          },
          {
            productId,
            productName: "Tracking Serum",
            pricePaisa: 150000,
            quantity: 1,
          },
        ],
      },
    },
    select: { id: true },
  });

  createdOrderIds.push(order.id);

  return order.id;
}

let ownerId: string;
let categoryId: string;
let productId: string;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the order " +
        "tracking integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  ownerId = await createUser(OWNER_EMAIL);
  categoryId = await createCategory(`${runId}-cat`);
  productId = await createProduct(categoryId, "Tracking Product");

  await createOrder(ownerId, productId, REAL_ORDER_NUMBER);
  await createOrder(ownerId, productId, OTHER_ORDER_NUMBER);
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.orderTrackingAttempt.deleteMany({
      where: { orderNumber: { in: [...touchedOrderNumbers] } },
    });
    await prisma.orderItem.deleteMany({
      where: { orderId: { in: createdOrderIds } },
    });
    await prisma.order.deleteMany({
      where: { id: { in: createdOrderIds } },
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
  }
});

/**
 * Clears the ledger before each test.
 *
 * The ledger is the shared state between the tests — the limit is counted
 * in it — so a test that ran after the rate-limit test would find the
 * counter already spent.
 */
beforeEach(async () => {
  if (!databaseAvailable) return;

  await prisma.orderTrackingAttempt.deleteMany({
    where: { orderNumber: { in: [...touchedOrderNumbers] } },
  });
});

describe("trackOrder — the happy path", () => {
  it("returns the order when the email on the order is given", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder(REAL_ORDER_NUMBER, OWNER_EMAIL);

    expect(result).not.toBeNull();
    expect(result?.orderNumber).toBe(REAL_ORDER_NUMBER);
    expect(result?.status).toBe(OrderStatus.PROCESSING);
    expect(result?.paymentStatus).toBe(PaymentStatus.PAID);
    expect(result?.paymentMethod).toBe(PaymentMethod.COD);
  });

  it("returns the order when the delivery phone on the order is given", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder(REAL_ORDER_NUMBER, DELIVERY_PHONE);

    expect(result).not.toBeNull();
    expect(result?.orderNumber).toBe(REAL_ORDER_NUMBER);
  });

  it("returns the order when the phone is given in the checkout's spelling", async () => {
    /*
     * The checkout writes `+8801712345678` and an admin-created order
     * carries `01712345678`. Both spellings have to find the same order,
     * which is why the comparison is on digits.
     */
    if (!databaseAvailable) return;

    const result = await trackOrder(REAL_ORDER_NUMBER, "+8801712345678");

    expect(result).not.toBeNull();
    expect(result?.orderNumber).toBe(REAL_ORDER_NUMBER);
  });

  it("finds the order when the number is typed in another spelling", async () => {
    /*
     * The number travels by SMS and is retyped, so it arrives in
     * lowercase, with spaces instead of hyphens, or with the hyphens
     * stripped entirely. All of them are the same number.
     */
    if (!databaseAvailable) return;

    const [prefix, date, suffix] = REAL_ORDER_NUMBER.split("-");

    const spellings = [
      `${prefix} ${date} ${suffix}`,
      `${prefix.toLowerCase()}-${date}-${suffix.toLowerCase()}`,
      `${prefix}${date}${suffix}`,
    ];

    for (const spelling of spellings) {
      const result = await trackOrder(spelling, OWNER_EMAIL);

      expect(result, `${spelling} should find the order`).not.toBeNull();
      expect(result?.orderNumber).toBe(REAL_ORDER_NUMBER);
    }
  });

  it("returns the quantity as the sum of the lines", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder(REAL_ORDER_NUMBER, OWNER_EMAIL);

    expect(result?.totalQuantity).toBe(3);
    expect(result?.items).toHaveLength(2);
    expect(result?.items.map((item) => item.quantity)).toEqual([2, 1]);
  });

  it("returns the total, and a date the page can render", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder(REAL_ORDER_NUMBER, OWNER_EMAIL);

    expect(result?.totalAmountPaisa).toBe(658000);
    expect(Number.isNaN(Date.parse(result?.placedAt ?? ""))).toBe(false);
  });

  it("records the success in the ledger", async () => {
    if (!databaseAvailable) return;

    await trackOrder(REAL_ORDER_NUMBER, OWNER_EMAIL);

    const attempt = await prisma.orderTrackingAttempt.findFirst({
      where: { orderNumber: REAL_ORDER_NUMBER },
    });

    expect(attempt?.succeeded).toBe(true);
  });
});

describe("trackOrder — the refusals", () => {
  it("refuses an order number with the wrong contact detail", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder(
      REAL_ORDER_NUMBER,
      "someone.else@example.com",
    );

    expect(result).toBeNull();
  });

  it("refuses a real order number paired with somebody else's phone", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder(REAL_ORDER_NUMBER, "01912345678");

    expect(result).toBeNull();
  });

  it("refuses an order number that was never issued", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder(UNKNOWN_ORDER_NUMBER, OWNER_EMAIL);

    expect(result).toBeNull();
  });

  it("gives the same answer for a mistyped number as for a wrong detail", async () => {
    /*
     * The whole point of the design. A mistyped number, a number that was
     * never issued, and a correct number with the wrong contact detail all
     * produce `null` — because any difference between them would turn the
     * endpoint into an enumeration oracle over the shop's order numbers.
     */
    if (!databaseAvailable) return;

    const mistyped = await trackOrder("EGB-20261104-A1B2C", OWNER_EMAIL);
    const neverIssued = await trackOrder(UNKNOWN_ORDER_NUMBER, OWNER_EMAIL);
    const wrongDetail = await trackOrder(
      REAL_ORDER_NUMBER,
      "someone.else@example.com",
    );

    expect(mistyped).toBeNull();
    expect(neverIssued).toBeNull();
    expect(wrongDetail).toBeNull();
  });

  it("refuses a number that is not shaped like an order number", async () => {
    if (!databaseAvailable) return;

    const result = await trackOrder("not an order number", OWNER_EMAIL);

    expect(result).toBeNull();
  });

  it("does not record a malformed number, and does not count it", async () => {
    /*
     * A malformed number cannot be a guess at a real order — the shop's
     * numbers have one shape and that shape is printed on every parcel.
     *
     * Counting it would be a denial of service for free: ten malformed
     * requests an hour would lock out every customer whose number did not
     * parse, and the shop's own customers mistype numbers more often than
     * an attacker does.
     */
    if (!databaseAvailable) return;

    const before = await prisma.orderTrackingAttempt.count();

    await trackOrder("not an order number", OWNER_EMAIL);
    await trackOrder("EGB-20261104", OWNER_EMAIL);

    const after = await prisma.orderTrackingAttempt.count();

    expect(after).toBe(before);
  });
});

describe("trackOrder — the hourly limit", () => {
  it("lets a customer past the limit after a success", async () => {
    /*
     * A success has already proved the caller knows the contact detail, so
     * it is not a guess. Counting it would mean a customer who checks
     * their order five times in an hour eventually locks themselves out of
     * their own order.
     */
    if (!databaseAvailable) return;

    for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS_PER_HOUR + 3; attempt++) {
      const result = await trackOrder(REAL_ORDER_NUMBER, OWNER_EMAIL);

      expect(result).not.toBeNull();
    }
  });

  it("refuses the eleventh failure against one order number", async () => {
    if (!databaseAvailable) return;

    for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS_PER_HOUR; attempt++) {
      const result = await trackOrder(
        REAL_ORDER_NUMBER,
        "someone.else@example.com",
      );

      expect(result).toBeNull();
    }

    await expect(
      trackOrder(REAL_ORDER_NUMBER, "someone.else@example.com"),
    ).rejects.toThrow(ApiError);
  });

  it("reports the refusal as RATE_LIMITED", async () => {
    if (!databaseAvailable) return;

    for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS_PER_HOUR; attempt++) {
      await trackOrder(REAL_ORDER_NUMBER, "someone.else@example.com");
    }

    await expect(
      trackOrder(REAL_ORDER_NUMBER, "someone.else@example.com"),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });

  it("counts a failure against a number that belongs to nobody", async () => {
    /*
     * The non-enumeration property, tested directly. If a failure against a
     * number that does not exist did **not** move the counter, the counter
     * would become an oracle: a candidate that starts answering
     * RATE_LIMITED would be telling the attacker it is real.
     */
    if (!databaseAvailable) return;

    const unknownNumber = UNKNOWN_ORDER_NUMBER;

    try {
      for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS_PER_HOUR; attempt++) {
        const result = await trackOrder(unknownNumber, OWNER_EMAIL);

        expect(result).toBeNull();
      }

      await expect(
        trackOrder(unknownNumber, OWNER_EMAIL),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      await prisma.orderTrackingAttempt.deleteMany({
        where: { orderNumber: unknownNumber },
      });
    }
  });

  it("keeps the counter per order number, not global", async () => {
    /*
     * One customer's failures must not lock out another customer's. The
     * counter is scoped to the order number that was tried, so the two
     * numbers have independent budgets.
     */
    if (!databaseAvailable) return;

    for (let attempt = 0; attempt < MAX_TRACKING_ATTEMPTS_PER_HOUR; attempt++) {
      await trackOrder(REAL_ORDER_NUMBER, "someone.else@example.com");
    }

    const result = await trackOrder(OTHER_ORDER_NUMBER, OWNER_EMAIL);

    expect(result).not.toBeNull();
  });

  it("reads the counter from the database, not from the process", async () => {
    /*
     * The ledger is the counter. Writing the failures directly — as a
     * second process would, after a restart — must exhaust the budget
     * without the service's own memory involved at all.
     */
    if (!databaseAvailable) return;

    await prisma.orderTrackingAttempt.createMany({
      data: Array.from({ length: MAX_TRACKING_ATTEMPTS_PER_HOUR }, () => ({
        orderNumber: REAL_ORDER_NUMBER,
        succeeded: false,
        createdAt: new Date(),
      })),
    });

    await expect(
      trackOrder(REAL_ORDER_NUMBER, OWNER_EMAIL),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not count the failures that are older than an hour", async () => {
    if (!databaseAvailable) return;

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    await prisma.orderTrackingAttempt.createMany({
      data: Array.from({ length: MAX_TRACKING_ATTEMPTS_PER_HOUR + 5 }, () => ({
        orderNumber: REAL_ORDER_NUMBER,
        succeeded: false,
        createdAt: twoHoursAgo,
      })),
    });

    const result = await trackOrder(REAL_ORDER_NUMBER, OWNER_EMAIL);

    expect(result).not.toBeNull();
  });
});
