import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";

import { FilterPanel } from "@/components/commerce/filter-panel";
import { MobileFilterSheet } from "@/components/commerce/mobile-filter-sheet";
import { Pagination } from "@/components/commerce/pagination";
import { ProductCard } from "@/components/commerce/product-card";
import { SectionAnchor } from "@/components/commerce/section-anchor";
import { SortSelect } from "@/components/commerce/sort-select";
import { FlashSale } from "@/components/home/flash-sale";
import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon, SparkleIcon } from "@/components/ui/icons";
import { SectionHeading } from "@/components/ui/section-heading";
import { imageUrl } from "@/lib/format/image";
import {
  fetchBrands,
  fetchCategories,
  fetchConcerns,
  fetchProducts,
} from "@/lib/format/server-data";
import type { ProductListQuery } from "@/lib/validation/commerce";

/**
 * The products page.
 *
 * ── The rule that governs this page ──────────────────────────────────────
 *
 * **The URL is the query.**
 *
 * Every filter — the category, the concern, the price band, the sort
 * order, the page number — is a search parameter, and this page reads
 * them from `searchParams` and hands them to the catalogue service.
 *
 * That gives three things that a client-side filter list cannot:
 *
 *   1. **Shareable links.** "The retinol under ৳2,500" is a URL.
 *   2. **A working back button.** Filters are navigations, so the
 *      browser's back arrow undoes the last one.
 *   3. **Server-rendered, complete results.** The count is the real
 *      count, not the count of one page.
 *
 * The cost is that the page is dynamic. That is the right trade: a
 * catalogue page that filters on the client can only ever filter the
 * slice it already fetched.
 *
 * ── The search parameters ────────────────────────────────────────────────
 *
 * The names are exactly the ones `productListQuerySchema` accepts:
 * `search`, `category`, `ingredient`, `concern`, `isNewArrival`,
 * `isBestSeller`, `inStock`, `minPricePaisa`, `maxPricePaisa`, `sort`,
 * `page`, `limit`.
 *
 * `ingredient` and `concern` are **two different axes**, and both are
 * needed. The ingredient filter asks "what is *in* this product?"; the
 * concern filter asks "what is this product *for*?". A product
 * containing salicylic acid is not thereby an acne product — and it is
 * the second question a shopper browsing by concern is actually asking.
 *
 * The parsing is deliberately *lenient* — an unparseable `page` falls
 * back to page 1 rather than erroring — because a customer who
 * hand-edits a URL should see the catalogue, not a 400. The validation
 * that matters happens in the service, where the numbers are used.
 */

/**
 * The page metadata.
 */
export const metadata: Metadata = {
  title: "Shop All Products",
  description:
    "Browse European skincare, makeup and baby care — authentic, in stock, and delivered across Bangladesh.",
};

/**
 * The number of products per page.
 */
const PAGE_SIZE = 20;

/**
 * The props for the page.
 */
type ProductsPageProps = {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The products page.
 *
 * The shell — the breadcrumb, the headings, the flash sale banner and
 * the brand and concern strips — does not depend on the request, so it
 * is prerendered. The results do, so they stream behind a `<Suspense>`
 * boundary.
 */
export default function ProductsPage({ searchParams }: ProductsPageProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      {/*
        The section anchors.

        The "View all" links beside "Shop By Skin Concern" and "Shop By
        Brand" name the section they mean with `?view=concerns` and
        `?view=brands`. That parameter used to be read by nothing, so
        every one of those links landed the shopper at the top of the
        catalogue — with the section they asked for below the product
        grid.

        Both are read here, and the page scrolls to the one that was
        asked for.
      */}
      <Suspense fallback={null}>
        <SectionAnchor parameter="view" targetId="shop-by-concern" />
        <SectionAnchor parameter="view" targetId="shop-by-brand" />
      </Suspense>

      {/* ── The breadcrumb ───────────────────────────────────────────── */}
      <nav aria-label="Breadcrumb" className="mb-4">
        <ol className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <li>
            <Link
              href="/"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Home
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <span aria-current="page" className="font-medium text-foreground">
              All Products
            </span>
          </li>
        </ol>
      </nav>

      {/* ── The page header ──────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Shop All Products
        </h1>

        <p className="mt-1.5 text-sm text-foreground-muted">
          Authentic European brands, stocked locally and delivered across
          Bangladesh.
        </p>
      </div>

      {/* ── The flash sale banner ────────────────────────────────────── */}
      <div className="mb-8">
        <FlashSale />
      </div>

      <div className="lg:grid lg:grid-cols-[264px_1fr] lg:gap-10">
        {/* ── The desktop filter sidebar ─────────────────────────────── */}
        <aside aria-label="Filters" className="hidden lg:block">
          <div className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto pr-2">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">
                Filters
              </h2>

              <Suspense fallback={null}>
                <ClearFiltersLink searchParams={searchParams} />
              </Suspense>
            </div>

            <Suspense fallback={null}>
              <CategoriesFilter />
            </Suspense>
          </div>
        </aside>

        {/* ── The results ─────────────────────────────────────────────── */}
        <div>
          {/* The mobile filter trigger and the sort control. */}
          <div className="mb-4 flex items-center justify-between gap-3 lg:hidden">
            <Suspense fallback={null}>
              <MobileFilterTrigger />
            </Suspense>

            <Suspense fallback={null}>
              <SortControl searchParams={searchParams} />
            </Suspense>
          </div>

          {/* The desktop sort row. */}
          <div className="mb-5 hidden items-center justify-between gap-4 lg:flex">
            <Suspense fallback={null}>
              <SortControl searchParams={searchParams} />
            </Suspense>
          </div>

          <Suspense fallback={<ResultsSkeleton />}>
            <Results searchParams={searchParams} />
          </Suspense>
        </div>
      </div>

      {/* ── The brand strip ────────────────────────────────────────────── */}
      <section
        id="shop-by-brand"
        aria-labelledby="shop-by-brand-heading"
        className="mt-14 scroll-mt-32"
      >
        <SectionHeading
          title="Shop By Brand"
          subtitle="Authorised European labels, stocked locally."
          className="mb-8"
        />

        <h2 id="shop-by-brand-heading" className="sr-only">
          Shop By Brand
        </h2>

        <Suspense fallback={null}>
          <BrandStrip />
        </Suspense>
      </section>

      {/* ── The concern strip ────────────────────────────────────────── */}
      <section
        id="shop-by-concern"
        aria-labelledby="shop-by-concern-heading"
        className="mt-12 scroll-mt-32"
      >
        <SectionHeading
          title="Shop By Skin Concern"
          subtitle="Start from what you want to solve."
          className="mb-8"
        />

        <h2 id="shop-by-concern-heading" className="sr-only">
          Shop By Skin Concern
        </h2>

        <Suspense fallback={null}>
          <ConcernStrip />
        </Suspense>
      </section>
    </div>
  );
}

/**
 * The brand strip.
 *
 * Streamed, because the brands live in the database — the admin manages
 * them, and an uploaded logo has to appear here.
 */
async function BrandStrip() {
  const { brands } = await fetchBrands();

  if (brands.length === 0) {
    return null;
  }

  return (
    <ul className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
      {brands.map((brand) => (
        <li key={brand.id} className="shrink-0">
          <Link
            href={`/products?search=${encodeURIComponent(brand.name)}`}
            className="flex h-[4.5rem] w-28 flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-surface px-3 transition-colors hover:border-brand-300 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            {/*
              The uploaded logo when there is one, the monogram when
              there is not. The monogram is the fallback — a brand with
              no logo still has to render as something.
            */}
            {brand.logo ? (
              <span className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl bg-white p-1.5 ring-1 ring-border">
                <Image
                  src={imageUrl(brand.logo)}
                  alt={`${brand.name} logo`}
                  fill
                  sizes="44px"
                  className="object-contain"
                />
              </span>
            ) : (
              <span className="font-serif text-lg font-bold text-brand-600">
                {brand.monogram}
              </span>
            )}

            <span className="w-full truncate text-center text-[10px] font-medium text-foreground-muted">
              {brand.name}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The concern strip.
 *
 * Streamed, because the concerns live in the database.
 *
 * Each chip links to `?concern=<slug>` — the concern's own slug, and the
 * filter the catalogue performs on `Product.concernSlugs`.
 *
 * It used to link to `?ingredient=<tag>`, which was a **filter over
 * ingredients** rather than a statement about the product. A shopper who
 * clicked "Acne" was asking "which of these are for acne?", and the old
 * link could not answer it: it listed everything that merely *contained*
 * salicylic acid, including products the shop markets for congestion or
 * texture. The answer is the shop's own answer, because the concern on a
 * product is set by an admin on the product form.
 */
async function ConcernStrip() {
  const { concerns } = await fetchConcerns();

  if (concerns.length === 0) {
    return null;
  }

  return (
    <ul className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
      {concerns.map((concern) => (
        <li key={concern.id} className="shrink-0">
          <Link
            href={`/products?concern=${encodeURIComponent(concern.slug)}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
          >
            <SparkleIcon width={14} height={14} className="text-brand-500" />
            {concern.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The results grid and its pager.
 *
 * Streamed, because it reads the request's search parameters and the
 * live catalogue.
 */
async function Results({
  searchParams,
}: {
  readonly searchParams: ProductsPageProps["searchParams"];
}) {
  const params = await searchParams;
  const query = parseQuery(params);

  const [result, { concerns }] = await Promise.all([
    fetchProducts(query),
    fetchConcerns(),
  ]);

  const baseQuery = buildBaseQuery(params);

  /*
    The concern being browsed, resolved to its name.

    The filter panel already shows a removable chip for the active
    concern — but the panel lives in the **desktop sidebar**, which is
    hidden below `lg`. So a shopper on a phone who arrived from "Shop By
    Skin Concern" would see a filtered grid with nothing saying what it
    was filtered by. This line says it, on every screen.

    A slug the shop no longer has falls back to the slug itself rather
    than to nothing: the grid *is* filtered, and saying so is more
    honest than showing an unfiltered-looking page.
  */
  const activeConcernSlug = first(params.concern);
  const activeConcernName = activeConcernSlug
    ? (concerns.find((concern) => concern.slug === activeConcernSlug)?.name ??
      activeConcernSlug)
    : null;

  return (
    <>
      {result.error ? <ErrorNotice message={result.error} /> : null}

      {activeConcernName ? (
        <div className="mb-5 flex items-baseline gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted">
            Browsing by concern
          </p>

          <p className="font-serif text-lg font-bold text-foreground">
            {activeConcernName}
          </p>
        </div>
      ) : null}

      {result.products.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 xl:grid-cols-4">
            {result.products.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                imageAspect="portrait"
              />
            ))}
          </div>

          <Pagination pagination={result.pagination} baseQuery={baseQuery} />
        </>
      ) : (
        <EmptyResults hasFilters={countActiveFilters(params) > 0} />
      )}
    </>
  );
}

/**
 * The categories for the filter panel.
 *
 * The panel is a client component and needs the categories as a prop,
 * so the read happens here and is passed down.
 *
 * Named `loadCategories`, not `useCategories` — the `use` prefix is
 * reserved for hooks, and a hook may only be called from a component
 * or another hook. This is a plain async data loader, and calling it
 * like a hook is the kind of thing that makes the next reader believe
 * it has rules it does not have.
 */
async function loadCategories() {
  const categories = await fetchCategories();
  return categories.categories;
}

/**
 * Loads the concerns the filter panel offers.
 *
 * The concerns are admin-managed now, so the panel renders whatever the
 * database holds rather than a static list.
 */
async function loadConcerns() {
  const concerns = await fetchConcerns();
  return concerns.concerns;
}

/**
 * The filter panel, with its categories and concerns loaded.
 *
 * A separate component because the categories must be read *before* the
 * client component can render — and a client component cannot read the
 * database itself.
 */
async function CategoriesFilter() {
  const [categories, concerns] = await Promise.all([
    loadCategories(),
    loadConcerns(),
  ]);

  return <FilterPanel categories={categories} concerns={concerns} />;
}

/**
 * The mobile filter trigger.
 */
async function MobileFilterTrigger() {
  const [categories, concerns] = await Promise.all([
    loadCategories(),
    loadConcerns(),
  ]);

  return <MobileFilterSheet categories={categories} concerns={concerns} />;
}

/**
 * The sort control, with the result count.
 *
 * The count is read from **the same query the results use** — the
 * request's own search parameters, run through the same parser. A
 * separate, narrower query (say `limit: 1`, ignoring the filters)
 * would report the size of the whole catalogue next to a filtered
 * grid, and the two numbers would contradict each other.
 */
async function SortControl({
  searchParams,
}: {
  readonly searchParams: ProductsPageProps["searchParams"];
}) {
  const params = await searchParams;
  const query = parseQuery(params);

  // `limit: 1` keeps the payload to a single row: the count comes
  // from the pagination block, and the row itself is discarded.
  const result = await fetchProducts({ ...query, limit: 1 });

  return <SortSelect total={result.total} />;
}

/**
 * The "clear all filters" link.
 *
 * It is only rendered when a filter is active, so it reads the search
 * parameters. A "Clear all" link on an unfiltered catalogue is a
 * control that does nothing — noise where an action should be.
 */
async function ClearFiltersLink({
  searchParams,
}: {
  readonly searchParams: ProductsPageProps["searchParams"];
}) {
  const params = await searchParams;

  if (countActiveFilters(params) === 0) {
    return null;
  }

  return (
    <Link
      href="/products"
      className="text-xs font-medium text-brand-700 underline underline-offset-2 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      Clear all
    </Link>
  );
}

/**
 * The placeholder shown while the results load.
 */
function ResultsSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 xl:grid-cols-4"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index}>
          <div className="aspect-[3/4] animate-pulse rounded-[var(--radius-card)] bg-surface-muted" />
          <div className="mt-3 h-3 w-1/3 animate-pulse rounded-full bg-surface-muted" />
          <div className="mt-2 h-3 w-4/5 animate-pulse rounded-full bg-surface-muted" />
          <div className="mt-2.5 h-4 w-1/2 animate-pulse rounded-full bg-surface-muted" />
        </div>
      ))}
    </div>
  );
}

/**
 * The empty state, shown when a filtered query returns nothing.
 *
 * The message differs depending on whether filters are active. "No
 * products" on an unfiltered catalogue is a problem the shop has to
 * fix; "no products match these filters" is a problem the customer can
 * fix, by clearing them. Telling them the wrong one sends them down
 * the wrong path.
 */
function EmptyResults({ hasFilters }: { readonly hasFilters: boolean }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
      <h2 className="text-base font-semibold text-foreground">
        {hasFilters ? "No products match your filters" : "No products yet"}
      </h2>

      <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
        {hasFilters
          ? "Try removing a filter or widening the price range — the catalogue may still have what you need."
          : "The catalogue is being stocked. Check back shortly."}
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {hasFilters ? (
          <ButtonLink href="/products" variant="primary" size="sm">
            Clear all filters
          </ButtonLink>
        ) : null}

        <ButtonLink href="/" variant="outline" size="sm">
          Back to home
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * The error notice.
 *
 * The catalogue query failed. The page still renders — with an empty
 * grid and an honest message — because a failed product query must not
 * take the storefront down.
 */
function ErrorNotice({ message }: { readonly message: string }) {
  return (
    <div
      role="status"
      className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
    >
      {message}
    </div>
  );
}

/**
 * Parses the search parameters into a catalogue query.
 *
 * Lenient by design: an unparseable number falls back to the default
 * rather than failing the page. The service validates what it uses.
 */
function parseQuery(
  params: Record<string, string | string[] | undefined>,
): Partial<ProductListQuery> {
  const query: Partial<ProductListQuery> = {
    page: positiveInt(first(params.page)) ?? 1,
    limit: PAGE_SIZE,
    sort: (first(params.sort) ?? "newest") as ProductListQuery["sort"],
  };

  const search = first(params.search);
  if (search) {
    query.search = search;
  }

  const category = first(params.category);
  if (category) {
    query.category = category;
  }

  const ingredient = first(params.ingredient);
  if (ingredient) {
    query.ingredient = ingredient;
  }

  const concern = first(params.concern);
  if (concern) {
    query.concern = concern;
  }

  const minPricePaisa = positiveInt(first(params.minPricePaisa));
  if (minPricePaisa !== undefined) {
    query.minPricePaisa = minPricePaisa;
  }

  const maxPricePaisa = positiveInt(first(params.maxPricePaisa));
  if (maxPricePaisa !== undefined) {
    query.maxPricePaisa = maxPricePaisa;
  }

  const isBestSeller = first(params.isBestSeller);
  if (isBestSeller === "true") {
    query.isBestSeller = true;
  }

  const isNewArrival = first(params.isNewArrival);
  if (isNewArrival === "true") {
    query.isNewArrival = true;
  }

  const inStock = first(params.inStock);
  if (inStock === "true") {
    query.inStock = true;
  }

  return query;
}

/**
 * Reads the first value of a parameter that may be an array.
 */
function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

/**
 * Parses a positive integer.
 *
 * Returns `undefined` when the value is missing or is not a positive
 * integer, so the caller can simply omit the filter. A hand-edited
 * `?page=abc` should show the catalogue, not a 400.
 */
function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}

/**
 * Counts the active filters.
 *
 * Mirrors the list in `useActiveFilterCount`, so the badge on the
 * mobile button and the desktop count agree.
 */
function countActiveFilters(
  params: Record<string, string | string[] | undefined>,
): number {
  const keys = [
    "category",
    "ingredient",
    "concern",
    "search",
    "minPricePaisa",
    "maxPricePaisa",
    "isBestSeller",
    "isNewArrival",
    "inStock",
  ];

  return keys.filter((key) => first(params[key]) !== undefined).length;
}

/**
 * Builds the query string for the pagination links, minus the page.
 */
function buildBaseQuery(
  params: Record<string, string | string[] | undefined>,
): string {
  const copy = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;

    const single = first(value);
    if (single !== undefined) {
      copy.set(key, single);
    }
  }

  return copy.toString();
}
