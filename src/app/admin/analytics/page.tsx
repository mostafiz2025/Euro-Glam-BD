import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { ChartFrame } from "@/components/admin/charts/ChartFrame";
import { LineChart } from "@/components/admin/charts/LineChart";
import { TrafficDonut } from "@/components/admin/charts/TrafficDonut";
import {
  AdminCard,
  AdminCardHeader,
  AdminErrorState,
  StatTile,
} from "@/components/admin/primitives";
import {
  getFunnelMetrics,
  getGrowthMetrics,
  getSalesSeries,
  getTrafficBreakdown,
  type SalesRange,
} from "@/lib/admin/analytics";
import { formatPaisa } from "@/lib/format/money";

/**
 * The admin analytics page.
 *
 * ── What this page is, and how it differs from the dashboard ─────────────
 *
 * The dashboard answers *"what needs attention today?"*. This page
 * answers *"how is the shop doing over time, and where is the traffic
 * coming from?"*.
 *
 * The distinction is one of depth, not of kind: the same underlying
 * numbers, arranged for a question the dashboard is too cramped to
 * answer. The dashboard is a morning glance — four tiles, two charts,
 * and the queues that need a human. This is the deeper cut: the
 * funnel, the trend, and the channel mix, with room to read them.
 *
 * ── Why the numbers are real ──────────────────────────────────────────────
 *
 * **Net Revenue** comes from `db.order`, summing `totalAmountPaisa`
 * over the orders that were not cancelled.
 *
 * **Total Orders** comes from `db.order`, counting *every* order
 * including the cancelled ones — an abandoned order is still a demand
 * signal, and the same asymmetry the analytics service already uses.
 *
 * **Store Visits** comes from `db.trafficEvent` — the real collector
 * that the storefront's beacon writes to. There is no seeded data and
 * no fallback: before the collector has recorded anything, the figure
 * is genuinely zero, and the traffic panel says so in words rather than
 * drawing a donut of invented slices.
 *
 * **Conversion Rate** is `orders ÷ visits` over the same window.
 *
 * ── The failure case is not the empty case ────────────────────────────────
 *
 * This page has three distinct states, and conflating them would be a
 * lie:
 *
 *   1. **The figures loaded.** They are shown.
 *   2. **The figures loaded and there is no data.** Zero visits, zero
 *      orders. That is a true statement about the shop, and it is
 *      shown as zero.
 *   3. **The figures could not be loaded.** An outage. The panel says
 *      so, in words, and does not render zeros.
 *
 * A dashboard that shows "0% conversion" because the database was
 * unreachable is a dashboard that will eventually be believed.
 *
 * The four metrics load **together** and fail **together**, because
 * they are one story — a funnel. A half-drawn funnel, with revenue on
 * top and a blank conversion rate below, invites the reader to compute
 * the missing piece from the numbers in front of them. The trend and
 * the traffic panel load **independently**, because a chart is a bonus
 * and must never take down the page.
 */
export const metadata: Metadata = {
  title: "Analytics",
};

/**
 * The page is session-gated, so it is rendered at request time.
 */
export const instant = false;

/**
 * The window, in days, that the page reports over.
 *
 * Thirty days — the same window the growth metrics compare against, so
 * the "last 30 days" figure on a tile and the "+12%" badge beside it
 * are describing the **same period**. If the two windows disagreed, the
 * badge would be a comparison against a period the tile does not show.
 */
const WINDOW_DAYS = 30;

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly range?: string }>;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const params = await searchParams;

  const range: SalesRange = parseRange(params.range);

  /*
   * The four headline figures are one query group — a funnel — so they
   * load together and fail together.
   */
  const funnel = await getFunnelMetrics(WINDOW_DAYS).catch(
    (error: unknown) => {
      console.error("[admin] Funnel metrics failed:", error);
      return null;
    },
  );

  /*
   * The charts are loaded **independently** of each other and of the
   * funnel. A chart is a bonus; the figures are the work. If the trend
   * query fails, the panel says so and the operator still gets their
   * numbers.
   */
  const [growth, series, traffic] = await Promise.all([
    getGrowthMetrics().catch((error: unknown) => {
      console.error("[admin] Growth metrics failed:", error);
      return null;
    }),
    getSalesSeries(range).catch((error: unknown) => {
      console.error("[admin] Sales series failed:", error);
      return null;
    }),
    getTrafficBreakdown(WINDOW_DAYS).catch((error: unknown) => {
      console.error("[admin] Traffic breakdown failed:", error);
      return null;
    }),
  ]);

  if (!funnel) {
    return (
      <>
        <PageHeading
          title="Analytics"
          description="How the shop is doing, and where the customers come from."
        />

        <AdminErrorState message="We could not load the analytics. Please try again in a moment." />
      </>
    );
  }

  const { visits, orders, conversionRate, revenuePaisa, unitsSold } = funnel;

  return (
    <>
      <PageHeading
        title="Analytics"
        description={`The last ${WINDOW_DAYS} days — revenue, traffic and conversion.`}
      />

      {/* ── The four headline figures ───────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Net revenue"
          value={formatPaisa(revenuePaisa)}
          hint={`${unitsSold} unit${unitsSold === 1 ? "" : "s"} sold`}
          tone="good"
          trend={growth?.revenue}
        />

        <StatTile
          label="Total orders"
          value={orders}
          hint={`across the last ${WINDOW_DAYS} days`}
          trend={growth?.orders}
        />

        <StatTile
          label="Store visits"
          value={visits}
          hint={
            visits > 0
              ? "recorded by the storefront tracker"
              : "nothing recorded yet"
          }
        />

        <StatTile
          label="Conversion rate"
          value={
            conversionRate === null ? "—" : `${conversionRate.toFixed(1)}%`
          }
          hint={
            conversionRate === null
              ? "no visits to convert yet"
              : `${orders} order${orders === 1 ? "" : "s"} from ${visits} visit${visits === 1 ? "" : "s"}`
          }
          tone={
            conversionRate === null
              ? "neutral"
              : conversionRate >= 2
                ? "good"
                : "neutral"
          }
        />
      </div>

      {/* ── The charts ───────────────────────────────────────────────── */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ChartFrame
          title="Revenue trend"
          description={
            range === "DAILY"
              ? `Net revenue by day, over the last ${WINDOW_DAYS} days.`
              : range === "WEEKLY"
                ? "Net revenue by week, over the last 12 weeks."
                : "Net revenue by month, over the last 12 months."
          }
          action={<RangeSwitcher current={range} />}
        >
          {series ? (
            <LineChart
              points={series.map((point) => point.revenuePaisa)}
              labels={series.map((point) => point.label)}
              formatValue={(value) => formatPaisa(value)}
              title="Net revenue over time"
            />
          ) : (
            <ChartUnavailable />
          )}
        </ChartFrame>

        <ChartFrame
          title="Traffic sources"
          description={`Where the last ${WINDOW_DAYS} days of visits came from.`}
        >
          {traffic ? (
            <TrafficDonut breakdown={traffic} />
          ) : (
            <ChartUnavailable />
          )}
        </ChartFrame>
      </div>

      {/* ── The channel table ─────────────────────────────────────────── */}
      <div className="mt-6">
        <AdminCard>
          <AdminCardHeader
            title="Traffic sources"
            description="Every channel in the taxonomy, including the ones with no traffic."
            action={
              <Link
                href="/admin"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                Back to overview →
              </Link>
            }
          />

          {traffic === null ? (
            <p className="px-5 py-8 text-center text-xs text-foreground-muted">
              We could not load the traffic breakdown.
            </p>
          ) : traffic.total === 0 ? (
            /*
             * The explicit empty state. The donut above already says
             * "no traffic recorded yet"; this repeats it in the table
             * form, because a table with no rows and no message is
             * ambiguous — is the channel mix empty, or did the query
             * fail?
             */
            <p className="px-5 py-8 text-center text-xs text-foreground-muted">
              No visits have been recorded yet. Once the storefront&apos;s
              tracker records its first visit, the channel breakdown will
              appear here.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {traffic.sources.map((source, index) => (
                <li
                  key={source.source}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="flex items-center gap-2.5">
                    {/*
                      The channel's swatch, in the **same** colour the
                      donut gave it. The mapping is from the channel's
                      position in the closed taxonomy, not from its rank
                      this month — so Facebook keeps its colour even in
                      a month where it drops to last place.
                    */}
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: `var(--chart-${index + 1})`,
                      }}
                    />

                    <span className="text-sm text-foreground">
                      {source.label}
                    </span>

                    <span className="text-xs text-foreground-muted">
                      {source.count} visit{source.count === 1 ? "" : "s"}
                    </span>
                  </div>

                  <span className="text-sm font-semibold tabular-nums text-foreground">
                    {source.share.toFixed(1)}%
                  </span>
                </li>
              ))}
            </ul>
          )}

          {traffic && traffic.total > 0 ? (
            <p className="border-t border-border px-5 py-3 text-xs text-foreground-muted">
              {traffic.total} visit{traffic.total === 1 ? "" : "s"} recorded in
              total
            </p>
          ) : null}
        </AdminCard>
      </div>
    </>
  );
}

/**
 * The sales-range switcher.
 *
 * A link, not a button. It navigates — it changes the URL's query
 * parameter and the server re-renders the chart with a different
 * granularity. A `<button>` would be the wrong element for a
 * navigation, and it would break the middle-click-and-open-in-a-new-tab
 * gesture that every browser user expects from a link.
 *
 * The active range is marked with `aria-current`, so the control says
 * where it is rather than relying on colour alone.
 */
function RangeSwitcher({ current }: { readonly current: SalesRange }) {
  const ranges: { readonly value: SalesRange; readonly label: string }[] = [
    { value: "DAILY", label: "Day" },
    { value: "WEEKLY", label: "Week" },
    { value: "MONTHLY", label: "Month" },
  ];

  return (
    <nav aria-label="Chart range" className="flex items-center gap-1">
      {ranges.map((range) => {
        const isActive = range.value === current;

        return (
          <Link
            key={range.value}
            href={`/admin/analytics?range=${range.value}`}
            aria-current={isActive ? "page" : undefined}
            className={[
              "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
              isActive
                ? "bg-brand-600 text-white"
                : "text-foreground-muted hover:bg-surface-muted hover:text-foreground",
            ].join(" ")}
          >
            {range.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The "the chart could not be loaded" panel.
 *
 * Deliberately distinct from the chart's own empty state. "No data for
 * this period" is a claim about the shop; "we could not load the chart"
 * is a claim about the connection. An admin who reads the first when
 * the second is true will conclude there were no orders.
 */
function ChartUnavailable() {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm font-semibold text-foreground">
        We could not load this chart
      </p>

      <p className="mx-auto mt-1.5 max-w-sm text-xs text-foreground-muted">
        The numbers behind this panel could not be read. The rest of the
        page is unaffected.
      </p>
    </div>
  );
}

/**
 * Parses the range from the query string.
 *
 * An unrecognised range falls back to `DAILY` **here**, on the page,
 * rather than being rejected. The page is a read-only view: refusing to
 * render because of a bad query parameter would leave an admin staring
 * at an error page when the fix is to click a different link. The API
 * route rejects an unknown range, because a machine caller should be
 * told.
 */
function parseRange(value: string | undefined): SalesRange {
  if (value === "WEEKLY" || value === "MONTHLY") return value;

  return "DAILY";
}

/**
 * The page heading.
 */
function PageHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>

      <p className="mt-1.5 text-sm text-foreground-muted">{description}</p>
    </div>
  );
}
