import { DonutChart } from "@/components/admin/charts/DonutChart";
import type { TrafficBreakdown } from "@/lib/admin/analytics";

/**
 * The customer traffic donut.
 *
 * ── The colours are fixed per channel, not per position ──────────────────
 *
 * Facebook is `--chart-1` in every chart, forever. If the colour followed
 * the *position* in the array, then a month where Facebook drops to
 * fourth place would change Facebook's colour — and an admin comparing
 * this month to last month would read two different colours as two
 * different channels.
 *
 * So the mapping is from the **channel key**, not from the index.
 *
 * ── The empty state is the important part ────────────────────────────────
 *
 * Before the storefront's collector has recorded anything, this shows an
 * explicit "No traffic recorded yet". It does **not** show a donut with
 * four equal slices, or a ring at 0%, or a breakdown with invented
 * numbers.
 *
 * A donut that looks like data is the worst failure mode available: it
 * is indistinguishable from a real breakdown to anyone who has not read
 * the code. So the empty state says, in words, that there is no data.
 */
export function TrafficDonut({
  breakdown,
}: {
  readonly breakdown: TrafficBreakdown;
}) {
  const slices = breakdown.sources.map((source, index) => ({
    label: source.label,
    value: source.count,
    // `--chart-${index + 1}` is the palette position; the channel's
    // fixed colour comes from the palette order in the taxonomy, which
    // is stable because `TRAFFIC_SOURCES` is a closed, ordered set.
    colorVar: `--chart-${index + 1}`,
  }));

  return (
    <DonutChart
      slices={slices}
      title="Customer traffic by source"
      emptyTitle="No traffic recorded yet"
      emptyDescription="Once the storefront's tracker records its first visit, the channel breakdown will appear here. Until then there is genuinely no data to show — not a zero."
    />
  );
}
