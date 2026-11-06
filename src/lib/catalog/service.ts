import { Prisma } from "@prisma/client";

import { ACTIVE_PRODUCT_WHERE } from "@/lib/catalog/product-visibility";
import { db } from "@/lib/db";

import type { ProductListQuery } from "@/lib/validation/commerce";

/**
 * The catalogue service.
 *
 * Read-only queries over the product catalogue: listing, searching,
 * filtering and the product detail page.
 *
 * Two things are deliberate here:
 *
 *  • **Prices are never computed by the client.** The API returns the
 *    raw poisha fields plus the effective price, so a client can render a
 *    price without re-implementing the discount rule. The client never
 *    *sends* a price — see `src/lib/validation/commerce.ts`.
 *
 *  • **The search term is escaped, not sanitised away.** Prisma's
 *    `contains` is already parameterised, so there is no SQL injection
 *    risk. But `%` and `_` are SQL wildcards inside `contains`, and a user
 *    typing `%` would otherwise match every product. The term is escaped
 *    so the search behaves the way a person expects.
 */

/**
 * The product shape returned by the catalogue API.
 */
export type ProductSummary = {
  id: string;
  name: string;
  description: string;
  /**
   * The product's brand, or `null` when it is unknown.
   *
   * The storefront renders no brand line at all for a `null` brand —
   * an empty line would read as a mistake.
   */
  brand: string | null;
  pricePaisa: number;
  discountPricePaisa: number | null;
  discountPercentage: number | null;
  /** The price the customer actually pays. */
  effectivePricePaisa: number;
  stockQuantity: number;
  inStock: boolean;
  ingredientTags: string[];
  /**
   * The skin concerns the product is tagged with — "acne", "dryness".
   *
   * The **slugs**, not the names: a slug is stable across a rename,
   * and it is what the `?concern=` filter matches on. The storefront
   * resolves them to labels through the `SkinConcern` table.
   */
  concernSlugs: string[];
  climateTips: string | null;
  images: string[];
  isNewArrival: boolean;
  isBestSeller: boolean;
  category: { id: string; name: string; slug: string };
};

/**
 * The Prisma select for a product summary.
 */
const PRODUCT_SUMMARY_SELECT = {
  id: true,
  name: true,
  description: true,
  brand: true,
  pricePaisa: true,
  discountPricePaisa: true,
  discountPercentage: true,
  stockQuantity: true,
  ingredientTags: true,
  concernSlugs: true,
  climateTips: true,
  images: true,
  isNewArrival: true,
  isBestSeller: true,
  category: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.ProductSelect;

/**
 * The product shape returned by the product detail endpoint.
 */
export type ProductDetail = ProductSummary & {
  /**
   * The raw ingredients JSON.
   *
   * Stored as `Jsonb` and written by the admin with a validated shape. It
   * is passed through as-is because the product detail page renders it.
   */
  ingredients: unknown;
  /** The product's approved review summary. */
  rating: { average: number; count: number };
  /** Other products in the same category. */
  relatedProductIds: string[];
};

/**
 * The result of a product list query.
 */
export type ProductListResult = {
  products: ProductSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  /** The filters that were applied, echoed back for the client. */
  appliedFilters: {
    search?: string;
    category?: string;
    ingredient?: string;
    concern?: string;
    isNewArrival?: boolean;
    isBestSeller?: boolean;
    inStock?: boolean;
    minPricePaisa?: number;
    maxPricePaisa?: number;
    sort: ProductListQuery["sort"];
  };
};

/**
 * Escapes the SQL wildcard characters in a search term.
 *
 * Prisma parameterises the value, so this is not about injection. It is
 * about making `%` and `_` match literally, the way a person typing them
 * expects.
 */
function escapeSearchTerm(term: string): string {
  return term.replace(/([%_\\])/g, "\\$1");
}

/**
 * Builds the Prisma `where` clause for a product list query.
 *
 * ── How the conditions are combined ────────────────────────────────────
 *
 * Every filter is an *independent* condition, so they are collected into
 * a list and combined with AND. Filters that are themselves alternatives
 * — the two price paths, the two search columns — are expressed as a
 * nested `OR` *inside* one condition.
 *
 * This structure matters. Assigning two different `OR` lists to `where`
 * would silently drop the first one, and putting two alternatives in a
 * flat `AND` list would require both to hold and so match nothing.
 */
function buildWhereClause(query: ProductListQuery): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = {};

  /**
   * The independent conditions, combined with AND at the end.
   */
  const conditions: Prisma.ProductWhereInput[] = [];

  /**
   * ── The archive filter ──────────────────────────────────────────────
   *
   * An archived product is withdrawn from sale, so it must not appear in
   * the catalogue, in a search result, or in a count. It is added here,
   * inside the builder, rather than at the query site — so it covers the
   * rows **and** the count, and every caller of the builder.
   *
   * It goes in `conditions` (which is AND-ed) rather than as a sibling
   * key, so there is exactly one place where the storefront's product
   * visibility is decided.
   */
  conditions.push(ACTIVE_PRODUCT_WHERE);

  if (query.search) {
    const escaped = escapeSearchTerm(query.search);

    conditions.push({
      OR: [
        { name: { contains: escaped, mode: "insensitive" } },
        { description: { contains: escaped, mode: "insensitive" } },
        // The brand is searched too, so a shopper typing "CeraVe" finds
        // the CeraVe products even when the product's name does not
        // happen to start with the brand.
        { brand: { contains: escaped, mode: "insensitive" } },
      ],
    });
  }

  if (query.category) {
    where.category = { slug: query.category };
  }

  if (query.ingredient) {
    // `has` is an exact array-membership test on a scalar list. The tag
    // is upper-cased by the schema, and the catalogue stores canonical
    // upper-case IDs.
    where.ingredientTags = { has: query.ingredient };
  }

  if (query.concern) {
    /*
     * The "Shop by Concern" filter.
     *
     * `has` is the same exact array-membership test the ingredient
     * filter uses — `concernSlugs` is a scalar list of the concern's
     * slug, and the slug is lower-cased by the schema.
     *
     * This is deliberately **not** the ingredient filter. A product
     * carrying the "acne" concern is one the shop has decided is an
     * acne product; a product merely containing BHA is one that
     * happens to hold an ingredient in the same family. The two answer
     * different questions, and only this one answers the question the
     * shopper asked.
     */
    where.concernSlugs = { has: query.concern };
  }

  if (query.isNewArrival !== undefined) {
    where.isNewArrival = query.isNewArrival;
  }

  if (query.isBestSeller !== undefined) {
    where.isBestSeller = query.isBestSeller;
  }

  if (query.inStock !== undefined) {
    where.stockQuantity = query.inStock ? { gt: 0 } : { lte: 0 };
  }

  /**
   * The price filter applies to the *effective* price.
   *
   * A product with a discount is priced at `discountPricePaisa`, not at
   * `pricePaisa`. Filtering on the raw price would include a product the
   * customer can actually buy for less than the ceiling. Prisma cannot
   * compare two columns against each other, so this is expressed as two
   * explicit price paths:
   *
   *   • A discounted product is matched on `discountPricePaisa`.
   *   • A product with no discount is matched on `pricePaisa`.
   *
   * ── The two paths are alternatives, so they are OR-ed ───────────────
   *
   * This is the part that is easy to get wrong, and it was wrong in the
   * first version of this code. The two paths were collected into a
   * flat `AND` list, which combines them with **AND**. A product would
   * then have to satisfy *both* "is discounted" *and* "is not
   * discounted" at the same time — so the filter matched nothing at
   * all, and every price-filtered query returned an empty catalogue.
   *
   * A silent empty result is the worst kind of bug here: the endpoint
   * returns 200, the response is well-formed, and the customer is simply
   * told the shop has nothing in their price range.
   */
  if (
    query.minPricePaisa !== undefined ||
    query.maxPricePaisa !== undefined
  ) {
    const min = query.minPricePaisa;
    const max = query.maxPricePaisa;

    /**
     * Builds the range filter for one column.
     */
    const rangeFor = (column: "pricePaisa" | "discountPricePaisa") => {
      const range: Prisma.IntFilter = {};

      if (min !== undefined) range.gte = min;
      if (max !== undefined) range.lte = max;

      return { [column]: range } as Prisma.ProductWhereInput;
    };

    // The two price paths are alternatives — one of them must hold, not
    // both. They live inside a single condition so the condition list
    // can still AND them with the other filters.
    conditions.push({
      OR: [
        {
          discountPricePaisa: { not: null },
          ...rangeFor("discountPricePaisa"),
        },
        {
          discountPricePaisa: null,
          ...rangeFor("pricePaisa"),
        },
      ],
    });
  }

  if (conditions.length > 0) {
    where.AND = conditions;
  }

  return where;
}

/**
 * Builds the Prisma `orderBy` clause.
 */
function buildOrderBy(
  sort: ProductListQuery["sort"],
): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }];
    case "price-asc":
      return [{ pricePaisa: "asc" }, { id: "asc" }];
    case "price-desc":
      return [{ pricePaisa: "desc" }, { id: "asc" }];
    case "name-asc":
      return [{ name: "asc" }, { id: "asc" }];
    case "name-desc":
      return [{ name: "desc" }, { id: "asc" }];
    case "newest":
    default:
      return [{ createdAt: "desc" }, { id: "asc" }];
  }
}

/**
 * Projects a product row onto the summary shape.
 */
function toSummary(product: {
  id: string;
  name: string;
  description: string;
  brand: string | null;
  pricePaisa: number;
  discountPricePaisa: number | null;
  discountPercentage: number | null;
  stockQuantity: number;
  ingredientTags: string[];
  concernSlugs: string[];
  climateTips: string | null;
  images: string[];
  isNewArrival: boolean;
  isBestSeller: boolean;
  category: { id: string; name: string; slug: string };
}): ProductSummary {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    brand: product.brand,
    pricePaisa: product.pricePaisa,
    discountPricePaisa: product.discountPricePaisa,
    discountPercentage: product.discountPercentage,
    effectivePricePaisa:
      product.discountPricePaisa ?? product.pricePaisa,
    stockQuantity: product.stockQuantity,
    inStock: product.stockQuantity > 0,
    ingredientTags: product.ingredientTags,
    concernSlugs: product.concernSlugs,
    climateTips: product.climateTips,
    images: product.images,
    isNewArrival: product.isNewArrival,
    isBestSeller: product.isBestSeller,
    category: product.category,
  };
}

/**
 * Lists products with search, filtering and pagination.
 */
export async function listProducts(
  query: ProductListQuery,
): Promise<ProductListResult> {
  const where = buildWhereClause(query);

  const skip = (query.page - 1) * query.limit;

  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      select: PRODUCT_SUMMARY_SELECT,
      orderBy: buildOrderBy(query.sort),
      skip,
      take: query.limit,
    }),
    db.product.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    products: rows.map(toSummary),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    appliedFilters: {
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
      sort: query.sort,
    },
  };
}

/**
 * Loads a single product by id.
 *
 * @returns the product, or `null` when it does not exist.
 */
export async function getProductById(
  productId: string,
): Promise<ProductDetail | null> {
  /**
   * `findFirst`, not `findUnique`.
   *
   * Prisma's `findUnique` accepts **only** unique fields in its `where`
   * — `id` and nothing else. Adding `archivedAt: null` beside the `id`
   * is a type error, and the query would not compile.
   *
   * `findFirst` takes an ordinary `where`, so it can express "this
   * product, and it is not archived" in one call.
   *
   * The consequence is the one that matters: an archived product's page
   * returns `null` here, which the route turns into a **404**. It does
   * not redirect, and it does not render a "sorry, withdrawn" page — an
   * archived product is, from the storefront's point of view, a product
   * that does not exist.
   */
  const product = await db.product.findFirst({
    where: { id: productId, ...ACTIVE_PRODUCT_WHERE },
    select: {
      ...PRODUCT_SUMMARY_SELECT,
      ingredients: true,
      reviews: {
        // Both flags, not just `isApproved`. A hidden review is still
        // `isApproved: true` — `isHidden` is what an admin sets when
        // withdrawing a review that was already public. Checking only
        // `isApproved` would let a withdrawn review keep counting
        // towards the average.
        where: { isApproved: true, isHidden: false },
        select: { rating: true },
      },
    },
  });

  if (!product) return null;

  const ratingSum = product.reviews.reduce(
    (total, review) => total + review.rating,
    0,
  );

  const related = await db.product.findMany({
    where: {
      categoryId: product.category.id,
      id: { not: product.id },
      stockQuantity: { gt: 0 },
      // An archived product must not appear in the "you may also like"
      // rail of a live one.
      ...ACTIVE_PRODUCT_WHERE,
    },
    select: { id: true },
    orderBy: [{ isBestSeller: "desc" }, { createdAt: "desc" }],
    take: 4,
  });

  const { reviews, ...rest } = product;

  return {
    ...toSummary(rest),
    ingredients: rest.ingredients,
    rating: {
      average:
        reviews.length > 0
          ? Math.round((ratingSum / reviews.length) * 10) / 10
          : 0,
      count: reviews.length,
    },
    relatedProductIds: related.map((item) => item.id),
  };
}

/**
 * The shape of a category in the catalogue API.
 */
export type CategorySummary = {
  id: string;
  name: string;
  slug: string;
  /**
   * The card image's **storage key**, or `null`.
   *
   * A key, not a URL — "Storage adapter keys — NOT raw URLs, so the
   * driver can be swapped". `imageUrl()` turns it into a URL at render
   * time.
   *
   * `null` means "no image", and the storefront falls back to the SVG
   * icon keyed by the slug.
   */
  image: string | null;
  /** How many products are in the category. */
  productCount: number;
};

/**
 * Lists the categories, with a product count for each.
 */
export async function listCategories(): Promise<CategorySummary[]> {
  const categories = await db.category.findMany({
    where: {
      /*
        Only categories that actually have something in them.

        A category with no sellable products is a **dead end** — clicking
        it shows an empty grid, and the customer is left wondering
        whether the shop is broken. Worse, in the navigation strip it
        takes a slot that a category with stock could have used.

        This is not a hack to hide one bad row. It is the rule a
        storefront should have: **do not offer a door that opens onto
        nothing.** The category row itself is kept in the database —
        it may have products that are merely archived, or it may be
        waiting for stock — but it is not advertised.
      */
      products: { some: ACTIVE_PRODUCT_WHERE },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      image: true,
      /**
       * A **filtered** relation count.
       *
       * The unfiltered `_count: { select: { products: true } }` counts
       * archived products too — so a category with nine sellable
       * products and one withdrawn one would offer "10 products" in the
       * filter panel, and clicking it would show nine.
       *
       * A count that disagrees with the list it counts is a filter that
       * lies, and a customer who clicks "10" and finds nine has been
       * told something untrue about the shop.
       *
       * The filtered form is safe here because this is a **to-many**
       * relation counted with a conditional aggregate — the category row
       * is never dropped. (A nested `where` on a *to-one* relation is a
       * different story: that is an inner join, and it drops the parent
       * row. See the note in `src/lib/cart/service.ts`.)
       */
      _count: { select: { products: { where: ACTIVE_PRODUCT_WHERE } } },
    },
    orderBy: { name: "asc" },
  });

  return categories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    image: category.image,
    productCount: category._count.products,
  }));
}

/**
 * Lists a single category by slug.
 */
export async function getCategoryBySlug(
  slug: string,
): Promise<CategorySummary | null> {
  const category = await db.category.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      slug: true,
      image: true,
      // The same filtered count — see the note above.
      _count: { select: { products: { where: ACTIVE_PRODUCT_WHERE } } },
    },
  });

  if (!category) return null;

  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    image: category.image,
    productCount: category._count.products,
  };
}

/**
 * The shape of a skin concern in the catalogue API.
 */
export type ConcernSummary = {
  id: string;
  /** The shopper-facing label — "Acne". */
  name: string;
  /**
   * The concern's slug — "acne".
   *
   * This is what the storefront links to (`/products?concern=acne`) and
   * what the catalogue filters on. The slug is stable across a rename,
   * which is why the product stores slugs and not ids.
   */
  slug: string;
  /**
   * The lead ingredient in this concern's family — "BHA".
   *
   * It is the **ingredient** axis, not the concern axis: it is what the
   * conflict engine compares against, and it is what the admin means
   * when they say "this concern is the BHA one". The browse page for
   * the concern filters on the **slug**, because a shopper asking
   * "which of these are for acne?" is asking about the product, not
   * about the ingredients it happens to contain.
   */
  tag: string;
  /** The other tags in this family, offered in the filter panel. */
  relatedTags: string[];
  /** The card image's storage key, or `null`. */
  image: string | null;
  /** A short line shown on the card. */
  description: string | null;
};

/**
 * Lists the skin concerns.
 *
 * ── Why this is a database read now ───────────────────────────────────────
 *
 * The concerns used to be a static array in
 * `src/lib/format/taxonomy.ts`. They became a table because the admin
 * now manages them — and a concern the admin adds must appear in the
 * storefront without a code change.
 *
 * The static array is **retired**, not kept in parallel: two lists would
 * drift, and the drifted one would be the one the storefront showed.
 */
export async function listConcerns(): Promise<ConcernSummary[]> {
  const concerns = await db.skinConcern.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      tag: true,
      relatedTags: true,
      image: true,
      description: true,
    },
    orderBy: { name: "asc" },
  });

  return concerns;
}

/**
 * The shape of a brand in the catalogue API.
 */
export type BrandSummary = {
  id: string;
  /** The canonical spelling — "CeraVe". */
  name: string;
  slug: string;
  /** The two-letter monogram shown when no logo is uploaded. */
  monogram: string;
  /** The logo's storage key, or `null`. */
  logo: string | null;
  /** A short line shown on the brand card. */
  description: string | null;
  /**
   * How many **sellable** products carry this brand.
   *
   * It is the count a shopper can act on, so it excludes archived
   * products — the same way the category grid's count does.
   */
  productCount: number;
};

/**
 * Lists the brands for the carousel.
 *
 * ── Why `Product.brand` is not joined ─────────────────────────────────────
 *
 * `Product.brand` is a plain string, and it stays one. The `Brand` table
 * holds the **presentation** data — the logo, the monogram, the display
 * order — and the product read is deliberately left untouched. So the
 * brand list is a single query over one table, with no join.
 *
 * ── Why the product count is a second query ───────────────────────────────
 *
 * Because `Product.brand` is a string and not a relation, Prisma cannot
 * count it for us — there is no `_count` to ask for. So the count comes
 * from a `groupBy` over the products' `brand` column, and the two
 * results are merged in memory.
 *
 * It is a second query because a brand card has to say *how much of the
 * shelf this house fills*. A nameplate with a logo and no count tells a
 * shopper the shop carries the brand; it does not tell them whether
 * there is one product of it or twenty. The count is what makes the
 * card informative rather than decorative — and it is the same
 * "42 products" signal the category grid already gives.
 *
 * The counts are grouped by the **exact** brand string, and the brand
 * rows hold the canonical spelling, so the two join cleanly. A product
 * whose brand is `null` is simply not counted against any brand.
 */
export async function listBrands(): Promise<BrandSummary[]> {
  const [brands, productCounts] = await Promise.all([
    db.brand.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        monogram: true,
        logo: true,
        description: true,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    db.product.groupBy({
      by: ["brand"],
      where: { ...ACTIVE_PRODUCT_WHERE, brand: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const counts = new Map<string, number>();

  for (const row of productCounts) {
    if (row.brand !== null) {
      counts.set(row.brand, row._count._all);
    }
  }

  return brands.map((brand) => ({
    ...brand,
    productCount: counts.get(brand.name) ?? 0,
  }));
}
