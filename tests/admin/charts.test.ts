import { describe, expect, it } from "vitest";

import {
  buildDonutGeometry,
  buildLineChartGeometry,
  formatShare,
} from "@/lib/admin/charts";

/**
 * The chart geometry.
 *
 * These are the cases where a chart silently draws the wrong thing.
 * A `NaN` coordinate, a divide-by-zero, a zero-length arc — none of
 * them throw. They just produce a chart that is quietly wrong, which
 * is why they are pinned down here rather than left to inspection.
 */

describe("buildLineChartGeometry", () => {
  it("returns an empty path for an empty series", () => {
    const geometry = buildLineChartGeometry([], 600, 200, 16);

    expect(geometry.path).toBe("");
    expect(geometry.areaPath).toBe("");
    expect(geometry.coords).toEqual([]);
  });

  it("never produces NaN for an empty series", () => {
    const geometry = buildLineChartGeometry([], 600, 200, 16);

    for (const coordinate of geometry.coords) {
      expect(Number.isNaN(coordinate.x)).toBe(false);
      expect(Number.isNaN(coordinate.y)).toBe(false);
    }
  });

  it("places a single point without dividing by zero", () => {
    const geometry = buildLineChartGeometry([42], 600, 200, 16);

    expect(geometry.coords).toHaveLength(1);
    expect(Number.isNaN(geometry.coords[0].x)).toBe(false);
    expect(Number.isNaN(geometry.coords[0].y)).toBe(false);

    // A single point has no line to draw — a line needs two.
    expect(geometry.path).toMatch(/^M/);
    expect(geometry.path).not.toContain("L");
  });

  it("produces a flat line for a constant series", () => {
    // The classic divide-by-zero: `max - min` is zero here. The line
    // must be horizontal, not `NaN`.
    const geometry = buildLineChartGeometry([5, 5, 5, 5], 600, 200, 16);

    expect(geometry.min).toBe(5);
    expect(geometry.max).toBe(5);

    for (const coordinate of geometry.coords) {
      expect(Number.isNaN(coordinate.y)).toBe(false);
    }

    // Every point sits at the same height.
    const ys = new Set(geometry.coords.map((point) => point.y));

    expect(ys.size).toBe(1);
  });

  it("spreads the points across the plot width", () => {
    const geometry = buildLineChartGeometry([0, 1, 2, 3], 600, 200, 16);

    const first = geometry.coords[0];
    const last = geometry.coords[geometry.coords.length - 1];

    // The first point is at the left inset, the last at the right
    // inset.
    expect(first.x).toBe(16);
    expect(last.x).toBe(600 - 16);
  });

  it("puts the minimum at the bottom and the maximum at the top", () => {
    const geometry = buildLineChartGeometry([0, 50, 100], 600, 200, 16);

    const min = geometry.coords[0];
    const max = geometry.coords[2];

    // A larger value is a smaller `y` — the chart's y-axis points up.
    expect(min.y).toBeGreaterThan(max.y);
  });

  it("closes the area path down to the baseline", () => {
    const geometry = buildLineChartGeometry([1, 2, 3], 600, 200, 16);

    expect(geometry.areaPath).toContain("Z");
    expect(geometry.areaPath.startsWith(geometry.path)).toBe(true);
  });

  it("leaves the area path empty for a single point", () => {
    // A polygon needs three points. A one-point area is not a shape.
    const geometry = buildLineChartGeometry([7], 600, 200, 16);

    expect(geometry.areaPath).toBe("");
  });

  it("handles a zero-sized plot area without NaN", () => {
    const geometry = buildLineChartGeometry([1, 2, 3], 0, 0, 0);

    for (const coordinate of geometry.coords) {
      expect(Number.isNaN(coordinate.x)).toBe(false);
      expect(Number.isNaN(coordinate.y)).toBe(false);
    }
  });

  it("handles a padding larger than the canvas without NaN", () => {
    const geometry = buildLineChartGeometry([1, 2, 3], 100, 100, 500);

    for (const coordinate of geometry.coords) {
      expect(Number.isNaN(coordinate.x)).toBe(false);
      expect(Number.isNaN(coordinate.y)).toBe(false);
    }
  });
});

describe("buildDonutGeometry", () => {
  const slices = [
    { label: "Facebook", value: 40, colorVar: "--chart-1" },
    { label: "Organic", value: 30, colorVar: "--chart-2" },
    { label: "Direct", value: 20, colorVar: "--chart-3" },
    { label: "Email", value: 10, colorVar: "--chart-4" },
  ];

  it("produces no arcs for an all-zero set", () => {
    const geometry = buildDonutGeometry(
      [
        { label: "Facebook", value: 0, colorVar: "--chart-1" },
        { label: "Organic", value: 0, colorVar: "--chart-2" },
      ],
      200,
      24,
    );

    expect(geometry.isEmpty).toBe(true);
    expect(geometry.arcs).toEqual([]);
    expect(geometry.total).toBe(0);
  });

  it("produces no arcs for an empty slice list", () => {
    const geometry = buildDonutGeometry([], 200, 24);

    expect(geometry.isEmpty).toBe(true);
    expect(geometry.arcs).toEqual([]);
  });

  it("produces a full circle for a single non-zero slice", () => {
    // The classic bug: a single 100% slice produces a zero-length dash
    // and the ring disappears entirely.
    const geometry = buildDonutGeometry(
      [{ label: "Direct", value: 12, colorVar: "--chart-1" }],
      200,
      24,
    );

    expect(geometry.isEmpty).toBe(false);
    expect(geometry.arcs).toHaveLength(1);

    const radius = (200 - 24) / 2;
    const circumference = 2 * Math.PI * radius;

    const [dash, gap] = geometry.arcs[0].dashArray.split(" ").map(Number);

    // The dash is the whole circumference, and the gap is the same —
    // which is how a `<circle>` draws a complete ring.
    expect(dash).toBeCloseTo(circumference, 1);
    expect(gap).toBeCloseTo(circumference, 1);
  });

  it("skips zero-valued slices", () => {
    const geometry = buildDonutGeometry(
      [
        { label: "Facebook", value: 40, colorVar: "--chart-1" },
        { label: "Organic", value: 0, colorVar: "--chart-2" },
        { label: "Direct", value: 60, colorVar: "--chart-3" },
      ],
      200,
      24,
    );

    expect(geometry.arcs).toHaveLength(2);
    expect(geometry.arcs.map((arc) => arc.label)).toEqual([
      "Facebook",
      "Direct",
    ]);
  });

  it("gives each arc a dash proportional to its share", () => {
    const geometry = buildDonutGeometry(slices, 200, 24);

    const radius = (200 - 24) / 2;
    const circumference = 2 * Math.PI * radius;

    const firstDash = Number(geometry.arcs[0].dashArray.split(" ")[0]);

    // 40 out of 100.
    expect(firstDash).toBeCloseTo(circumference * 0.4, 1);
  });

  it("stacks the arcs with a cumulative offset", () => {
    const geometry = buildDonutGeometry(slices, 200, 24);

    expect(geometry.arcs[0].dashOffset).toBe(0);
    expect(geometry.arcs[1].dashOffset).toBeLessThan(0);
    expect(geometry.arcs[2].dashOffset).toBeLessThan(geometry.arcs[1].dashOffset);
  });

  it("totals the slice values", () => {
    const geometry = buildDonutGeometry(slices, 200, 24);

    expect(geometry.total).toBe(100);
  });

  it("treats a negative value as zero", () => {
    const geometry = buildDonutGeometry(
      [
        { label: "Facebook", value: 10, colorVar: "--chart-1" },
        { label: "Organic", value: -5, colorVar: "--chart-2" },
      ],
      200,
      24,
    );

    expect(geometry.total).toBe(10);
    expect(geometry.arcs).toHaveLength(1);
  });

  it("reports empty for a zero-sized chart", () => {
    const geometry = buildDonutGeometry(slices, 0, 24);

    expect(geometry.isEmpty).toBe(true);
  });
});

describe("formatShare", () => {
  it("formats a share as a whole percentage", () => {
    expect(formatShare(25, 100)).toBe("25%");
  });

  it("rounds to the nearest whole number", () => {
    expect(formatShare(1, 3)).toBe("33%");
  });

  it("returns zero for a zero total", () => {
    expect(formatShare(0, 0)).toBe("0%");
  });

  it("returns zero for a zero count", () => {
    expect(formatShare(0, 100)).toBe("0%");
  });
});
