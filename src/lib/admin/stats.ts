import { OrderStatus, Prisma, UserRole } from "@prisma/client";

import { db } from "@/lib/db";

import { reviewStateWhere } from "./reviews";

/**
 * The dashboard statistics service.
 *
 * ── Why this is a service and not a page ─────────────────────────────────
 *
 * The dashboard needs a lot of counts, and every one of them is a
 * question about the shape of the data:
 *
 *   • "total orders"  — is that every order ever placed, or the ones
 *     that are still in flight? Both are useful, so both are reported
 *     and neither is ambiguous.
 *   • "pending reviews" — is that `isApproved = false`, or the pending
 *     *state*? Those are not the same query: `isApproved = false` also
 *     matches the (unreachable) `isHidden = true` combination, and the
 *     review service already knows the precise shape.
 *
 * So the shapes live here, next to the moderation vocabulary they share,
 * and the page just renders them. The page must not invent a `where`
 * clause — a second implementation of "pending" is a second thing that
 * can disagree with the first.
 */

/**
 * The dashboard statistics.
 */
export type DashboardStats = {
  readonly orders: {
    /** Every order ever placed. */
    readonly total: number;
    /** Orders that have not yet been delivered or cancelled. */
    readonly inFlight: number;
    /** Orders waiting to be picked and packed. */
    readonly pending: number;
    readonly processing: number;
    readonly shipped: number;
    readonly delivered: number;
    readonly cancelled: number;
    /**
     * The order value, in poisha, of the orders that are not cancelled.
     *
     * Cancelled orders are excluded because the money was never taken —
     * a COD order that was cancelled contributes nothing to revenue, and
     * including it would overstate the shop's takings.
     */
    readonly revenuePaisa: number;
  };
  readonly products: {
    readonly total: number;
    /**
     * Products with `stockQuantity > 0` — the buyable ones.
     *
     * This *includes* the low-stock products, which are buyable too.
     * `inStock + outOfStock === total`; the low-stock count is a
     * warning nested inside `inStock`, not a sibling of it.
     */
    readonly inStock: number;
    /** Products with `stockQuantity <= 0`. */
    readonly outOfStock: number;
    /**
     * Products with `0 < stockQuantity <= LOW_STOCK_THRESHOLD`.
     *
     * A subset of `inStock`, never a superset.
     */
    readonly lowStock: number;
    /** The sum of every unit on the shelf. */
    readonly totalUnits: number;
  };
  readonly reviews: {
    readonly total: number;
    readonly pending: number;
    readonly approved: number;
    readonly hidden: number;
  };
  readonly users: {
    readonly total: number;
    readonly customers: number;
    readonly admins: number;
    /** Customers who opted in to depletion reminders. */
    readonly smsOptIn: number;
  };
};

/**
 * The stock level at or below which a product is flagged as low.
 *
 * A constant, not a setting. A setting that defaults to zero would mean
 * "low stock" means "out of stock", and a dashboard that reports the two
 * as the same thing is worse than one that reports only one.
 */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Loads the dashboard statistics.
 *
 * Every count is an independent `count()` or `aggregate()`, and they run
 * together in one `Promise.all`. The queries are small — counts on
 * indexed columns — so the parallelism is worth more than the
 * round-trips.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [
    orderTotal,
    orderPending,
    orderProcessing,
    orderShipped,
    orderDelivered,
    orderCancelled,
    revenue,
    productTotal,
    productInStock,
    productOutOfStock,
    productLowStock,
    productUnits,
    reviewTotal,
    reviewPending,
    reviewApproved,
    reviewHidden,
    userTotal,
    userCustomers,
    userAdmins,
    userSmsOptIn,
  ] = await Promise.all([
    db.order.count(),
    db.order.count({ where: { status: OrderStatus.PENDING } }),
    db.order.count({ where: { status: OrderStatus.PROCESSING } }),
    db.order.count({ where: { status: OrderStatus.SHIPPED } }),
    db.order.count({ where: { status: OrderStatus.DELIVERED } }),
    db.order.count({ where: { status: OrderStatus.CANCELLED } }),
    db.order.aggregate({
      where: { status: { not: OrderStatus.CANCELLED } },
      _sum: { totalAmountPaisa: true },
    }),
    db.product.count(),
    db.product.count({ where: { stockQuantity: { gt: 0 } } }),
    db.product.count({ where: { stockQuantity: { lte: 0 } } }),
    db.product.count({
      where: { stockQuantity: { gt: 0, lte: LOW_STOCK_THRESHOLD } },
    }),
    db.product.aggregate({ _sum: { stockQuantity: true } }),
    db.review.count(),
    db.review.count({ where: reviewStateWhere("PENDING") }),
    db.review.count({ where: reviewStateWhere("APPROVED") }),
    db.review.count({ where: reviewStateWhere("HIDDEN") }),
    db.user.count(),
    db.user.count({ where: { role: UserRole.CUSTOMER } }),
    db.user.count({ where: { role: UserRole.ADMIN } }),
    db.user.count({ where: { smsOptIn: true } }),
  ]);

  // "In flight" is the derived number an operator actually asks for:
  // everything that is neither delivered nor cancelled. It is computed
  // here rather than as a fourth database query, because a fourth query
  // would be a fourth chance for the number to disagree with the
  // statuses it is derived from.
  const inFlight = orderPending + orderProcessing + orderShipped;

  return {
    orders: {
      total: orderTotal,
      inFlight,
      pending: orderPending,
      processing: orderProcessing,
      shipped: orderShipped,
      delivered: orderDelivered,
      cancelled: orderCancelled,
      revenuePaisa: revenue._sum.totalAmountPaisa ?? 0,
    },
    products: {
      total: productTotal,
      inStock: productInStock,
      outOfStock: productOutOfStock,
      lowStock: productLowStock,
      totalUnits: productUnits._sum.stockQuantity ?? 0,
    },
    reviews: {
      total: reviewTotal,
      pending: reviewPending,
      approved: reviewApproved,
      hidden: reviewHidden,
    },
    users: {
      total: userTotal,
      customers: userCustomers,
      admins: userAdmins,
      smsOptIn: userSmsOptIn,
    },
  };
}

/**
 * The shape of a product row in the admin inventory list.
 */
export type AdminProductSummary = {
  id: string;
  name: string;
  description: string;
  /**
   * The product's brand, or `null` when it is unknown.
   */
  brand: string | null;
  categoryId: string;
  pricePaisa: number;
  discountPricePaisa: number | null;
  /**
   * What the shop paid for one unit, in poisha.
   *
   * `null` means "not known" — the cost has never been recorded. It is
   * **not** zero, and a margin computed against a missing cost is
   * excluded from the profit figures rather than counted as if the
   * goods were free.
   */
  purchasePricePaisa: number | null;
  /**
   * What the customer is charged for one unit, in poisha.
   *
   * `null` means "not known".
   */
  sellingPricePaisa: number | null;
  /**
   * How many units of this product have been sold.
   *
   * A **convenience counter**, maintained at the point of sale. The
   * authoritative figure is always the sum of the order items, and the
   * profit numbers are computed from the order items rather than from
   * this column — so a counter that drifted would misreport a
   * popularity ranking but could never misreport the shop's money.
   */
  soldCount: number;
  stockQuantity: number;
  ingredientTags: string[];
  /**
   * The skin concerns this product addresses — "Shop by Concern".
   *
   * The slugs of the concerns in the `SkinConcern` table.
   */
  concernSlugs: string[];
  climateTips: string | null;
  images: string[];
  /**
   * The promotional badges.
   *
   * The source of truth for the product's promotional labels — the two
   * booleans below are a mirror of two entries in this list.
   */
  badges: string[];
  isNewArrival: boolean;
  isBestSeller: boolean;
  /**
   * When the product was withdrawn from the storefront.
   *
   * `null` means it is on sale. The admin list shows archived products
   * — an admin has to be able to find a withdrawn product in order to
   * restore it.
   */
  archivedAt: Date | null;
  category: { id: string; name: string; slug: string };
  updatedAt: Date;
  /**
   * How many rows still reference this product.
   *
   * A hard delete is only possible when all three are zero — the
   * server checks this too, but showing the admin *before* they type
   * the confirmation is the difference between a clear refusal and a
   * confusing one.
   */
  references: {
    orderItems: number;
    cartItems: number;
    reviews: number;
  };
};

/**
 * The Prisma select for an admin product summary.
 */
const ADMIN_PRODUCT_SELECT = {
  id: true,
  name: true,
  description: true,
  brand: true,
  categoryId: true,
  pricePaisa: true,
  discountPricePaisa: true,
  purchasePricePaisa: true,
  sellingPricePaisa: true,
  soldCount: true,
  stockQuantity: true,
  ingredientTags: true,
  concernSlugs: true,
  climateTips: true,
  images: true,
  badges: true,
  isNewArrival: true,
  isBestSeller: true,
  archivedAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true, slug: true } },
  _count: { select: { orderItems: true, cartItems: true, reviews: true } },
} satisfies Prisma.ProductSelect;

/**
 * Loads the products that are nearly out of stock.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * A **count** of low-stock products is a number on a tile. It tells an
 * operator that something needs attention but not *what*. The dashboard's
 * job is to say "three products are nearly gone" and then let the
 * operator act on it without hunting through the inventory list.
 *
 * So this returns the **rows** — the few products in the band — so the
 * dashboard can name them and link to each one.
 *
 * ── Why the list is capped ───────────────────────────────────────────────
 *
 * The panel shows the **worst** offenders, not the whole band. A shop
 * with four hundred nearly-sold-out products cannot show four hundred
 * rows on the overview, and the ones nearest zero are the ones that
 * matter. So the query orders by quantity ascending — the emptiest
 * first — and takes a handful.
 *
 * The *count* of the whole band is still reported by `getDashboardStats`,
 * so the panel never hides the size of the problem behind a truncation.
 */
export async function listLowStockProducts(
  limit = 5,
): Promise<AdminProductSummary[]> {
  const rows = await db.product.findMany({
    where: productStockWhere("LOW_STOCK"),
    select: ADMIN_PRODUCT_SELECT,
    // The emptiest first — those are the ones about to run out.
    orderBy: [{ stockQuantity: "asc" }, { name: "asc" }],
    take: limit,
  });

  return rows.map(toAdminProductSummary);
}

/**
 * Projects a selected product row onto the admin summary shape.
 *
 * The `_count` block is renamed to `references` — the raw Prisma name
 * is a database detail, and the admin UI should not have to know that
 * a "reference" is a join table row.
 */
function toAdminProductSummary(
  row: Prisma.ProductGetPayload<{ select: typeof ADMIN_PRODUCT_SELECT }>,
): AdminProductSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    brand: row.brand,
    categoryId: row.categoryId,
    pricePaisa: row.pricePaisa,
    discountPricePaisa: row.discountPricePaisa,
    purchasePricePaisa: row.purchasePricePaisa,
    sellingPricePaisa: row.sellingPricePaisa,
    soldCount: row.soldCount,
    stockQuantity: row.stockQuantity,
    ingredientTags: row.ingredientTags,
    concernSlugs: row.concernSlugs,
    climateTips: row.climateTips,
    images: row.images,
    badges: row.badges,
    isNewArrival: row.isNewArrival,
    isBestSeller: row.isBestSeller,
    archivedAt: row.archivedAt,
    category: row.category,
    updatedAt: row.updatedAt,
    references: {
      orderItems: row._count.orderItems,
      cartItems: row._count.cartItems,
      reviews: row._count.reviews,
    },
  };
}

/**
 * The result of the admin inventory list query.
 */
export type AdminProductListResult = {
  products: AdminProductSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  counts: {
    all: number;
    /**
     * Buyable products (`stockQuantity > 0`). Includes the low-stock
     * ones — see `DashboardStats.products.inStock`.
     */
    inStock: number;
    /** Not buyable (`stockQuantity <= 0`). Disjoint from `inStock`. */
    outOfStock: number;
    /** A warning band nested inside `inStock`. */
    lowStock: number;
    /**
     * Products withdrawn from the storefront.
     *
     * A visibility axis, not a stock band — an archived product may
     * also be in stock, out of stock or low. It is reported separately
     * so an admin can find and restore a withdrawn product, and so the
     * live catalogue is never silently hiding rows.
     */
    archived: number;
  };
};

/**
 * The stock filter for the inventory list.
 */
export type ProductStockFilter =
  | "ALL"
  | "IN_STOCK"
  | "OUT_OF_STOCK"
  | "LOW_STOCK"
  | "ARCHIVED";

/**
 * Builds the `where` clause for a stock filter.
 *
 * The same shape is used for the list and for the counts, so a filter
 * that matches nothing shows `0` in both places rather than looking
 * like an empty shelf.
 *
 * ── How the bands relate to one another ──────────────────────────────────
 *
 * `IN_STOCK` means **buyable** — `stockQuantity > 0`, exactly the
 * predicate the storefront uses. `LOW_STOCK` is a *warning layered on
 * top of* that: a product with three units is both in stock and low.
 * The two therefore overlap by design, and `lowStock <= inStock` is
 * an invariant, not an accident.
 *
 * `OUT_OF_STOCK` (`stockQuantity <= 0`) is the one band that is
 * disjoint from both — a product with zero units is not "low", it is
 * "none". This is what makes `inStock + outOfStock === all` a true
 * partition of the catalogue, while the three-way sum is not.
 *
 * ── The `ARCHIVED` band is a different axis entirely ────────────────────
 *
 * Every other band is a statement about **stock**. `ARCHIVED` is a
 * statement about **visibility**: the product has been withdrawn from
 * the storefront. The two axes are orthogonal — a product can be
 * archived *and* have ten units on the shelf — so `ARCHIVED` is
 * deliberately not folded into the stock partition. An archived
 * product is simply excluded from the live catalogue by the shared
 * `ACTIVE_PRODUCT_WHERE` filter, and `ALL` in this admin list means
 * "every product, archived or not", because an admin has to be able to
 * find a withdrawn product in order to restore it.
 */
export function productStockWhere(
  filter: ProductStockFilter,
): Prisma.ProductWhereInput {
  switch (filter) {
    case "IN_STOCK":
      return { stockQuantity: { gt: 0 } };
    case "OUT_OF_STOCK":
      return { stockQuantity: { lte: 0 } };
    case "LOW_STOCK":
      return { stockQuantity: { gt: 0, lte: LOW_STOCK_THRESHOLD } };
    case "ARCHIVED":
      return { archivedAt: { not: null } };
    case "ALL":
      return {};
  }
}

/**
 * Lists the products for the inventory management view.
 */
export async function listAdminProducts(query: {
  readonly stock: ProductStockFilter;
  readonly search?: string;
  readonly page: number;
  readonly limit: number;
}): Promise<AdminProductListResult> {
  const conditions: Prisma.ProductWhereInput[] = [
    productStockWhere(query.stock),
  ];

  if (query.search) {
    // Prisma parameterises the term, so there is no injection risk. But
    // `%` and `_` are SQL wildcards inside `contains`, so they are
    // escaped to match literally — the way a person typing them expects.
    const escaped = query.search.replace(/[\\%_]/g, (char) => `\\${char}`);

    conditions.push({ name: { contains: escaped, mode: "insensitive" } });
  }

  const where: Prisma.ProductWhereInput = { AND: conditions };

  const skip = (query.page - 1) * query.limit;

  const [rows, total, all, inStock, outOfStock, lowStock, archived] =
    await Promise.all([
      db.product.findMany({
        where,
        select: ADMIN_PRODUCT_SELECT,
        orderBy: [{ name: "asc" }],
        skip,
        take: query.limit,
      }),
      db.product.count({ where }),
      db.product.count(),
      db.product.count({ where: productStockWhere("IN_STOCK") }),
      db.product.count({ where: productStockWhere("OUT_OF_STOCK") }),
      db.product.count({ where: productStockWhere("LOW_STOCK") }),
      db.product.count({ where: productStockWhere("ARCHIVED") }),
    ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    products: rows.map(toAdminProductSummary),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    counts: { all, inStock, outOfStock, lowStock, archived },
  };
}
