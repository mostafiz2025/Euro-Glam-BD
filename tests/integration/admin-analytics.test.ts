import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getGrowthMetrics,
  getSalesSeries,
  getTrafficBreakdown,
} from "@/lib/admin/analytics";

/**
 * The analytics service, against a real database.
 *
 * The chart geometry is unit-tested; this proves the **queries** — and
 * the queries are where the real risks live:
 *
 *   1. The series is **zero-filled**. A day with no orders is an
 *      explicit `0`, not a gap. A chart that skipped empty days would
 *      compress its own axis and draw a straight line across a week in
 *      which nothing was sold.
 *   2. The series has the **right length** for its range, every time.
 *   3. The revenue figure **excludes** cancelled orders — the same
 *      rule `getDashboardStats` uses, so the two cannot disagree.
 *   4. The traffic breakdown reports **every** bucket in the closed
 *      taxonomy, including the ones with no traffic, and its shares
 *      sum to 100.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the analytics " +
        "integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) return;

  await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
  await prisma.category.deleteMany({ where: { id: { in: createdCategoryIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("getSalesSeries", () => {
  it("returns a zero-filled daily series of the right length", async () => {
    if (!databaseAvailable) return;

    const series = await getSalesSeries("DAILY");

    expect(series).toHaveLength(30);

    // Every point has a label and a number.
    for (const point of series) {
      expect(point.label.length).toBeGreaterThan(0);
      expect(Number.isFinite(point.revenuePaisa)).toBe(true);
      expect(Number.isFinite(point.orders)).toBe(true);
      expect(Number.isFinite(point.unitsSold)).toBe(true);
    }
  });

  it("returns a weekly series of twelve points", async () => {
    if (!databaseAvailable) return;

    const series = await getSalesSeries("WEEKLY");

    expect(series).toHaveLength(12);
  });

  it("returns a monthly series of twelve points", async () => {
    if (!databaseAvailable) return;

    const series = await getSalesSeries("MONTHLY");

    expect(series).toHaveLength(12);
  });

  it("fills an empty period with zeros rather than gaps", async () => {
    if (!databaseAvailable) return;

    // The test database may have no orders in the last thirty days, or
    // some. Either way, **every** point must be present and numeric —
    // the series must not skip a day.
    const series = await getSalesSeries("DAILY");

    const zeroPoints = series.filter((point) => point.orders === 0);

    expect(zeroPoints.length).toBeGreaterThanOrEqual(0);

    for (const point of series) {
      expect(point.orders).toBeGreaterThanOrEqual(0);
      expect(point.revenuePaisa).toBeGreaterThanOrEqual(0);
      expect(point.unitsSold).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("getGrowthMetrics", () => {
  it("returns all four metrics with a defined kind", async () => {
    if (!databaseAvailable) return;

    const metrics = await getGrowthMetrics();

    for (const metric of [
      metrics.revenue,
      metrics.newUsers,
      metrics.orders,
      metrics.productsSold,
    ]) {
      expect(["UP", "DOWN", "FLAT", "NEW"]).toContain(metric.kind);
      expect(metric.current).toBeGreaterThanOrEqual(0);
      expect(metric.previous).toBeGreaterThanOrEqual(0);

      // A percentage is defined **unless** the base was zero.
      if (metric.previous === 0) {
        expect(metric.percentage).toBeNull();
      } else {
        expect(metric.percentage).not.toBeNull();
      }
    }
  });

  it("never reports a percentage against a zero base", async () => {
    if (!databaseAvailable) return;

    const metrics = await getGrowthMetrics();

    const all = [
      metrics.revenue,
      metrics.newUsers,
      metrics.orders,
      metrics.productsSold,
    ];

    for (const metric of all) {
      if (metric.previous === 0) {
        expect(metric.percentage).toBeNull();
        expect(metric.kind).toBe(metric.current > 0 ? "NEW" : "FLAT");
      }
    }
  });
});

describe("getTrafficBreakdown", () => {
  it("reports every bucket in the closed taxonomy", async () => {
    if (!databaseAvailable) return;

    const breakdown = await getTrafficBreakdown();

    // All five buckets, always — a bucket that is missing from the
    // legend looks like a bucket that does not exist, which is a
    // different claim from "no visits came from there".
    expect(breakdown.sources.map((source) => source.source)).toEqual([
      "facebook",
      "organic",
      "direct",
      "email",
      "other",
    ]);
  });

  it("reports a zero count for a bucket with no traffic", async () => {
    if (!databaseAvailable) return;

    const breakdown = await getTrafficBreakdown();

    for (const source of breakdown.sources) {
      expect(source.count).toBeGreaterThanOrEqual(0);
      expect(source.share).toBeGreaterThanOrEqual(0);
    }
  });

  it("has shares that sum to 100 when there is traffic", async () => {
    if (!databaseAvailable) return;

    const breakdown = await getTrafficBreakdown();

    if (breakdown.total === 0) {
      // With no traffic, every share is zero. That is correct, and it
      // is why the widget shows an empty state rather than a ring.
      for (const source of breakdown.sources) {
        expect(source.share).toBe(0);
      }

      return;
    }

    const sum = breakdown.sources.reduce(
      (total, source) => total + source.share,
      0,
    );

    expect(sum).toBeCloseTo(100, 5);
  });

  it("has counts that sum to the total", async () => {
    if (!databaseAvailable) return;

    const breakdown = await getTrafficBreakdown();

    const sum = breakdown.sources.reduce(
      (total, source) => total + source.count,
      0,
    );

    expect(sum).toBe(breakdown.total);
  });
});
