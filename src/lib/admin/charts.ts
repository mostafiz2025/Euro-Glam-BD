/**
 * The chart geometry.
 *
 * ── Why this file is pure ─────────────────────────────────────────────────
 *
 * Every function here takes numbers and returns numbers and strings. No
 * React, no DOM, no database.
 *
 * That is deliberate. Chart geometry is where the bugs live: a
 * divide-by-zero on a flat series, a `NaN` coordinate on an empty one,
 * a degenerate zero-length arc when only one slice has a value. Those
 * bugs are almost impossible to find by looking at a rendered chart —
 * you see a blank, or a slightly wrong curve, and you have no idea
 * which arithmetic produced it.
 *
 * As pure functions they are directly testable, and the degenerate
 * cases are *named* rather than emergent.
 *
 * ── Why hand-rolled SVG and not a chart library ───────────────────────────
 *
 * A library would be about 90 kB of JavaScript that resolves colours at
 * runtime — which means a theme change re-renders every chart through
 * React rather than repainting it. The charts here read their colours
 * from CSS variables, so a theme flip repaints them in the same frame,
 * with no JavaScript involved at all.
 *
 * Canvas would be worse still: no server-rendered markup, no CSS
 * variables, no accessible DOM.
 *
 * The result is server-rendered SVG that is accessible
 * (`role="img"` with a `<title>` and a `<desc>`), theme-reactive
 * through CSS variables alone, and adds no dependency to the project.
 */

/**
 * A point on a line chart.
 */
export type LinePoint = {
  /** The horizontal position, in SVG user units. */
  readonly x: number;
  /** The vertical position, in SVG user units. */
  readonly y: number;
  /** The value the point represents. */
  readonly value: number;
};

/**
 * The geometry of a line chart.
 */
export type LineChartGeometry = {
  /** The line's `d` attribute. */
  readonly path: string;
  /** The filled area's `d` attribute. */
  readonly areaPath: string;
  /** The points, in order. */
  readonly coords: readonly LinePoint[];
  /** The smallest value in the series. */
  readonly min: number;
  /** The largest value in the series. */
  readonly max: number;
};

/**
 * Builds the geometry for a line chart.
 *
 * ── The degenerate cases ──────────────────────────────────────────────────
 *
 * **An empty series** produces an empty path — not a path with `NaN`
 * coordinates, and not a crash. The chart's caller checks for an empty
 * series and renders an empty state instead.
 *
 * **A single point** produces a path with one `M` command and no line.
 * That is the honest geometry for one point: a line needs two.
 *
 * **A flat series** — every value equal — produces a **horizontal**
 * line, not a division by zero. The usual formulation scales by
 * `max - min`, which is zero for a flat series. Here the divisor falls
 * back to `1`, which places the line in the middle of the plot area.
 * A flat line across the middle is what a flat series means.
 *
 * @param points  - The values, in order.
 * @param width   - The SVG's width, in user units.
 * @param height  - The SVG's height, in user units.
 * @param padding - The inset from each edge.
 */
export function buildLineChartGeometry(
  points: readonly number[],
  width: number,
  height: number,
  padding: number,
): LineChartGeometry {
  if (points.length === 0) {
    return { path: "", areaPath: "", coords: [], min: 0, max: 0 };
  }

  const plotWidth = Math.max(0, width - padding * 2);
  const plotHeight = Math.max(0, height - padding * 2);

  const min = Math.min(...points);
  const max = Math.max(...points);

  // The divisor. A flat series has `max === min`, and dividing by that
  // would produce `Infinity` and then `NaN` coordinates — the classic
  // chart bug. Falling back to `1` puts a flat series at the vertical
  // midpoint of the plot, which is exactly what a flat series means.
  const span = max - min;
  const divisor = span === 0 ? 1 : span;

  const coords: LinePoint[] = points.map((value, index) => {
    // A single point has no horizontal extent, so it sits at the left
    // edge. With two or more, the points spread across the full width.
    const x =
      points.length === 1
        ? padding
        : padding + (index / (points.length - 1)) * plotWidth;

    const y = padding + plotHeight - ((value - min) / divisor) * plotHeight;

    return { x, y, value };
  });

  const path = coords
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${round(point.x)},${round(point.y)}`;
    })
    .join(" ");

  // The area is the line closed down to the baseline. With one point
  // there is no area to fill — a polygon needs three points — so the
  // area path is empty and the chart draws the line only.
  const areaPath =
    coords.length < 2
      ? ""
      : `${path} L${round(coords[coords.length - 1].x)},${round(
          padding + plotHeight,
        )} L${round(coords[0].x)},${round(padding + plotHeight)} Z`;

  return { path, areaPath, coords, min, max };
}

/**
 * A slice of a donut chart.
 */
export type DonutSlice = {
  /** The label, for the legend and the accessible description. */
  readonly label: string;
  /** The value. */
  readonly value: number;
  /**
   * The CSS custom property that colours the slice, e.g.
   * `"--chart-1"`.
   */
  readonly colorVar: string;
};

/**
 * The geometry of one donut arc.
 */
export type DonutArc = {
  /**
   * The arc's `stroke-dasharray` — the visible length and the gap.
   */
  readonly dashArray: string;
  /**
   * The arc's `stroke-dashoffset` — how far along the circumference the
   * arc starts.
   */
  readonly dashOffset: number;
  /** The slice's label. */
  readonly label: string;
  /** The slice's value. */
  readonly value: number;
  /** The CSS custom property that colours the arc. */
  readonly colorVar: string;
};

/**
 * The geometry of a donut chart.
 */
export type DonutGeometry = {
  /** The arcs, in order. */
  readonly arcs: readonly DonutArc[];
  /** The total of every slice's value. */
  readonly total: number;
  /**
   * True when there is nothing to draw.
   *
   * The caller must render an **explicit empty state** in that case —
   * never a ring that looks like "100% of nothing".
   */
  readonly isEmpty: boolean;
};

/**
 * Builds the geometry for a donut chart.
 *
 * ── The degenerate cases ──────────────────────────────────────────────────
 *
 * **All-zero slices** produce no arcs at all, and `isEmpty` is true.
 * The caller shows an empty state. A ring drawn from zero-valued slices
 * would be a full circle that says "100% of nothing", which is a lie.
 *
 * **A single non-zero slice** produces a **full circle**. The usual
 * `stroke-dasharray` formulation produces a zero-length dash for a
 * single 100% slice — because the gap is `circumference - visible`,
 * and a floating-point remainder of zero makes the whole dash
 * invisible. So when one slice carries the entire total, the arc is
 * emitted with the full circumference as its dash and no gap.
 *
 * Zero-valued slices are skipped entirely: a slice worth nothing has
 * no arc to draw, and an arc with a zero-length dash is noise.
 *
 * @param slices     - The slices, in order.
 * @param size       - The SVG's width and height, in user units.
 * @param thickness  - The ring's stroke width.
 */
export function buildDonutGeometry(
  slices: readonly DonutSlice[],
  size: number,
  thickness: number,
): DonutGeometry {
  const radius = Math.max(0, (size - thickness) / 2);
  const circumference = 2 * Math.PI * radius;

  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);

  if (total <= 0 || circumference <= 0) {
    return { arcs: [], total: Math.max(0, total), isEmpty: true };
  }

  // The slices that actually contribute. A zero-valued slice has no arc.
  const contributing = slices.filter((slice) => slice.value > 0);

  // The single-slice case. A full ring, drawn as one arc with the
  // whole circumference as its dash.
  if (contributing.length === 1) {
    const only = contributing[0];

    return {
      arcs: [
        {
          dashArray: `${round(circumference)} ${round(circumference)}`,
          dashOffset: 0,
          label: only.label,
          value: only.value,
          colorVar: only.colorVar,
        },
      ],
      total,
      isEmpty: false,
    };
  }

  let consumed = 0;

  const arcs = contributing.map((slice) => {
    const fraction = slice.value / total;
    const visible = circumference * fraction;

    const arc: DonutArc = {
      dashArray: `${round(visible)} ${round(circumference - visible)}`,
      // The negation is written so the first arc's offset is a clean
      // `0` rather than `-0`. They compare equal under `===` but not
      // under `Object.is`, and a `-0` in path data is a wart.
      dashOffset: consumed === 0 ? 0 : -round(consumed),
      label: slice.label,
      value: slice.value,
      colorVar: slice.colorVar,
    };

    consumed += visible;

    return arc;
  });

  return { arcs, total, isEmpty: false };
}

/**
 * Rounds a number to a fixed number of decimal places.
 *
 * SVG path data is text, and a coordinate with fifteen decimal places
 * is bytes nobody needs to serve. Two decimals is well below the
 * precision of a pixel on any display.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Formats a number as a compact percentage.
 *
 * A whole number, with no decimal point — "42%" rather than "42.0%".
 * The fraction is only ever shown as a supporting detail next to the
 * count, so a decimal place would be noise.
 */
export function formatShare(count: number, total: number): string {
  if (total <= 0) return "0%";

  return `${Math.round((count / total) * 100)}%`;
}
