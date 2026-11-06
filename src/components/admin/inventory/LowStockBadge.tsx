import { LOW_STOCK_THRESHOLD } from "@/lib/admin/stats";

/**
 * The low-stock badge.
 *
 * ── The predicate, stated once ───────────────────────────────────────────
 *
 * A product is **low stock** when it is *buyable but nearly gone*:
 *
 *   `stockQuantity > 0 && stockQuantity <= LOW_STOCK_THRESHOLD`
 *
 * The `> 0` half is not optional. The request's wording — "quantity < 5"
 * — omits it, and omitting it would put a product with **zero** units in
 * the low-stock band alongside the genuinely out-of-stock ones.
 *
 * That is not a cosmetic difference. The two bands mean different things
 * and call for different actions:
 *
 *   • **Low stock** — buyable, but reorder soon. An amber warning.
 *   • **Out of stock** — not buyable at all. A red error.
 *
 * Putting a zero in the amber band would tell an admin to reorder a
 * product the storefront is already refusing to sell, and would make the
 * low-stock count disagree with the dashboard's own band filter.
 *
 * So the predicate lives in `LOW_STOCK_THRESHOLD` and `productStockWhere`
 * — the same constants the statistics service uses — and this component
 * reads the threshold from there rather than hard-coding "5".
 *
 * ── Why it is a badge and not a number ───────────────────────────────────
 *
 * The count is already in the row. The badge carries the *meaning*: that
 * this particular row needs attention before the others. It is a status,
 * not a value.
 */
export function LowStockBadge({
  stockQuantity,
}: {
  readonly stockQuantity: number;
}) {
  if (stockQuantity <= 0) return null;

  if (stockQuantity > LOW_STOCK_THRESHOLD) return null;

  return (
    <span className="inline-block rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30">
      {stockQuantity === 1 ? "1 left" : `${stockQuantity} left`}
    </span>
  );
}

/**
 * The out-of-stock badge.
 *
 * The counterpart to `LowStockBadge`. It is a separate component because
 * the two are **disjoint** bands with different meanings, and folding
 * them into one component with a `variant` prop would invite somebody
 * to render the wrong one.
 */
export function OutOfStockBadge() {
  return (
    <span className="inline-block rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-700 ring-1 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30">
      Out of stock
    </span>
  );
}
