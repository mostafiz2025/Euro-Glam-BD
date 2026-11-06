import { buildLineChartGeometry } from "@/lib/admin/charts";

import { ChartEmptyState } from "./ChartFrame";

/**
 * The line chart.
 *
 * ── A server component, on purpose ────────────────────────────────────────
 *
 * There is no `"use client"` here. The chart's markup is fully
 * determined by the data, so rendering it on the server means:
 *
 *   • The chart is in the HTML that arrives. It is visible before any
 *     JavaScript runs, and it is visible with JavaScript disabled.
 *   • It costs no bundle. A chart library would ship its renderer to
 *     every visitor.
 *   • The theme flip is **free**. The colours come from CSS custom
 *     properties, so `.dark` repainting the canvas repaints the chart
 *     in the same frame — no state, no re-render, no JavaScript.
 *
 * The last point is the reason this project hand-rolls its charts
 * rather than reaching for Recharts, which resolves its colours in
 * JavaScript and therefore has to re-render through React on a theme
 * change.
 *
 * ── The axis ──────────────────────────────────────────────────────────────
 *
 * The y-axis is labelled with four rounded figures, and the x-axis
 * with a handful of the period labels. Every label is skipped rather
 * than drawn overlapping — the labels are only there to orient the
 * reader, and the tooltip-free chart's exact values are available in
 * the table beneath it.
 */
export function LineChart({
  points,
  labels,
  formatValue,
  title,
}: {
  /** The values, in order. */
  readonly points: readonly number[];
  /** The axis label for each point. */
  readonly labels: readonly string[];
  /** Formats a value for the y-axis. */
  readonly formatValue: (value: number) => string;
  /** The chart's accessible name. */
  readonly title: string;
}) {
  if (points.length === 0) {
    return (
      <ChartEmptyState
        title="No data for this period"
        description="Nothing was recorded in the range this chart covers."
      />
    );
  }

  const width = 720;
  const height = 240;
  const padding = 24;

  const geometry = buildLineChartGeometry(points, width, height, padding);

  // The four gridline values, from the bottom up.
  const gridValues = [0, 0.25, 0.5, 0.75, 1].map(
    (fraction) => geometry.min + (geometry.max - geometry.min) * fraction,
  );

  const plotBottom = height - padding;
  const plotTop = padding;

  /**
   * How many x-axis labels to draw.
   *
   * A label every point would overlap on a 30-point daily series. Six
   * is enough to orient the reader without a crowd.
   */
  const labelStride = Math.max(1, Math.ceil(geometry.coords.length / 6));

  const total = geometry.coords.reduce(
    (sum, coordinate) => sum + coordinate.value,
    0,
  );

  return (
    <div className="px-5 py-4">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${title}. ${points.length} points, totalling ${formatValue(total)}.`}
      >
        <title>{title}</title>

        <desc>
          {`A line chart of ${points.length} points. The highest value is ${formatValue(
            geometry.max,
          )} and the lowest is ${formatValue(geometry.min)}.`}
        </desc>

        {/* ── The gridlines ─────────────────────────────────────── */}
        {gridValues.map((value, index) => {
          const fraction = index / (gridValues.length - 1);
          const y = plotBottom - fraction * (plotBottom - plotTop);

          return (
            <g key={index}>
              <line
                x1={padding}
                y1={y}
                x2={width - padding}
                y2={y}
                stroke="var(--chart-grid)"
                strokeWidth={1}
                strokeDasharray={index === 0 ? undefined : "3 4"}
              />

              <text
                x={padding - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-foreground-muted text-[10px]"
              >
                {formatValue(value)}
              </text>
            </g>
          );
        })}

        {/* ── The area under the line ────────────────────────────── */}
        {geometry.areaPath ? (
          <path
            d={geometry.areaPath}
            fill="var(--chart-1)"
            fillOpacity={0.12}
          />
        ) : null}

        {/* ── The line ───────────────────────────────────────────── */}
        {geometry.path ? (
          <path
            d={geometry.path}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null}

        {/* ── The points ─────────────────────────────────────────── */}
        {geometry.coords.map((coordinate, index) => (
          <circle
            key={index}
            cx={coordinate.x}
            cy={coordinate.y}
            r={2.5}
            fill="var(--chart-1)"
          />
        ))}

        {/* ── The x-axis labels ──────────────────────────────────── */}
        {geometry.coords.map((coordinate, index) => {
          if (index % labelStride !== 0) return null;

          const label = labels[index] ?? "";

          if (!label) return null;

          return (
            <text
              key={index}
              x={coordinate.x}
              y={height - 6}
              textAnchor="middle"
              className="fill-foreground-muted text-[10px]"
            >
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
