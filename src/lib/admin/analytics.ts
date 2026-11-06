import { db } from "@/lib/db";

/**
 * The admin analytics service.
 *
 * ── Why this is separate from `stats.ts` ──────────────────────────────────
 *
 * `getDashboardStats()` returns **totals**. It answers "how much money
 * has come in?" — a question with one number.
 *
 * Analytics answers a different question: "how has that number
 * *moving*?". That needs a time series, a comparison against a previous
 * period, and a traffic breakdown — none of which fit the shape of a
 * totals object, and all of which would bloat the totals service if
 * they were forced into it.
 *
 * So the two live apart. `stats.ts` keeps its existing behaviour
 * exactly; this module is new.
 *
 * ── The revenue rule ──────────────────────────────────────────────────────
 *
 * **Revenue excludes cancelled orders.** The money was never taken, so
 * a cancelled COD order contributes nothing. This is the same rule
 * `getDashboardStats` already uses, and the two must agree — a revenue
 * figure that changed depending on which page you looked at would be a
 * bug in the dashboard's most important number.
 *
 * **Order volume includes them.** An abandoned order is still a demand
 * signal — it says something was wanted and the process failed. The
 * asymmetry is deliberate and documented here because it looks like an
 * inconsistency otherwise.
 *
 * ── The timezone ──────────────────────────────────────────────────────────
 *
 * `orders.createdAt` is `TIMESTAMP(3)` — **no timezone**. So every
 * comparison here is against the server's local time, and the SQL casts
 * both sides of every date comparison to `timestamp` explicitly.
 *
 * Mixing `timestamp` and `timestamptz` in one comparison is a classic
 * off-by-one-day chart bug: the series silently shifts, or duplicates a
 * day at the boundary, depending on the server's offset. The casts make
 * the two sides agree by construction.
 */

/**
 * The granularity of a sales series.
 */
export type SalesRange = "DAILY" | "WEEKLY" | "MONTHLY";

/**
 * One point on a sales series.
 */
export type SalesPoint = {
  /** The axis label — "12 Oct", "3 Nov", "October 2026". */
  readonly label: string;
  /** The revenue in that period, in poisha. */
  readonly revenuePaisa: number;
  /** The number of orders in that period. */
  readonly orders: number;
  /** The number of units sold in that period. */
  readonly unitsSold: number;
};

/**
 * A growth metric.
 */
export type GrowthMetric = {
  /** The current period's value. */
  readonly current: number;
  /** The previous period's value. */
  readonly previous: number;
  /**
   * The percentage change.
   *
   * `null` when the percentage is **undefined** — see `GrowthKind`.
   */
  readonly percentage: number | null;
  /** How the change should be described. */
  readonly kind: GrowthKind;
};

/**
 * How a growth metric should be described.
 *
 * `NEW` exists because a percentage against a zero base is a lie. If
 * last month had no revenue and this month has some, "0%" and "+100%"
 * are both wrong: the percentage is not defined, and the honest answer
 * is "new activity".
 */
export type GrowthKind = "UP" | "DOWN" | "FLAT" | "NEW";

/**
 * The growth metrics for the dashboard.
 */
export type GrowthMetrics = {
  readonly revenue: GrowthMetric;
  readonly newUsers: GrowthMetric;
  readonly orders: GrowthMetric;
  readonly productsSold: GrowthMetric;
};

/**
 * The number of days in each comparison window.
 *
 * Thirty, because a month is the interval a shop owner thinks in, and
 * thirty days is a close enough approximation that the two windows do
 * not overlap.
 */
const WINDOW_DAYS = 30;

/**
 * The number of points in a daily series.
 */
const DAILY_POINTS = 30;

/**
 * The number of points in a weekly series.
 */
const WEEKLY_POINTS = 12;

/**
 * The number of points in a monthly series.
 */
const MONTHLY_POINTS = 12;

/**
 * Computes a growth metric from two period values.
 *
 * ── The zero-base rule ────────────────────────────────────────────────────
 *
 * When the previous value is zero, a percentage is not defined. So:
 *
 *   • `previous === 0 && current > 0` → **NEW**
 *   • `previous === 0 && current === 0` → **FLAT**
 *
 * The alternative — reporting "+100%" — would be an invented number
 * attached to a real figure, which is exactly the sort of thing that
 * makes a dashboard untrustworthy.
 */
export function computeGrowth(current: number, previous: number): GrowthMetric {
  if (previous === 0) {
    return {
      current,
      previous,
      percentage: null,
      kind: current > 0 ? "NEW" : "FLAT",
    };
  }

  const percentage = ((current - previous) / previous) * 100;

  // A tiny change rounds to zero. Reporting "0.0% up" when nothing
  // moved is noise; "flat" is the honest description.
  if (Math.round(percentage) === 0) {
    return { current, previous, percentage: 0, kind: "FLAT" };
  }

  return {
    current,
    previous,
    percentage,
    kind: percentage > 0 ? "UP" : "DOWN",
  };
}

/**
 * Formats a growth metric for display.
 *
 * "NEW" when the base was zero, "—" when there is nothing to compare
 * against, and a signed percentage otherwise.
 */
export function formatGrowth(metric: GrowthMetric): string {
  if (metric.kind === "NEW") return "NEW";
  if (metric.percentage === null) return "—";

  const rounded = Math.round(metric.percentage);

  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/**
 * The number of buckets in a series.
 */
function bucketCount(range: SalesRange): number {
  switch (range) {
    case "DAILY":
      return DAILY_POINTS;
    case "WEEKLY":
      return WEEKLY_POINTS;
    case "MONTHLY":
      return MONTHLY_POINTS;
  }
}

/**
 * Loads the sales series.
 *
 * ── Why the series is zero-filled ─────────────────────────────────────────
 *
 * A day with no orders is an explicit **zero**, not a gap. A chart that
 * skips empty days compresses its own axis and draws a straight line
 * across a week in which nothing was sold — which reads as "steady
 * trading" when the truth is "nothing happened".
 *
 * So the SQL generates the full period with `generate_series` and
 * `LEFT JOIN`s the aggregate onto it. The series always has exactly
 * `bucketCount` points, in order, with no holes.
 *
 * ── Why the aggregation happens in SQL and not in JavaScript ──────────────
 *
 * Filling a series in JavaScript would mean fetching every order in the
 * window and grouping them in memory. The SQL groups in the database
 * and returns one row per bucket, which is both faster and a smaller
 * transfer.
 */
export async function getSalesSeries(range: SalesRange): Promise<SalesPoint[]> {
  const points = bucketCount(range);

  // The bucket unit and the step between buckets. Both are fixed
  // strings chosen from the range — never user input.
  //
  // They are interpolated into the SQL rather than parameterised
  // because `date_trunc` and `interval` take their unit as a
  // **literal**, not as a bind parameter: `date_trunc($1, ts)` does
  // not compile, because the unit must be known at parse time.
  //
  // This is safe precisely because the range is a closed set of three
  // values, each mapping to a fixed literal. Nothing user-controlled
  // reaches this string.
  const unit =
    range === "DAILY" ? "day" : range === "WEEKLY" ? "week" : "month";

  const step =
    range === "DAILY" ? "1 day" : range === "WEEKLY" ? "1 week" : "1 month";

  // The bucket expression, used in both aggregate CTEs.
  const bucket = `date_trunc('${unit}', o."createdAt"::timestamp)`;

  // The window's start, truncated to the bucket boundary.
  //
  // `generate_series` is **inclusive of both endpoints**, so a span of
  // `points` intervals yields `points + 1` buckets. The series must
  // have exactly `points` points — a chart whose x-axis has one more
  // tick than the data is a chart with an off-by-one in its axis — so
  // the span is `points - 1` intervals back.
  //
  // The `::timestamp` cast on both sides is the point of this whole
  // query. `orders.createdAt` is `TIMESTAMP(3)` — no timezone — so
  // every comparison is against the server's local time. Casting
  // explicitly keeps both sides in the same type, which is what stops
  // the series silently shifting by a day at the boundary.
  const start = `date_trunc('${unit}', (now()::timestamp - (${points - 1} * interval '${step}')))`;

  // The query is assembled as one string and run raw, because the
  // `interval` literal cannot be a bind parameter.
  //
  // Every interpolated fragment is derived from `range` — a closed set
  // of three values — so there is no injection surface here. The
  // `points` count is likewise a constant per range.
  const sql = `
    WITH buckets AS (
      SELECT generate_series(
        ${start}::timestamp,
        date_trunc('${unit}', now()::timestamp),
        interval '${step}'
      )::timestamp AS bucket
    ),
    revenue AS (
      SELECT
        ${bucket} AS bucket,
        SUM(o."totalAmountPaisa")::bigint AS revenue,
        COUNT(*)::bigint AS orders
      FROM orders o
      WHERE o."status" <> 'CANCELLED'
        AND o."createdAt"::timestamp >= ${start}::timestamp
      GROUP BY 1
    ),
    units AS (
      SELECT
        ${bucket} AS bucket,
        SUM(oi.quantity)::bigint AS units
      FROM order_items oi
      JOIN orders o ON o.id = oi."orderId"
      WHERE o."createdAt"::timestamp >= ${start}::timestamp
      GROUP BY 1
    )
    SELECT
      b.bucket,
      COALESCE(r.revenue, 0)::bigint AS revenue,
      COALESCE(r.orders, 0)::bigint AS orders,
      COALESCE(u.units, 0)::bigint AS units
    FROM buckets b
    LEFT JOIN revenue r ON r.bucket = b.bucket
    LEFT JOIN units u ON u.bucket = b.bucket
    ORDER BY b.bucket ASC
  `;

  const rows = await db.$queryRawUnsafe<
    {
      bucket: Date;
      revenue: bigint;
      orders: bigint;
      units: bigint;
    }[]
  >(sql);

  return rows.map((row) => ({
    label: formatBucketLabel(row.bucket, range),
    // The aggregates come back as `bigint`, which Prisma surfaces as a
    // `BigInt`. `Number()` converts it — safe here, because these are
    // counts and poisha amounts well inside the safe-integer range.
    revenuePaisa: Number(row.revenue ?? 0),
    orders: Number(row.orders ?? 0),
    unitsSold: Number(row.units ?? 0),
  }));
}

/**
 * Formats a bucket's axis label.
 */
function formatBucketLabel(bucket: Date, range: SalesRange): string {
  const date = new Date(bucket);

  switch (range) {
    case "DAILY":
      return date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      });
    case "WEEKLY":
      return date.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      });
    case "MONTHLY":
      return date.toLocaleDateString("en-GB", {
        month: "long",
        year: "numeric",
      });
  }
}

/**
 * Loads the growth metrics.
 *
 * Each metric compares the **last 30 days** against the **30 days
 * before that**.
 *
 * The revenue metric excludes cancelled orders; the order metric
 * includes them. See the note at the top of this file.
 */
export async function getGrowthMetrics(): Promise<GrowthMetrics> {
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);

  const previousStart = new Date();
  previousStart.setDate(previousStart.getDate() - WINDOW_DAYS * 2);

  const [
    revenueCurrent,
    revenuePrevious,
    ordersCurrent,
    ordersPrevious,
    usersCurrent,
    usersPrevious,
    unitsCurrent,
    unitsPrevious,
  ] = await Promise.all([
    db.order.aggregate({
      where: {
        status: { not: "CANCELLED" },
        createdAt: { gte: windowStart },
      },
      _sum: { totalAmountPaisa: true },
    }),
    db.order.aggregate({
      where: {
        status: { not: "CANCELLED" },
        createdAt: { gte: previousStart, lt: windowStart },
      },
      _sum: { totalAmountPaisa: true },
    }),
    db.order.count({ where: { createdAt: { gte: windowStart } } }),
    db.order.count({
      where: { createdAt: { gte: previousStart, lt: windowStart } },
    }),
    db.user.count({ where: { createdAt: { gte: windowStart } } }),
    db.user.count({
      where: { createdAt: { gte: previousStart, lt: windowStart } },
    }),
    db.orderItem.aggregate({
      where: { order: { createdAt: { gte: windowStart } } },
      _sum: { quantity: true },
    }),
    db.orderItem.aggregate({
      where: {
        order: { createdAt: { gte: previousStart, lt: windowStart } },
      },
      _sum: { quantity: true },
    }),
  ]);

  return {
    revenue: computeGrowth(
      revenueCurrent._sum.totalAmountPaisa ?? 0,
      revenuePrevious._sum.totalAmountPaisa ?? 0,
    ),
    newUsers: computeGrowth(usersCurrent, usersPrevious),
    orders: computeGrowth(ordersCurrent, ordersPrevious),
    productsSold: computeGrowth(
      unitsCurrent._sum.quantity ?? 0,
      unitsPrevious._sum.quantity ?? 0,
    ),
  };
}

/**
 * The traffic source breakdown.
 */
export type TrafficBreakdown = {
  /** The sources, largest first. */
  readonly sources: readonly {
    /** The bucket key, e.g. "facebook". */
    readonly source: string;
    /** The human label, e.g. "Facebook". */
    readonly label: string;
    /** How many visits landed in this bucket. */
    readonly count: number;
    /** The share of the total, 0–100. */
    readonly share: number;
  }[];
  /** The total number of recorded visits. */
  readonly total: number;
};

/**
 * The labels for the traffic buckets.
 *
 * The taxonomy is closed — see `src/lib/traffic.ts`. These labels live
 * here rather than there because they are an *admin display* concern:
 * the collector buckets a host, and the console decides what to call it.
 */
const TRAFFIC_LABELS: Record<string, string> = {
  facebook: "Facebook",
  organic: "Organic",
  direct: "Direct",
  email: "Email",
  other: "Other",
};

/**
 * Loads the traffic breakdown for the dashboard donut.
 *
 * The buckets come from the closed taxonomy, so every known source
 * appears in the result — including the ones with a count of zero. A
 * bucket that is missing from the legend looks like a bucket that does
 * not exist, which is a different claim from "no visits came from
 * there".
 *
 * The counts are grouped by the stored bucket, and the *share* is
 * computed against the total, so the shares always sum to 100.
 */
export async function getTrafficBreakdown(
  days = 30,
): Promise<TrafficBreakdown> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const grouped = await db.trafficEvent.groupBy({
    by: ["source"],
    where: { createdAt: { gte: since } },
    _count: { source: true },
  });

  const total = grouped.reduce(
    (sum, row) => sum + row._count.source,
    0,
  );

  const counts = new Map(
    grouped.map((row) => [row.source, row._count.source]),
  );

  // Every bucket in the taxonomy, in a fixed order, with the traffic
  // that actually arrived.
  const sources = Object.keys(TRAFFIC_LABELS).map((source) => {
    const count = counts.get(source) ?? 0;

    return {
      source,
      label: TRAFFIC_LABELS[source],
      count,
      share: total > 0 ? (count / total) * 100 : 0,
    };
  });

  // Any source that is not in the taxonomy — a row written by an older
  // version, or a hand-edited one — is still reported, under "Other".
  // Dropping it silently would make the counts not add up.
  for (const row of grouped) {
    if (row.source in TRAFFIC_LABELS) continue;

    const existing = sources.find((entry) => entry.source === "other");

    if (!existing) continue;

    const extra = row._count.source;

    const index = sources.indexOf(existing);

    const merged = {
      ...existing,
      count: existing.count + extra,
      share:
        total > 0 ? ((existing.count + extra) / total) * 100 : existing.share,
    };

    sources[index] = merged;
  }

  return { sources, total };
}

/**
 * The store-visits and conversion figures for the Analytics page.
 */
export type FunnelMetrics = {
  /**
   * The number of recorded visits in the window.
   *
   * A **visit**, not a visitor. One person who browses six pages
   * produced six events, and this counts all six. The alternative —
   * counting distinct `visitorId`s — would be "visitors", and it would
   * need a `DISTINCT` over a column with no index on it, which is a
   * scan of the whole table for a number that reads as more precise
   * than it is.
   */
  readonly visits: number;
  /** The number of orders placed in the window. */
  readonly orders: number;
  /**
   * The conversion rate, as a percentage: orders ÷ visits.
   *
   * `null` when there were **no visits**. A rate against a zero base is
   * a division by zero wearing a percentage's clothes — the same rule
   * the growth metrics follow. The page renders it as "—".
   */
  readonly conversionRate: number | null;
  /** The net revenue in the window, in poisha. */
  readonly revenuePaisa: number;
  /** The number of units sold in the window. */
  readonly unitsSold: number;
};

/**
 * Computes the conversion rate.
 *
 * ── The zero-base rule, again ────────────────────────────────────────────
 *
 * A rate against a zero base is a division by zero wearing a
 * percentage's clothes. When there were no visits, the rate is **not
 * defined** — so it is `null`, and the page renders "—".
 *
 * Reporting "0%" would be wrong twice over: it claims a rate of zero
 * (no visits converted) when the truth is that there was nothing to
 * convert. Reporting "+100%" would be worse.
 *
 * Pure, so the rule is directly testable.
 */
export function computeConversionRate(
  orders: number,
  visits: number,
): number | null {
  if (visits <= 0) return null;

  return (orders / visits) * 100;
}

/**
 * Loads the funnel metrics — visits, orders and the conversion rate.
 *
 * ── The two populations do not have to match ─────────────────────────────
 *
 * Visits are counted from `trafficEvent` and orders from `order`, over
 * the **same window**. But they are counted over the **same window**,
 * not the same population: a visit is any recorded page-view, and an
 * order is any order — including one placed by a customer who
 * navigated directly to checkout, or who arrived before the collector
 * was first deployed.
 *
 * So the conversion rate is a **ratio of two counts over a period**, not
 * a per-visitor funnel. It is a directional indicator — "are we turning
 * a good share of our traffic into orders?" — and it is labelled as
 * such in the page's copy.
 *
 * It is also worth being explicit about what it is **not**: it is not
 * a measure of how many of *today's* visitors bought, because the
 * denominator and the numerator are drawn from the same window rather
 * than from the same people.
 *
 * ── The revenue rule again ────────────────────────────────────────────────
 *
 * Revenue excludes cancelled orders, and order *volume* includes them.
 * Same rule as the growth metrics — see the note at the top of this
 * file. The two must agree with the dashboard, or the same number
 * would differ between two pages of the same console.
 */
export async function getFunnelMetrics(
  days = 30,
): Promise<FunnelMetrics> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [visits, orders, revenue, units] = await Promise.all([
    db.trafficEvent.count({ where: { createdAt: { gte: since } } }),
    db.order.count({ where: { createdAt: { gte: since } } }),
    db.order.aggregate({
      where: { status: { not: "CANCELLED" }, createdAt: { gte: since } },
      _sum: { totalAmountPaisa: true },
    }),
    db.orderItem.aggregate({
      where: { order: { createdAt: { gte: since } } },
      _sum: { quantity: true },
    }),
  ]);

  return {
    visits,
    orders,
    conversionRate: computeConversionRate(orders, visits),
    revenuePaisa: revenue._sum.totalAmountPaisa ?? 0,
    unitsSold: units._sum.quantity ?? 0,
  };
}
