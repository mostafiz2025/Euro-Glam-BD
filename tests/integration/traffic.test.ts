import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getTrafficBreakdown } from "@/lib/admin/analytics";
import { deriveTrafficEvent, generateVisitorId } from "@/lib/traffic";

/**
 * The traffic collector, against a real database.
 *
 * The taxonomy is unit-tested in `tests/admin/traffic.test.ts`. This
 * proves the parts that need a database:
 *
 *   1. A written event lands in the breakdown, in the right bucket.
 *   2. The breakdown reports **every** bucket in the closed taxonomy —
 *      including the ones with no traffic.
 *   3. The counts add up to the total. A breakdown whose legend does
 *      not sum to the total is a breakdown that is lying by omission.
 *   4. The recorded row carries **no** personal data: no IP, no user
 *      agent, no raw referrer URL.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdEventIds: string[] = [];

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the traffic " +
        "integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) return;

  await prisma.trafficEvent.deleteMany({ where: { id: { in: createdEventIds } } });
});

/**
 * Writes a traffic event and returns its id.
 */
async function writeEvent(
  referrer: string | null,
  utmSource?: string | null,
): Promise<string> {
  const visitorId = generateVisitorId();

  const derived = deriveTrafficEvent({
    path: "/products",
    referrer,
    utmSource,
    visitorId,
  });

  const id = crypto.randomUUID();

  await prisma.trafficEvent.create({
    data: {
      id,
      source: derived.source,
      referrerHost: derived.referrerHost,
      path: derived.path,
      visitorId,
    },
  });

  createdEventIds.push(id);

  return id;
}

describe("the traffic collector", () => {
  it("records a Facebook click in the facebook bucket", async () => {
    if (!databaseAvailable) return;

    const id = await writeEvent("https://www.facebook.com/somepage");

    const row = await prisma.trafficEvent.findUnique({ where: { id } });

    expect(row?.source).toBe("facebook");
    expect(row?.referrerHost).toBe("www.facebook.com");
  });

  it("records an organic visit in the organic bucket", async () => {
    if (!databaseAvailable) return;

    const id = await writeEvent("https://www.google.com/search?q=skincare");

    const row = await prisma.trafficEvent.findUnique({ where: { id } });

    expect(row?.source).toBe("organic");
  });

  it("records a direct visit with no referrer host", async () => {
    if (!databaseAvailable) return;

    const id = await writeEvent(null);

    const row = await prisma.trafficEvent.findUnique({ where: { id } });

    expect(row?.source).toBe("direct");
    expect(row?.referrerHost).toBeNull();
  });

  it("records a campaign visit in the campaign's bucket", async () => {
    if (!databaseAvailable) return;

    const id = await writeEvent(null, "newsletter");

    const row = await prisma.trafficEvent.findUnique({ where: { id } });

    expect(row?.source).toBe("email");
  });

  it("stores no raw referrer, only its host", async () => {
    if (!databaseAvailable) return;

    const id = await writeEvent(
      "https://www.facebook.com/page?campaign=secret&email=a@b.com",
    );

    const row = await prisma.trafficEvent.findUnique({ where: { id } });

    // The campaign parameter and the email address are in the referrer
    // the browser sent, and they must not be in the row.
    expect(row?.referrerHost).toBe("www.facebook.com");
    expect(row?.referrerHost).not.toContain("secret");
    expect(row?.referrerHost).not.toContain("@");
  });

  it("stores no query string in the landing path", async () => {
    if (!databaseAvailable) return;

    const visitorId = generateVisitorId();

    const derived = deriveTrafficEvent({
      path: "/products?utm_source=facebook&email=a@b.com",
      referrer: null,
      visitorId,
    });

    const id = crypto.randomUUID();

    await prisma.trafficEvent.create({
      data: {
        id,
        source: derived.source,
        referrerHost: derived.referrerHost,
        path: derived.path,
        visitorId,
      },
    });

    createdEventIds.push(id);

    const row = await prisma.trafficEvent.findUnique({ where: { id } });

    expect(row?.path).toBe("/products");
  });
});

describe("getTrafficBreakdown", () => {
  it("counts a recorded event in the matching bucket", async () => {
    if (!databaseAvailable) return;

    const before = await getTrafficBreakdown(30);

    const beforeFacebook =
      before.sources.find((source) => source.source === "facebook")?.count ?? 0;

    await writeEvent("https://www.facebook.com/somepage");

    const after = await getTrafficBreakdown(30);

    const afterFacebook =
      after.sources.find((source) => source.source === "facebook")?.count ?? 0;

    expect(afterFacebook).toBe(beforeFacebook + 1);
  });

  it("reports every bucket in the closed taxonomy", async () => {
    if (!databaseAvailable) return;

    const breakdown = await getTrafficBreakdown(30);

    expect(breakdown.sources.map((source) => source.source)).toEqual([
      "facebook",
      "organic",
      "direct",
      "email",
      "other",
    ]);
  });

  it("has counts that sum to the total", async () => {
    if (!databaseAvailable) return;

    const breakdown = await getTrafficBreakdown(30);

    const sum = breakdown.sources.reduce(
      (total, source) => total + source.count,
      0,
    );

    expect(sum).toBe(breakdown.total);
  });

  it("has shares that sum to 100 when there is traffic", async () => {
    if (!databaseAvailable) return;

    await writeEvent("https://www.facebook.com/somepage");

    const breakdown = await getTrafficBreakdown(30);

    const sum = breakdown.sources.reduce(
      (total, source) => total + source.share,
      0,
    );

    expect(sum).toBeCloseTo(100, 5);
  });
});
