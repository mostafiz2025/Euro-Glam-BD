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
  StatusBadge,
} from "@/components/admin/primitives";
import {
  getGrowthMetrics,
  getSalesSeries,
  getTrafficBreakdown,
  type SalesRange,
} from "@/lib/admin/analytics";
import { getDashboardStats, listLowStockProducts } from "@/lib/admin/stats";
import { getProfitMetrics } from "@/lib/admin/profit";
import { formatPaisa } from "@/lib/format/money";

/**
 * The admin overview.
 *
 * ── What this page is ────────────────────────────────────────────────────
 *
 * The shop's morning check. It answers four questions in one screen:
 *
 *   • How much money has come in, and is it going up?
 *   • How much of that was profit?
 *   • How many orders are waiting to be fulfilled?
 *   • Is anything out of stock?
 *   • Where are the customers coming from?
 *
 * The questions map to the things an operator can act on, so each tile
 * links to the screen where the work happens. A dashboard that reports a
 * problem without offering a way to reach it is a report, not a
 * dashboard.
 *
 * ── Every counter is read from the database ───────────────────────────────
 *
 * The fulfilment counters — pending, processing, shipped, delivered,
 * cancelled — are **not** hard-coded, and they are not derived from a
 * cached summary. Each one is a `count()` against the `orders` table
 * with the status in the filter, and they all run in the same
 * `Promise.all` as everything else. There is no code path that can
 * render a stale number: the page reads the table, and the table is
 * the truth.
 *
 * "Orders in flight" is the one derived figure, and it is derived
 * **here** rather than as a fourth query — `pending + processing +
 * shipped`. Deriving it from the three counters that were just read
 * means it cannot disagree with them, and a fourth query would be a
 * fourth chance for the number to be wrong in a different way.
 *
 * ── Revenue and profit are different figures ─────────────────────────────
 *
 * The **Revenue** tile is the order value of everything that has not
 * been cancelled — shipping included. It answers "how much money came
 * in".
 *
 * The **Profit & margin** panel answers a different question: "how much
 * of that survived the cost of the goods?". It is computed per order
 * line, over the lines whose cost has been recorded, and it reports
 * how many lines it left out and why. The two figures are deliberately
 * **not** reconciled to each other — reconciling them would mean
 * silently excluding the shipping and the uncosted lines from the
 * headline number, and a headline number that quietly means something
 * other than what it says is worse than two numbers that are each
 * exactly what they claim to be.
 *
 * ── Where the numbers come from ──────────────────────────────────────────
 *
 * The server. The page calls `getDashboardStats()` and the analytics
 * services directly rather than fetching `/api/admin/stats` over HTTP —
 * a server component fetching from its own application is a network
 * round-trip to itself, and the service is the *same* code the API route
 * calls, so the two cannot disagree.
 *
 * ── The failure case ─────────────────────────────────────────────────────
 *
 * If the statistics cannot be loaded, the page says so. It does not
 * render zeros.
 *
 * This is the important part. A dashboard that shows "0 orders" because
 * the database was unreachable is a dashboard that will eventually be
 * believed. Zero is a *claim about the shop*; "we could not load the
 * numbers" is a claim about the connection. Conflating them is how a
 * real outage turns into a panic, or worse, into a false all-clear.
 *
 * The analytics are **optional**, though. A failure to load the growth
 * metrics or the traffic breakdown removes those panels — it does not
 * take down the page, because the operational figures above them are
 * still perfectly good news and still need to be seen.
 */
export const metadata: Metadata = {
  title: "Overview",
};

/**
 * The overview is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminOverviewPage({
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

  const stats = await getDashboardStats().catch((error: unknown) => {
    console.error("[admin] Dashboard statistics failed:", error);
    return null;
  });

  if (!stats) {
    return (
      <>
        <PageHeading
          title="Overview"
          description="The shop's morning check."
        />

        <AdminErrorState message="We could not load the dashboard numbers. Please try again in a moment." />
      </>
    );
  }

  /*
   * The analytics are loaded **independently** of the operational
   * figures, and each one fails on its own.
   *
   * A chart is a bonus; the pending-orders count is the work. If the
   * analytics query fails, the panels say so and the operator still gets
   * their morning check. Bundling them into one `Promise.all` would let
   * a slow traffic query take down the whole page.
   */
  const [growth, series, traffic, lowStock, profit] = await Promise.all([
    getGrowthMetrics().catch((error: unknown) => {
      console.error("[admin] Growth metrics failed:", error);
      return null;
    }),
    getSalesSeries(range).catch((error: unknown) => {
      console.error("[admin] Sales series failed:", error);
      return null;
    }),
    getTrafficBreakdown(30).catch((error: unknown) => {
      console.error("[admin] Traffic breakdown failed:", error);
      return null;
    }),
    listLowStockProducts(5).catch((error: unknown) => {
      console.error("[admin] Low-stock list failed:", error);
      return null;
    }),
    /*
     * The profit figures, loaded the same way — independently, and
     * failing on their own.

     * A failure here removes the profit panel and leaves the rest of
     * the dashboard standing. The revenue tile above is a *different*
     * figure from the revenue in the profit panel — the tile includes
     * shipping and orders whose costs are unknown, and the panel
     * reports the margin on the goods whose cost the shop knows — so
     * the panel's failure must not take the tile down with it.
     */
    getProfitMetrics().catch((error: unknown) => {
      console.error("[admin] Profit metrics failed:", error);
      return null;
    }),
  ]);

  const { orders, products, reviews, users } = stats;

  return (
    <>
      <PageHeading
        title="Overview"
        description="The shop's morning check — what needs attention today."
      />

      {/* ── The four headline figures ───────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Revenue"
          value={formatPaisa(orders.revenuePaisa)}
          hint={`${orders.total} orders all time`}
          tone="good"
          trend={growth?.revenue}
        />

        <StatTile
          label="Orders in flight"
          value={orders.inFlight}
          hint={`${orders.pending} awaiting packing`}
          tone={orders.pending > 0 ? "warn" : "neutral"}
          trend={growth?.orders}
        />

        <StatTile
          label="Pending reviews"
          value={reviews.pending}
          hint={`${reviews.total} reviews all time`}
          tone={reviews.pending > 0 ? "warn" : "neutral"}
        />

        <StatTile
          label="Customers"
          value={users.customers}
          hint={`${users.admins} administrator${users.admins === 1 ? "" : "s"}`}
          trend={growth?.newUsers}
        />
      </div>

      {/* ── The charts ───────────────────────────────────────────────── */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ChartFrame
          title="Revenue trend"
          description={
            range === "DAILY"
              ? "The last 30 days, by day."
              : range === "WEEKLY"
                ? "The last 12 weeks, by week."
                : "The last 12 months, by month."
          }
          action={<RangeSwitcher current={range} />}
        >
          {series ? (
            <LineChart
              points={series.map((point) => point.revenuePaisa)}
              labels={series.map((point) => point.label)}
              formatValue={(value) => formatPaisa(value)}
              title="Revenue over time"
            />
          ) : (
            <ChartUnavailable />
          )}
        </ChartFrame>

        <ChartFrame
          title="Customer traffic"
          description="Where the last 30 days of visits came from."
        >
          {traffic ? (
            <TrafficDonut breakdown={traffic} />
          ) : (
            <ChartUnavailable />
          )}
        </ChartFrame>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ── Profit ───────────────────────────────────────────────── */}
        {/*
          The profit panel.

          It answers "how much of the money that came in was actually
          profit", which the revenue tile above cannot: revenue says
          how much was charged, and the difference between the two is
          what the shop kept.

          The figures are **line-level**, over the order lines whose
          cost is known. A line with no recorded cost is excluded, and
          the count of excluded lines is reported — so the reader can
          see how much of the business the margin covers. A margin
          computed over four lines out of two hundred is a different
          claim from a margin computed over all of them.

          The panel's revenue is **not** the same number as the revenue
          tile above, and it says so. The tile is the money that came
          in — shipping included, orders with unknown costs included.
          This one is the margin on the goods whose cost the shop knows.
        */}
        <AdminCard>
          <AdminCardHeader
            title="Profit & margin"
            description="What the shop kept, on the sales whose cost is known."
            action={
              <Link
                href="/admin/products"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                See the margins →
              </Link>
            }
          />

          {profit === null ? (
            <p className="px-5 py-8 text-center text-xs text-foreground-muted">
              We could not load the profit figures.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-px bg-surface-muted">
                {[
                  {
                    label: "Profit",
                    value: formatPaisa(profit.profitPaisa),
                    tone:
                      profit.profitPaisa < 0
                        ? "text-red-700"
                        : "text-foreground",
                  },
                  {
                    label: "Margin",
                    value:
                      profit.marginPercentage === null
                        ? "—"
                        : `${Math.round(profit.marginPercentage)}%`,
                    tone:
                      profit.profitPaisa < 0
                        ? "text-red-700"
                        : "text-foreground",
                  },
                  {
                    label: "Revenue on counted lines",
                    value: formatPaisa(profit.revenuePaisa),
                    tone: "text-foreground",
                  },
                  {
                    label: "Cost of goods sold",
                    value: formatPaisa(profit.costPaisa),
                    tone: "text-foreground",
                  },
                ].map((row) => (
                  <div key={row.label} className="bg-surface px-5 py-4">
                    <dt className="text-xs text-foreground-muted">
                      {row.label}
                    </dt>
                    <dd
                      className={`mt-1 font-serif text-2xl font-bold tabular-nums ${row.tone}`}
                    >
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="border-t border-border px-5 py-3 text-xs text-foreground-muted">
                {/*
                  The coverage line.

                  It says how many lines the margin was computed over,
                  how many were left out because their cost was never
                  recorded, and how much discount was given away — so
                  the reader is never looking at a precise-looking
                  number without knowing what it covers.
                */}
                {profit.countedLines} of {profit.countedLines + profit.excludedLines}{" "}
                sale line{profit.countedLines + profit.excludedLines === 1 ? "" : "s"} counted
                {profit.excludedLines > 0 ? (
                  <>
                    {" · "}
                    {profit.excludedLines} left out (cost not recorded)
                  </>
                ) : null}
                {profit.discountPaisa > 0 ? (
                  <> · {formatPaisa(profit.discountPaisa)} given away in discounts</>
                ) : null}
              </p>
            </>
          )}
        </AdminCard>

        {/* ── Fulfilment ────────────────────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Order fulfilment"
            description="Where every order currently sits."
            action={
              <Link
                href="/admin/orders"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                Manage orders →
              </Link>
            }
          />

          <ul className="divide-y divide-neutral-100">
            {[
              { status: "PENDING", count: orders.pending, hint: "waiting to be packed" },
              { status: "PROCESSING", count: orders.processing, hint: "being prepared" },
              { status: "SHIPPED", count: orders.shipped, hint: "on the way" },
              { status: "DELIVERED", count: orders.delivered, hint: "completed" },
              { status: "CANCELLED", count: orders.cancelled, hint: "stock restored" },
            ].map((row) => (
              <li
                key={row.status}
                className="flex items-center justify-between gap-3 px-5 py-3"
              >
                <div className="flex items-center gap-2.5">
                  <StatusBadge status={row.status} />
                  <span className="text-xs text-foreground-muted">{row.hint}</span>
                </div>

                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {row.count}
                </span>
              </li>
            ))}
          </ul>
        </AdminCard>

        {/* ── Inventory ─────────────────────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Inventory"
            description="What is on the shelf, and what is not."
            action={
              <Link
                href="/admin/products"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                Manage inventory →
              </Link>
            }
          />

          <ul className="divide-y divide-neutral-100">
            {[
              {
                status: "IN_STOCK",
                count: products.inStock,
                hint: "available to buy",
                tone: "neutral" as const,
              },
              {
                status: "LOW_STOCK",
                count: products.lowStock,
                hint: "5 units or fewer",
                tone: "warn" as const,
              },
              {
                status: "OUT_OF_STOCK",
                count: products.outOfStock,
                hint: "not buyable",
                tone: "danger" as const,
              },
            ].map((row) => (
              <li
                key={row.status}
                className="flex items-center justify-between gap-3 px-5 py-3"
              >
                <div className="flex items-center gap-2.5">
                  <StatusBadge status={row.status} />
                  <span className="text-xs text-foreground-muted">{row.hint}</span>
                </div>

                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {row.count}
                </span>
              </li>
            ))}
          </ul>

          <p className="border-t border-border px-5 py-3 text-xs text-foreground-muted">
            {products.total} products · {products.totalUnits} units on the
            shelf
          </p>
        </AdminCard>

        {/* ── Low stock ──────────────────────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Low stock"
            description={
              products.lowStock > 0
                ? `${products.lowStock} product${products.lowStock === 1 ? "" : "s"} at five units or fewer.`
                : "Nothing is running low."
            }
            action={
              <Link
                href="/admin/products?stock=LOW_STOCK"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                See all →
              </Link>
            }
          />

          {lowStock === null ? (
            <p className="px-5 py-8 text-center text-xs text-foreground-muted">
              We could not load the low-stock list.
            </p>
          ) : lowStock.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-foreground-muted">
              Every product has more than five units on the shelf.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {lowStock.map((product) => (
                <li
                  key={product.id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <Link
                    href={`/products/${product.id}`}
                    className="min-w-0 truncate text-sm text-foreground underline-offset-2 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                  >
                    {product.name}
                  </Link>

                  <span className="shrink-0 text-sm font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                    {product.stockQuantity} left
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminCard>

        {/* ── Moderation ────────────────────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Review moderation"
            description="What has been published, and what has not."
            action={
              <Link
                href="/admin/reviews"
                className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                Moderate reviews →
              </Link>
            }
          />

          <ul className="divide-y divide-neutral-100">
            {[
              { status: "PENDING", count: reviews.pending, hint: "awaiting a decision" },
              { status: "APPROVED", count: reviews.approved, hint: "published" },
              { status: "HIDDEN", count: reviews.hidden, hint: "withdrawn" },
            ].map((row) => (
              <li
                key={row.status}
                className="flex items-center justify-between gap-3 px-5 py-3"
              >
                <div className="flex items-center gap-2.5">
                  <StatusBadge status={row.status} />
                  <span className="text-xs text-foreground-muted">{row.hint}</span>
                </div>

                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {row.count}
                </span>
              </li>
            ))}
          </ul>
        </AdminCard>

        {/* ── Customers ─────────────────────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Customers"
            description="Who has an account, and who can be reminded."
          />

          <dl className="grid grid-cols-2 gap-px bg-surface-muted">
            {[
              { label: "Total accounts", value: users.total },
              { label: "Customers", value: users.customers },
              { label: "Administrators", value: users.admins },
              { label: "SMS reminders on", value: users.smsOptIn },
            ].map((row) => (
              <div key={row.label} className="bg-surface px-5 py-4">
                <dt className="text-xs text-foreground-muted">{row.label}</dt>
                <dd className="mt-1 font-serif text-2xl font-bold tabular-nums text-foreground">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </AdminCard>
      </div>
    </>
  );
}

/**
 * The page heading.
 */

/**
 * The sales-range switcher.
 *
 * A link, not a button. It navigates — it changes the URL's query
 * parameter and the server re-renders the chart with a different
 * granularity. A `<button>` would be the wrong element for a navigation,
 * and it would break the middle-click-and-open-in-a-new-tab gesture that
 * every browser user expects from a link.
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
            href={`/admin?range=${range.value}`}
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
        dashboard is unaffected.
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
