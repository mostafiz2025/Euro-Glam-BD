import { buildDonutGeometry, formatShare } from "@/lib/admin/charts";

import { ChartEmptyState } from "./ChartFrame";

/**
 * The donut chart.
 *
 * ── Why a `<circle>` with a dash pattern ──────────────────────────────────
 *
 * Each slice is a `<circle>` stroked with `stroke-dasharray` and
 * `stroke-dashoffset`, not a filled `<path>`.
 *
 * The path approach requires computing arc endpoints and, for the
 * segment that wraps past twelve o'clock, a large-arc flag. That is
 * fiddly, and it has one genuinely nasty failure: a single slice
 * carrying the whole total produces a zero-length arc — a degenerate
 * path that renders as nothing at all.
 *
 * The dash approach has no such edge case. A circle stroked with the
 * full circumference and a full gap is a complete ring; shortening the
 * dash and offsetting it draws a slice. The geometry module handles the
 * single-slice case explicitly, and the test proves it.
 *
 * ── The colours ──────────────────────────────────────────────────────────
 *
 * Every slice reads `var(--chart-N)`, so a theme flip repaints the
 * chart in the same frame. No JavaScript, no re-render.
 */
export function DonutChart({
  slices,
  title,
  emptyTitle = "No traffic recorded yet",
  emptyDescription = "Traffic will appear here once the storefront's tracking starts recording visits.",
}: {
  /** The slices, in order. */
  readonly slices: readonly {
    readonly label: string;
    readonly value: number;
    readonly colorVar: string;
  }[];
  /** The chart's accessible name. */
  readonly title: string;
  /** The empty state's heading. */
  readonly emptyTitle?: string;
  /** The empty state's body. */
  readonly emptyDescription?: string;
}) {
  const size = 200;
  const thickness = 28;

  const geometry = buildDonutGeometry(slices, size, thickness);

  if (geometry.isEmpty) {
    return <ChartEmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const radius = (size - thickness) / 2;
  const centre = size / 2;

  return (
    <div className="flex flex-wrap items-center gap-8 px-5 py-5">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-auto w-44 shrink-0"
        role="img"
        aria-label={`${title}. ${geometry.total} total visits.`}
      >
        <title>{title}</title>

        <desc>
          {slices
            .filter((slice) => slice.value > 0)
            .map(
              (slice) =>
                `${slice.label}: ${slice.value} (${formatShare(
                  slice.value,
                  geometry.total,
                )})`,
            )
            .join(". ")}
        </desc>

        {/* The track, behind the slices. A faint full ring, so an arc
        * that starts partway round reads as a portion of something. */}
        <circle
          cx={centre}
          cy={centre}
          r={radius}
          fill="none"
          stroke="var(--chart-grid)"
          strokeWidth={thickness}
        />

        {geometry.arcs.map((arc, index) => (
          <circle
            key={index}
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            stroke={`var(${arc.colorVar})`}
            strokeWidth={thickness}
            strokeDasharray={arc.dashArray}
            strokeDashoffset={arc.dashOffset}
            /* The slices start at twelve o'clock and run clockwise. */
            transform={`rotate(-90 ${centre} ${centre})`}
          />
        ))}
      </svg>

      {/* ── The legend ──────────────────────────────────────────── */}
      <ul className="min-w-48 flex-1 space-y-2.5">
        {slices.map((slice) => (
          <li
            key={slice.label}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: `var(${slice.colorVar})` }}
              />

              <span className="text-foreground">{slice.label}</span>
            </span>

            <span className="flex items-baseline gap-2 tabular-nums">
              <span className="font-semibold text-foreground">
                {slice.value}
              </span>

              <span className="text-xs text-foreground-muted">
                {formatShare(slice.value, geometry.total)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
