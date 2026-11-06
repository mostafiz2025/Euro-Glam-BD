import {
  listBrands,
  listCategories,
  listConcerns,
  listProducts,
  type BrandSummary,
  type CategorySummary,
  type ConcernSummary,
  type ProductSummary,
} from "@/lib/catalog/service";
import { listPublicHeroBanners } from "@/lib/catalog/hero-banners";
import {
  listPublicSiteSettings,
  type PublicSiteSettings,
} from "@/lib/catalog/site-settings";
import { listPublicCouponsWithClock } from "@/lib/coupons/service";
import type { PublicCoupon } from "@/lib/coupons/rules";
import {
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
} from "@/lib/format/colors";
import type { HeroBannerSummary, Pagination } from "@/lib/format/types";
import type { ProductListQuery } from "@/lib/validation/commerce";

/**
 * Server-side data access for the storefront.
 *
 * ── Why this calls the services directly ─────────────────────────────────
 *
 * A server component could fetch its own API routes over HTTP:
 *
 *   const response = await fetch(`${process.env.SITE_URL}/api/products`);
 *
 * That works, and it is a common pattern — but it is the wrong one
 * here, for three reasons:
 *
 *   1. **It is slower.** The request leaves the server, loops back
 *      through the network stack, and is re-parsed. The service call is
 *      a direct function call.
 *
 *   2. **It needs a base URL.** `localhost:3000` in development, the
 *      public domain in production, and neither is available during a
 *      static build. A service call has no such requirement.
 *
 *   3. **It duplicates the error handling.** The route handler already
 *      has a complete error path. Going over HTTP means the page
 *      re-implements it, and the two drift.
 *
 * So: the page calls the **same service** the route handler calls. One
 * implementation of the catalogue query, one place where the filter
 * rules live.
 *
 * The API routes still exist and are still the contract for the
 * *client* — the cart, the account pages, anything that mutates. The
 * read paths for server-rendered pages use the service directly.
 *
 * ── The failure rule ────────────────────────────────────────────────────
 *
 * **A page renders with an empty list rather than crashing.** A failed
 * catalogue query must not take the storefront down with it. The
 * functions below catch, log, and return an empty result — and the
 * page renders an honest "nothing here" state.
 *
 * The alternative — letting the error propagate — means a transient
 * database blip produces a 500 on the home page, which is a far worse
 * outcome than a home page with no products in it.
 */

/**
 * A page-safe product list result.
 *
 * The `pagination` block is carried through, not just the total, because
 * a listing page needs to know how many pages there are to render the
 * pager. A result that only exposed `total` would force the page to
 * re-derive the page count — a second implementation of the service's
 * arithmetic, which is exactly the kind of duplication that drifts.
 */
export type SafeProductList = {
  readonly products: ProductSummary[];
  readonly total: number;
  readonly pagination: Pagination;
  readonly error: string | null;
};

/**
 * The pagination block used when a query fails.
 *
 * A failed query is page 1 of one empty page. It renders the empty
 * state and a pager with nothing to page through.
 */
const EMPTY_PAGINATION: Pagination = {
  page: 1,
  limit: 20,
  total: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};

/**
 * Lists products for a server-rendered page.
 *
 * Never throws. On failure it returns an empty list and the error
 * message, so the page can show an honest empty state.
 */
export async function fetchProducts(
  query: Partial<ProductListQuery> = {},
): Promise<SafeProductList> {
  try {
    const result = await listProducts({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      sort: query.sort ?? "newest",
      ...(query.search !== undefined ? { search: query.search } : {}),
      ...(query.category !== undefined ? { category: query.category } : {}),
      ...(query.ingredient !== undefined
        ? { ingredient: query.ingredient }
        : {}),
      ...(query.concern !== undefined ? { concern: query.concern } : {}),
      ...(query.isNewArrival !== undefined
        ? { isNewArrival: query.isNewArrival }
        : {}),
      ...(query.isBestSeller !== undefined
        ? { isBestSeller: query.isBestSeller }
        : {}),
      ...(query.inStock !== undefined ? { inStock: query.inStock } : {}),
      ...(query.minPricePaisa !== undefined
        ? { minPricePaisa: query.minPricePaisa }
        : {}),
      ...(query.maxPricePaisa !== undefined
        ? { maxPricePaisa: query.maxPricePaisa }
        : {}),
    });

    return {
      products: result.products,
      total: result.pagination.total,
      pagination: result.pagination,
      error: null,
    };
  } catch (error) {
    console.error("[storefront] Product list failed:", error);

    return {
      products: [],
      total: 0,
      pagination: EMPTY_PAGINATION,
      error: "We could not load products.",
    };
  }
}

/**
 * Lists the categories for a server-rendered page.
 *
 * Never throws.
 */
export async function fetchCategories(): Promise<{
  readonly categories: CategorySummary[];
  readonly error: string | null;
}> {
  try {
    return { categories: await listCategories(), error: null };
  } catch (error) {
    console.error("[storefront] Category list failed:", error);

    return { categories: [], error: "We could not load categories." };
  }
}

/**
 * Lists the skin concerns for a server-rendered page.
 *
 * Never throws — the same rule as every other fetch in this file. A
 * failed concern query must not take the storefront down with it; the
 * section renders an honest empty state instead.
 */
export async function fetchConcerns(): Promise<{
  readonly concerns: ConcernSummary[];
  readonly error: string | null;
}> {
  try {
    return { concerns: await listConcerns(), error: null };
  } catch (error) {
    console.error("[storefront] Concern list failed:", error);

    return { concerns: [], error: "We could not load skin concerns." };
  }
}

/**
 * Lists the brands for a server-rendered page.
 *
 * Never throws — the same rule as every other fetch in this file.
 */
export async function fetchBrands(): Promise<{
  readonly brands: BrandSummary[];
  readonly error: string | null;
}> {
  try {
    return { brands: await listBrands(), error: null };
  } catch (error) {
    console.error("[storefront] Brand list failed:", error);

    return { brands: [], error: "We could not load brands." };
  }
}

/**
 * Lists the active discount codes for a server-rendered page.
 *
 * Never throws — the same rule as every other fetch in this file. A
 * failed coupon query must not take the storefront down with it, and a
 * banner that fails to render is a far smaller problem than a home page
 * that returns a 500.
 *
 * The list is **already capped** by the service, and the cap is small on
 * purpose: a banner is a headline, not an index. The cart page's coupon
 * helper is the place that lists codes in full.
 */
export async function fetchActiveCoupons(
  limit = 6,
): Promise<{
  readonly coupons: PublicCoupon[];
  readonly error: string | null;
  /**
   * The moment the list was taken, as a Unix timestamp in milliseconds.
   *
   * The announcement bar needs a clock to say how long a code has left,
   * and a clock cannot be read during a render — so the service reads
   * it and hands it back here.
   */
  readonly now: number;
}> {
  try {
    const { coupons, now } = await listPublicCouponsWithClock(limit);

    return { coupons, now, error: null };
  } catch (error) {
    console.error("[storefront] Coupon list failed:", error);

    return {
      coupons: [],
      now: 0,
      error: "We could not load discount codes.",
    };
  }
}

/**
 * Lists the homepage hero banners for a server-rendered page.
 *
 * Never throws — the same rule as every other fetch in this file. A
 * failed banner query must not take the storefront down with it; the
 * homepage falls back to the static slides instead.
 *
 * The empty list is a **legitimate** answer, not a failure: it means
 * the admin has not created any banners yet, or has switched them all
 * off. The home page handles both the same way — it shows the static
 * slides — so the caller does not need to tell the two apart.
 */
export async function fetchHeroBanners(): Promise<{
  readonly banners: HeroBannerSummary[];
  readonly error: string | null;
}> {
  try {
    return { banners: await listPublicHeroBanners(), error: null };
  } catch (error) {
    console.error("[storefront] Hero banner list failed:", error);

    return { banners: [], error: "We could not load the hero banners." };
  }
}

/**
 * Reads the site's public settings for a server-rendered page.
 *
 * Never throws — the same rule as every other fetch in this file. A
 * failed settings query must not take the storefront down with it; the
 * marquee simply does not appear.
 *
 * The fallback is the **empty** settings: the marquee off, with no
 * text. An announcement that cannot be read is worse than no
 * announcement, because a failed query would otherwise leave the last
 * known message on screen with no way to know it is stale.
 */
export async function fetchSiteSettings(): Promise<{
  readonly settings: PublicSiteSettings;
  readonly error: string | null;
}> {
  try {
    return { settings: await listPublicSiteSettings(), error: null };
  } catch (error) {
    console.error("[storefront] Site settings failed:", error);

    return {
      settings: {
        isMarqueeEnabled: false,
        marqueeText: "",
        marqueeHref: null,
        marqueeBgColor: DEFAULT_MARQUEE_BG,
        marqueeTextColor: DEFAULT_MARQUEE_TEXT,
        supportEmail: "",
        supportPhone: "",
        supportHours: "",
        storeAddress: "",
      },
      error: "We could not load the site settings.",
    };
  }
}
