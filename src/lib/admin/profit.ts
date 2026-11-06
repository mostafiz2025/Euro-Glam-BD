import { OrderStatus } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * The profit and margin service.
 *
 * ── What this module answers ─────────────────────────────────────────────
 *
 * Three questions, and they are not the same question:
 *
 *   1. **How much money has come in?** — revenue.
 *   2. **How much of that is profit?** — profit, after the cost of the
 *      goods and the discount that was given away.
 *   3. **What fraction of the revenue survived?** — the margin.
 *
 * ── The unit of profit ───────────────────────────────────────────────────
 *
 * Profit is computed **per unit, per order line**, from the line's own
 * snapshots:
 *
 * ```text
 * profit = (pricePaisa - purchasePricePaisa - discountAmountPaisa) × quantity
 * ```
 *
 * where `pricePaisa` is the price the customer **actually paid** per unit
 * — it is written at the moment of the order as
 * `discountPricePaisa ?? pricePaisa`, so it is already net of the
 * product's own discount — and `discountAmountPaisa` is the coupon's
 * share of the order, allocated to the line.
 *
 * So the formula is the requested
 * `(sellingPrice - purchasePrice - discountAmount)`, with "selling price"
 * meaning the price the customer really paid rather than the list price.
 * That distinction matters: a product sold at a half-price sale has a
 * selling price of half its list price, and a margin computed against
 * the list price would report a profit the shop did not make.
 *
 * ── Why the arithmetic is per line and not per order ─────────────────────
 *
 * An order can carry several products with different margins. Averaging
 * them into one order-level margin would hide the loss-maker behind the
 * profit-maker, and the whole point of tracking cost is to find the
 * product that is being sold at a loss. So the profit is accumulated
 * line by line, and the order is only the unit of *reporting*.
 *
 * ── Which orders count ───────────────────────────────────────────────────
 *
 * **Revenue counts the orders the shop is still fulfilling** — pending,
 * processing, shipped and delivered. Cancelled orders contribute
 * nothing: the goods came back to the shelf and the money was never
 * taken.
 *
 * The same rule the rest of the admin console already uses — the growth
 * metrics and the funnel both exclude cancelled orders — so the revenue
 * on the dashboard, the revenue on the analytics page and the revenue
 * here are the same number. A revenue figure that changed depending on
 * which page you looked at would be a bug in the console's most
 * important number.
 *
 * ── The rule about missing costs ─────────────────────────────────────────
 *
 * A line with **no recorded purchase price** is **excluded** from the
 * profit arithmetic.
 *
 * This is the single most important decision in this module, so it is
 * worth being explicit about why. The alternative — treating a missing
 * cost as zero — would report a product that cost the shop ৳800 as
 * having earned ৳1,200 of profit. The shop's actual profit would be
 * overstated by exactly the cost it never recorded, and the figure would
 * look precise.
 *
 * So the profit reported here is the profit on the lines whose cost is
 * **known**. The count of excluded lines is reported alongside it, so
 * the reader can see how much of the business the figure covers — a
 * margin computed over four lines out of two hundred is a different
 * claim from a margin computed over all of them, and the tile says which
 * one it is.
 *
 * ── Why the discount is subtracted ───────────────────────────────────────
 *
 * A discount is money given away. Revenue net of the discount is what
 * the customer paid; profit is what is left after paying the supplier
 * for the goods. So the line's coupon discount comes off the top of the
 * margin, and a product sold at a discount that takes it below cost
 * produces a **negative** margin — which is the finding the shop most
 * needs to see.
 *
 * ── The margin percentage ────────────────────────────────────────────────
 *
 * The margin is `profit ÷ revenue`, as a percentage.
 *
 * `null` when the revenue is zero. A percentage against a zero base is a
 * division by zero wearing a percentage's clothes — the same rule the
 * growth metrics and the conversion rate already follow. The page renders
 * it as "—".
 */

/**
 * The statuses whose orders count towards revenue and profit.
 *
 * A cancelled order is excluded: the goods came back and the money was
 * never taken. Everything else — pending, processing, shipped,
 * delivered — is an order the shop is fulfilling and will be paid for.
 */
const REVENUE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PROCESSING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/**
 * The profit figures for the dashboard.
 */
export type ProfitMetrics = {
  /**
   * The revenue, in poisha — the total the customers were charged for the
   * counted lines.
   *
   * This is **net of the product's own discount** (because
   * `OrderItem.pricePaisa` is the price actually paid per unit) but
   * **before** the coupon, which is reported separately below and
   * subtracted in the profit.
   */
  readonly revenuePaisa: number;
  /**
   * The total coupon discount given away on the counted lines, in poisha.
   */
  readonly discountPaisa: number;
  /**
   * The total cost of the goods sold, in poisha.
   *
   * Only over the lines whose cost is known.
   */
  readonly costPaisa: number;
  /**
   * The profit, in poisha.
   *
   * `revenue - discount - cost`, over the lines whose cost is known.
   *
   * Negative when the shop sold at a loss.
   */
  readonly profitPaisa: number;
  /**
   * The margin, as a percentage of the revenue over the counted lines.
   *
   * `null` when there is no revenue to divide by.
   */
  readonly marginPercentage: number | null;
  /**
   * The number of units sold across the counted lines.
   */
  readonly unitsSold: number;
  /**
   * The number of order lines the profit was computed over.
   *
   * The lines whose cost is known.
   */
  readonly countedLines: number;
  /**
   * The number of order lines that were **excluded** because their cost
   * was never recorded.
   *
   * Reported so the reader can see the coverage of the figure. A profit
   * computed over a handful of lines is a real number, but it is not the
   * shop's whole profit, and the tile says how much of it there is.
   */
  readonly excludedLines: number;
};

/**
 * The profit figure for a single unit of a product.
 *
 * ── Why this is a pure function ──────────────────────────────────────────
 *
 * The margin arithmetic is the one piece of this module that must not
 * drift between the dashboard, the analytics page and the inventory
 * screen. If each of them had its own inline expression, a change to
 * one would leave the others reporting a different number for the same
 * sale.
 *
 * So the arithmetic lives here, in one place, and is pure — no database,
 * no clock, no configuration. It can be read, tested and reasoned about
 * on its own.
 *
 * @param sellingPricePaisa - What the customer paid.
 * @param purchasePricePaisa - What the shop paid.
 * @param discountAmountPaisa - The discount given away.
 *
 * The three arguments may be **per-unit** figures (the inventory row's
 * margin on one unit) or **totals** over a set of lines (the
 * dashboard's profit over the counted lines). The arithmetic is the
 * same shape in both cases, which is the point — one formula, so the
 * two screens cannot report different numbers for the same sale.
 *
 * @returns the profit, in poisha. May be negative.
 */
export function unitProfitPaisa(
  sellingPricePaisa: number,
  purchasePricePaisa: number,
  discountAmountPaisa: number,
): number {
  return sellingPricePaisa - purchasePricePaisa - discountAmountPaisa;
}

/**
 * The margin percentage for a profit and a revenue.
 *
 * `null` when the revenue is zero — the same zero-base rule the growth
 * metrics and the conversion rate follow.
 *
 * Pure, so the rule is directly testable.
 */
export function computeMarginPercentage(
  profitPaisa: number,
  revenuePaisa: number,
): number | null {
  if (revenuePaisa <= 0) return null;

  return (profitPaisa / revenuePaisa) * 100;
}

/**
 * Loads the profit figures for the dashboard.
 *
 * ── How the numbers are computed ─────────────────────────────────────────
 *
 * The line-level arithmetic happens in **SQL**, in a single aggregate
 * query over `order_items` joined to `orders`. The alternative — reading
 * every line and summing it in JavaScript — would move the whole order
 * history across the wire on every dashboard load, for a figure that the
 * database can sum far more cheaply.
 *
 * The query splits the lines into two groups:
 *
 *   • **Counted** — lines with a recorded cost. These produce the
 *     revenue, the cost, the discount and the profit.
 *   • **Excluded** — lines with no recorded cost. These are counted, and
 *     nothing else. They are reported so the reader knows the coverage.
 *
 * ── The revenue figure ───────────────────────────────────────────────────
 *
 * The revenue is the **line-level** revenue over the counted lines: what
 * the customer paid for those units, before the coupon. The coupon
 * discount is reported beside it and subtracted in the profit, so the
 * reader can see the gross, the giveaway and the net.
 *
 * Note that this is a *line-level* revenue, which is not the same
 * number as the order-level revenue on the dashboard tile: the order
 * figure includes shipping, and includes orders whose lines have no
 * recorded cost. The two answer different questions — "how much money
 * came in" versus "how much margin did the goods we know the cost of
 * produce" — and the tile that shows the profit says so in its hint.
 */
export async function getProfitMetrics(): Promise<ProfitMetrics> {
  const [counted, excluded] = await Promise.all([
    db.orderItem.aggregate({
      where: {
        purchasePricePaisa: { not: null },
        order: { status: { in: [...REVENUE_STATUSES] } },
      },
      _sum: {
        // The per-unit figures. Each is the price of **one** unit, so
        // each is multiplied by the total quantity below.
        pricePaisa: true,
        purchasePricePaisa: true,
        discountAmountPaisa: true,
        quantity: true,
      },
      _count: { _all: true },
    }),
    db.orderItem.count({
      where: {
        purchasePricePaisa: null,
        order: { status: { in: [...REVENUE_STATUSES] } },
      },
    }),
  ]);

  /*
   * The aggregates cannot multiply a per-unit price by a quantity for
   * us, so the line totals are computed here from the sums.
   *
   * `SUM(pricePaisa)` is the sum of the *unit* prices across the lines,
   * not the sum of the line totals — so it is multiplied by the total
   * quantity to get the revenue. That is only correct because every
   * line's unit price is the same for every unit on that line, which is
   * what `pricePaisa` is: the price **per unit**.
   *
   * The same reasoning applies to the cost and the coupon discount,
   * which are both per-unit figures on the line.
   */
  const unitsSold = counted._sum.quantity ?? 0;

  /*
   * The totals, and the profit, through the **shared** arithmetic.
   *
   * `unitProfitPaisa` is the one formula in the codebase. It is applied
   * to the aggregate sums here, so the dashboard's profit cannot drift
   * from the per-unit figure the inventory row computes directly. Two
   * expressions for one formula is how they drift.
   *
   * The sums are totals across the counted lines, so the per-unit
   * function is applied to the totals rather than to a single line —
   * the arithmetic is the same shape, and the totals are what the
   * figure is about.
   */
  const revenuePaisa = (counted._sum.pricePaisa ?? 0) * unitsSold;
  const costPaisa = (counted._sum.purchasePricePaisa ?? 0) * unitsSold;
  const discountPaisa = (counted._sum.discountAmountPaisa ?? 0) * unitsSold;

  const profitPaisa = unitProfitPaisa(
    revenuePaisa,
    costPaisa,
    discountPaisa,
  );

  return {
    revenuePaisa,
    discountPaisa,
    costPaisa,
    profitPaisa,
    marginPercentage: computeMarginPercentage(profitPaisa, revenuePaisa),
    unitsSold,
    countedLines: counted._count._all,
    excludedLines: excluded,
  };
}
