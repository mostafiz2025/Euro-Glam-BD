import { describe, expect, it } from "vitest";

import {
  computeConversionRate,
  computeGrowth,
  formatGrowth,
} from "@/lib/admin/analytics";

/**
 * The growth metrics.
 *
 * The metric that matters most here is the **zero base**. A percentage
 * against zero is not defined, and reporting "+100%" for it would be an
 * invented number attached to a real figure — the kind of thing that
 * makes a dashboard untrustworthy. So the zero base has its own
 * answer: `NEW`.
 */

describe("computeGrowth", () => {
  it("reports an increase", () => {
    const metric = computeGrowth(150, 100);

    expect(metric.kind).toBe("UP");
    expect(metric.percentage).toBe(50);
    expect(metric.current).toBe(150);
    expect(metric.previous).toBe(100);
  });

  it("reports a decrease", () => {
    const metric = computeGrowth(50, 100);

    expect(metric.kind).toBe("DOWN");
    expect(metric.percentage).toBe(-50);
  });

  it("reports no change", () => {
    const metric = computeGrowth(100, 100);

    expect(metric.kind).toBe("FLAT");
    expect(metric.percentage).toBe(0);
  });

  it("reports NEW rather than a percentage when the base is zero", () => {
    // This is the case that matters. "+100%" would be a lie: there was
    // no previous period to be a hundred percent of.
    const metric = computeGrowth(500, 0);

    expect(metric.kind).toBe("NEW");
    expect(metric.percentage).toBeNull();
    expect(metric.current).toBe(500);
    expect(metric.previous).toBe(0);
  });

  it("reports FLAT when both periods are zero", () => {
    const metric = computeGrowth(0, 0);

    expect(metric.kind).toBe("FLAT");
    expect(metric.percentage).toBeNull();
  });

  it("treats a change that rounds to zero as flat", () => {
    // 100 → 100.4 is a 0.4% change. Reporting "0.0% up" is noise;
    // "flat" is the honest description.
    const metric = computeGrowth(100.4, 100);

    expect(metric.kind).toBe("FLAT");
    expect(metric.percentage).toBe(0);
  });

  it("handles a large percentage without overflow", () => {
    const metric = computeGrowth(1000, 1);

    expect(metric.kind).toBe("UP");
    expect(metric.percentage).toBe(99900);
  });

  it("handles a decrease to zero", () => {
    const metric = computeGrowth(0, 100);

    expect(metric.kind).toBe("DOWN");
    expect(metric.percentage).toBe(-100);
  });
});

describe("formatGrowth", () => {
  it("formats an increase with a leading plus", () => {
    expect(formatGrowth(computeGrowth(150, 100))).toBe("+50%");
  });

  it("formats a decrease with a leading minus", () => {
    expect(formatGrowth(computeGrowth(50, 100))).toBe("-50%");
  });

  it("formats a flat metric as zero", () => {
    expect(formatGrowth(computeGrowth(100, 100))).toBe("0%");
  });

  it("formats a new metric as NEW", () => {
    expect(formatGrowth(computeGrowth(500, 0))).toBe("NEW");
  });

  it("formats a both-zero metric as a dash", () => {
    expect(formatGrowth(computeGrowth(0, 0))).toBe("—");
  });
});

/**
 * The conversion rate.
 *
 * The zero base is the case that matters, for the same reason it does
 * for the growth metrics: a rate against zero visits is not defined.
 * "0%" would claim that no visit converted, when the truth is that
 * there was nothing to convert.
 */
describe("computeConversionRate", () => {
  it("computes the rate as a percentage of visits", () => {
    expect(computeConversionRate(5, 100)).toBe(5);
  });

  it("reports a whole-number rate exactly", () => {
    expect(computeConversionRate(25, 100)).toBe(25);
  });

  it("keeps a fractional rate fractional", () => {
    expect(computeConversionRate(1, 3)).toBeCloseTo(33.333, 2);
  });

  it("returns null when there were no visits", () => {
    // The zero base. Not 0, and not +100% — undefined.
    expect(computeConversionRate(0, 0)).toBeNull();
  });

  it("returns null when there were visits but no orders", () => {
    // Wait — this is a *defined* rate: zero percent. There were
    // visits, and none of them converted.
    expect(computeConversionRate(0, 100)).toBe(0);
  });

  it("returns null for a negative visit count rather than dividing by it", () => {
    expect(computeConversionRate(5, -1)).toBeNull();
  });

  it("allows a rate above 100 — a visit is not a person", () => {
    // Visits are page-views, not visitors. One person browsing six
    // pages and ordering once produces a ratio above 1. The service
    // documents this; the arithmetic must not hide it.
    expect(computeConversionRate(6, 5)).toBe(120);
  });
});
