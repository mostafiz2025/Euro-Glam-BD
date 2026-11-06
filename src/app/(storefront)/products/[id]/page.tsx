import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { BuyPanel } from "@/components/commerce/buy-panel";
import { ProductCard } from "@/components/commerce/product-card";
import { ProductGallery } from "@/components/commerce/product-gallery";
import { ReviewForm } from "@/components/commerce/review-form";
import { ReviewSection } from "@/components/commerce/review-section";
import { Accordion } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import {
  ChevronRightIcon,
  LeafIcon,
  ShieldIcon,
  SparkleIcon,
  TruckIcon,
} from "@/components/ui/icons";
import { DiscountBadge, Price } from "@/components/ui/price";
import { Rating } from "@/components/ui/rating";
import { SectionHeading } from "@/components/ui/section-heading";
import { getOptionalUser } from "@/lib/auth/guards";
import { getProductById } from "@/lib/catalog/service";
import { listPublicReviews } from "@/lib/catalog/reviews";
import { hasCustomerReviewed } from "@/lib/catalog/review-submission";
import { displayBrand } from "@/lib/format/brand";
import { formatPaisa } from "@/lib/format/money";
import {
  parseIngredients,
  shortIngredientName,
} from "@/lib/format/ingredients";
import { fetchConcerns, fetchProducts } from "@/lib/format/server-data";

/**
 * The product detail page.
 *
 * ── A note on the route segment ──────────────────────────────────────────
 *
 * The route is `/products/[id]`, not `/products/[slug]`, because the
 * `Product` model has **no slug column**. The API is
 * `/api/products/[id]`, the service is `getProductById`, and the
 * product cards already link to `/products/${product.id}`. Naming the
 * segment "slug" while the value is an id would be a lie in the URL
 * space — and a lie that a future developer would "fix" by adding a
 * slug column and changing every link.
 *
 * ── The rules that govern this page ──────────────────────────────────────
 *
 * **1. The price is rendered, never derived.**
 *
 * `effectivePricePaisa` is what the customer pays, and the server is
 * the one that charges the card. The page shows that number.
 *
 * **2. The ingredients are narrowed, not trusted.**
 *
 * The column is `Jsonb`, so it is `unknown` at the type level.
 * `parseIngredients` is a total function — a malformed row renders as
 * an empty list, and the product page still works.
 *
 * **3. A product that does not exist is a 404.**
 *
 * Not an empty page. A "not found" that renders as a blank product
 * page is indistinguishable from a broken site.
 *
 * **4. The page is dynamic.**
 *
 * Stock, price and the rating all change. A cached product page showing
 * a price the shop no longer charges is worse than a slower page.
 *
 * ── How the page is rendered ─────────────────────────────────────────────
 *
 * Under Next.js 16's Cache Components, a page that reads the database
 * cannot block prerendering. The product is therefore read **inside**
 * a `<Suspense>` boundary, and the boundary is what the shell ships
 * with.
 *
 * That has a visible consequence: the breadcrumb, the section headings
 * and the delivery box — the parts that do not depend on the product —
 * could be prerendered, but the breadcrumb *does* depend on the
 * product's category and name, and the related-products heading depends
 * on the category. So the honest boundary is the whole product body.
 *
 * The shell is therefore thin: a page heading and a skeleton. The
 * product arrives behind it, streamed.
 */

/**
 * The props for the page.
 */
type ProductPageProps = {
  readonly params: Promise<{ id: string }>;
};

/**
 * The page metadata.
 *
 * The metadata reads the product, so it is request-time data. Under
 * Cache Components, `generateMetadata` is allowed to read uncached
 * data — it is not part of the prerendered page shell — but it must
 * never throw: a failed lookup produces a "not found" title rather
 * than failing the whole request.
 */
export async function generateMetadata({
  params,
}: ProductPageProps): Promise<Metadata> {
  const { id } = await params;
  const product = await getProductById(id).catch(() => null);

  if (!product) {
    return { title: "Product not found" };
  }

  return {
    title: product.name,
    description: product.description.slice(0, 155),
    openGraph: {
      title: product.name,
      description: product.description.slice(0, 155),
      type: "website",
    },
  };
}

/**
 * The product detail page.
 *
 * The shell does not read the database. The product body is streamed
 * behind a `<Suspense>` boundary, so the browser receives the page
 * frame immediately and the product fills in as it arrives.
 */
export default function ProductPage({ params }: ProductPageProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 pb-36 sm:px-6 sm:py-8 sm:pb-36 lg:px-8 lg:pb-8">
      {/*
       * The mobile purchase bar is `fixed` at the bottom of the
       * viewport, so it covers whatever is at the bottom of the page.
       * The extra bottom padding on mobile reserves the space so the
       * last line of the reviews — and the related products grid — are
       * reachable rather than trapped under the bar.
       *
       * The reservation covers the purchase bar *and* the site's
       * bottom tab bar, which is also fixed and sits below the
       * purchase bar.
       */}
      <Suspense fallback={<ProductSkeleton />}>
        <ProductBody params={params} />
      </Suspense>
    </div>
  );
}

/**
 * The product body.
 *
 * Reads the product, then the reviews and the related products. The
 * latter two are independent reads, so they run together — the page
 * waits for the slowest, not for the sum.
 */
async function ProductBody({ params }: ProductPageProps) {
  const { id } = await params;

  const product = await getProductById(id).catch((error: unknown) => {
    console.error("[storefront] Product detail failed:", error);
    return null;
  });

  if (!product) {
    notFound();
  }

  const ingredients = parseIngredients(product.ingredients);

  // The session is read here so the review form knows whether there is
  // a customer to attribute a review to. It is read *inside* the
  // `<Suspense>` boundary, not at the top of the page — this page is
  // already dynamic, and a session read at the top would make the
  // whole shell request-time for one piece of the page that only the
  // review section needs.
  //
  // The read is failure-tolerant: a session lookup that throws must not
  // take the product page down. The worst case is that the review form
  // is not offered, which is exactly what a signed-out visitor sees.
  const user = await getOptionalUser().catch((error: unknown) => {
    console.error("[storefront] Session read failed on the product page:", error);
    return null;
  });

  const [reviews, related, hasReviewed, { concerns }] = await Promise.all([
    listPublicReviews(product.id),
    fetchRelatedProducts(product.relatedProductIds, product.category.slug),
    user
      ? hasCustomerReviewed(product.id, user.id).catch(() => false)
      : Promise.resolve(false),
    fetchConcerns(),
  ]);

  /**
   * The product's concerns, resolved to labels.
   *
   * The product stores **slugs**, because a slug survives a rename and
   * an id would not. But a shopper reads names, so the slugs are
   * resolved against the shop's own concerns here.
   *
   * A slug the shop no longer has is **dropped** rather than shown as a
   * bare slug. A chip reading "fine-lines" is not a label, it is a
   * leaked implementation detail — and the shopper cannot click it
   * anyway, because the browse page for it would be empty.
   */
  const productConcerns = product.concernSlugs
    .map((slug) => concerns.find((concern) => concern.slug === slug))
    .filter((concern): concern is (typeof concerns)[number] => Boolean(concern));

  const isDiscounted =
    product.discountPricePaisa !== null &&
    product.discountPricePaisa < product.pricePaisa;

  /**
   * The brand, from the stored column — falling back to the derivation
   * from the name for products written before the column existed.
   */
  const brand = displayBrand(product.brand, product.name);

  return (
    <>
      {/* ── The breadcrumb ───────────────────────────────────────────── */}
      <nav aria-label="Breadcrumb" className="mb-5">
        <ol className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-muted">
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
            <Link
              href="/products"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Shop
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <Link
              href={`/products?category=${product.category.slug}`}
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {product.category.name}
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <span aria-current="page" className="font-medium text-foreground">
              {product.name}
            </span>
          </li>
        </ol>
      </nav>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-12">
        {/* ── The gallery ─────────────────────────────────────────────── */}
        <div>
          <ProductGallery
            images={product.images}
            name={product.name}
            categoryName={product.category.name}
          />
        </div>

        {/* ── The buy box ─────────────────────────────────────────────── */}
        <div>
          {/* The badges. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {isDiscounted ? (
              <DiscountBadge
                pricePaisa={product.pricePaisa}
                discountPricePaisa={product.discountPricePaisa}
                discountPercentage={product.discountPercentage}
              />
            ) : null}

            {product.isNewArrival ? <Badge variant="soft">New</Badge> : null}
            {product.isBestSeller ? <Badge variant="dark">Best Seller</Badge> : null}

            {!product.inStock ? <Badge variant="outline">Out of stock</Badge> : null}
          </div>

          <h1 className="font-serif text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-3xl">
            {product.name}
          </h1>

          {/*
            The brand, on its own line above the category.

            The product's name already carries the brand prefix — the
            admin typed "CeraVe Hydrating Facial Cleanser" — so the
            brand is shown as a separate label rather than repeated
            inside the title. It comes from the stored column, with the
            derivation from the name as the fallback for products
            written before the column existed.
          */}
          {brand ? (
            <p className="mt-1.5 text-sm font-medium text-foreground-muted">
              {brand}
            </p>
          ) : null}

          <p className="mt-1.5 text-xs font-medium uppercase tracking-wider text-brand-600">
            {product.category.name}
          </p>

          {/* The rating. */}
          {product.rating.count > 0 ? (
            <a
              href="#reviews-heading"
              className="mt-3 inline-flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Rating
                average={product.rating.average}
                count={product.rating.count}
                size="md"
                showNumbers
              />
              <span className="text-xs text-foreground-muted underline underline-offset-2">
                Read reviews
              </span>
            </a>
          ) : (
            <p className="mt-3 text-xs text-foreground-muted">No reviews yet</p>
          )}

          {/* The price. */}
          <div className="mt-5 rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
            <div className="flex flex-wrap items-end gap-3">
              <Price
                pricePaisa={product.pricePaisa}
                discountPricePaisa={product.discountPricePaisa}
                size="lg"
              />

              {isDiscounted ? (
                <span className="pb-1 text-xs font-medium text-emerald-600">
                  You save{" "}
                  {formatPaisa(
                    product.pricePaisa - (product.discountPricePaisa ?? 0),
                  )}
                </span>
              ) : null}
            </div>

            <p className="mt-1.5 text-xs text-foreground-muted">
              Inclusive of all taxes. Delivery across Bangladesh.
            </p>

            {/*
              The skin concerns.

              They sit **above** the ingredient chips, because the
              concern is the answer to "what is this for?" and the
              ingredient is the answer to "what is in it?" — and the
              shopper asked the first question first.

              Each chip links to that concern's browse page, so the
              shopper can see the rest of the shelf they are shopping
              from.
            */}
            {productConcerns.length > 0 ? (
              <ul className="mt-4 flex flex-wrap gap-1.5">
                {productConcerns.map((concern) => (
                  <li key={concern.id}>
                    <Link
                      href={`/products?concern=${encodeURIComponent(concern.slug)}`}
                      className="inline-block rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                    >
                      {concern.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* The ingredient chips. */}
            {product.ingredientTags.length > 0 ? (
              <ul
                className={[
                  "flex flex-wrap gap-1.5",
                  productConcerns.length > 0 ? "mt-2.5" : "mt-4",
                ].join(" ")}
              >
                {product.ingredientTags.map((tag) => (
                  <li key={tag}>
                    <Link
                      href={`/products?ingredient=${encodeURIComponent(tag)}`}
                      className="inline-block rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 transition-colors hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      {shortIngredientName(tag)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {/* The quantity and the buttons. */}
          <div className="mt-5">
            <BuyPanel
              productId={product.id}
              stockQuantity={product.stockQuantity}
              inStock={product.inStock}
            />
          </div>

          {/* The trust row. */}
          <ul className="mt-6 grid gap-3 sm:grid-cols-3">
            {[
              {
                icon: <ShieldIcon width={18} height={18} />,
                title: "100% Authentic",
                body: "Sourced from authorised distributors",
              },
              {
                icon: <TruckIcon width={18} height={18} />,
                title: "Nationwide Delivery",
                body: "Cash on delivery available",
              },
              {
                icon: <LeafIcon width={18} height={18} />,
                title: "Climate-Aware",
                body: "Suited to Bangladesh's humidity",
              },
            ].map((item) => (
              <li
                key={item.title}
                className="flex items-start gap-2.5 rounded-2xl border border-border bg-surface p-3.5"
              >
                <span className="mt-0.5 text-brand-600">{item.icon}</span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-foreground">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-foreground-muted">
                    {item.body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ── The accordions ────────────────────────────────────────────── */}
      <div className="mt-12 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <Accordion
          defaultOpenId="benefits"
          allowMultiple
          items={[
            {
              id: "benefits",
              title: "Key Benefits & Description",
              subtitle: "What it does and who it is for",
              content: (
                <div className="space-y-3">
                  <p>{product.description}</p>

                  {product.climateTips ? (
                    <p className="flex items-start gap-2 rounded-xl bg-brand-50 p-3 text-xs text-brand-800">
                      <SparkleIcon width={14} height={14} className="mt-0.5 shrink-0" />
                      <span>
                        <span className="font-semibold">Climate tip. </span>
                        {product.climateTips}
                      </span>
                    </p>
                  ) : null}

                  {product.ingredientTags.length > 0 ? (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
                        Key actives
                      </h4>

                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {product.ingredientTags.map((tag) => (
                          <li
                            key={tag}
                            className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-medium text-foreground-muted"
                          >
                            {shortIngredientName(tag)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ),
            },
            {
              id: "how-to-use",
              title: "How to Use",
              subtitle: "The order that actually works",
              content: (
                <ol className="list-decimal space-y-2 pl-5">
                  <li>
                    Start with a clean, dry face. Pat on toner or essence
                    if you use one.
                  </li>
                  <li>
                    Apply a small amount to the face and neck. A pea-sized
                    amount is enough for the whole face.
                  </li>
                  <li>
                    Follow with a moisturiser, and in the morning finish
                    with sunscreen.
                  </li>
                  <li>
                    Introduce new actives one at a time, and patch test
                    for 24 hours before full use.
                  </li>
                </ol>
              ),
            },
            {
              id: "ingredients",
              title: "Ingredients",
              subtitle:
                ingredients.source ?? "As listed on the manufacturer label",
              content:
                ingredients.ingredients.length > 0 ? (
                  <div className="space-y-3">
                    <ul className="flex flex-wrap gap-1.5">
                      {ingredients.ingredients.map((ingredient, index) => (
                        <li
                          key={`${ingredient}-${index}`}
                          className="rounded-lg bg-surface-sunken px-2 py-1 text-[11px] text-foreground-muted"
                        >
                          {ingredient}
                        </li>
                      ))}
                    </ul>

                    {ingredients.notes ? (
                      <p className="text-xs text-foreground-muted">
                        {ingredients.notes}
                      </p>
                    ) : null}

                    <p className="text-[11px] text-foreground-muted">
                      Formulae can change between batches. Always read the
                      pack you receive for the definitive list.
                    </p>
                  </div>
                ) : (
                  <p className="text-foreground-muted">
                    The full ingredient list has not been published for this
                    product yet. The manufacturer label on the pack is
                    always the definitive source.
                  </p>
                ),
            },
            {
              id: "authenticity",
              title: "Authenticity Guarantee",
              subtitle: "Where it comes from and what we promise",
              content: (
                <div className="space-y-3">
                  <p>
                    Every product on Euro Glam BD is sourced through
                    authorised distributors and carries the original
                    manufacturer packaging. If a product arrives
                    tampered with, not authentic, or past its expiry, we
                    replace it or refund you in full.
                  </p>

                  <ul className="space-y-1.5">
                    {[
                      "Batch and expiry checked before dispatch",
                      "Original seal and tamper evidence intact",
                      "Full refund if authenticity is in doubt",
                    ].map((line) => (
                      <li key={line} className="flex items-start gap-2">
                        <span
                          aria-hidden="true"
                          className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500"
                        />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            },
          ]}
        />

        {/* ── The delivery box ────────────────────────────────────────── */}
        <aside className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)] lg:sticky lg:top-24">
          <h2 className="text-sm font-bold text-foreground">Delivery</h2>

          <dl className="mt-3 space-y-2.5 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="text-foreground-muted">Inside Dhaka</dt>
              <dd className="font-medium text-foreground">৳80</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-foreground-muted">Outside Dhaka</dt>
              <dd className="font-medium text-foreground">৳130</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-foreground-muted">Free delivery</dt>
              <dd className="font-medium text-foreground">Over ৳3,000</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-foreground-muted">Payment</dt>
              <dd className="font-medium text-foreground">
                Cash on delivery
              </dd>
            </div>
          </dl>

          <p className="mt-4 rounded-xl bg-surface-sunken p-3 text-[11px] leading-relaxed text-foreground-muted">
            Orders are dispatched within 48 hours. Local delivery typically
            arrives in 1–3 days.
          </p>
        </aside>
      </div>

      {/* ── The reviews ───────────────────────────────────────────────── */}
      <ReviewSection
        reviews={reviews}
        error={reviews.error}
        form={
          user ? (
            <ReviewForm
              productId={product.id}
              productName={product.name}
              hasReviewed={hasReviewed}
            />
          ) : null
        }
        signedOutPrompt={
          user ? null : (
            <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
              <p className="text-sm font-semibold text-foreground">
                Sign in to write a review
              </p>

              <p className="mt-1.5 text-xs leading-relaxed text-foreground-muted">
                Reviews are tied to your account, so we can mark the ones
                from real purchases as verified and keep them honest.
              </p>

              <div className="mt-4">
                <ButtonLink
                  href={`/login?next=${encodeURIComponent(`/products/${product.id}`)}`}
                  variant="outline"
                  size="sm"
                >
                  Sign in to review
                </ButtonLink>
              </div>
            </div>
          )
        }
      />

      {/* ── The related products ──────────────────────────────────────── */}
      {related.products.length > 0 ? (
        <section aria-labelledby="related-products" className="mt-14">
          <SectionHeading
            title="You May Also Like"
            subtitle={`More from ${product.category.name}.`}
            action={
              <Link
                href={`/products?category=${product.category.slug}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                View all
                <ChevronRightIcon width={16} height={16} />
              </Link>
            }
            className="mb-8"
          />

          <h2 id="related-products" className="sr-only">
            You May Also Like
          </h2>

          <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
            {related.products.map((item) => (
              <ProductCard key={item.id} product={item} imageAspect="portrait" />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * The placeholder shown while the product loads.
 *
 * It reserves the shape of the two-column layout, so the page does not
 * jump when the real content replaces it.
 */
function ProductSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="mb-5 h-3 w-64 animate-pulse rounded-full bg-surface-muted" />

      <div className="lg:grid lg:grid-cols-2 lg:gap-12">
        <div className="aspect-[3/4] animate-pulse rounded-[var(--radius-card)] bg-surface-muted" />

        <div>
          <div className="h-5 w-24 animate-pulse rounded-full bg-surface-muted" />
          <div className="mt-3 h-8 w-4/5 animate-pulse rounded-full bg-surface-muted" />
          {/* The brand line, between the title and the category. */}
          <div className="mt-2 h-4 w-24 animate-pulse rounded-full bg-surface-muted" />
          <div className="mt-2 h-4 w-1/3 animate-pulse rounded-full bg-surface-muted" />
          <div className="mt-5 h-28 animate-pulse rounded-[var(--radius-card)] bg-surface-muted" />
          <div className="mt-5 h-12 animate-pulse rounded-full bg-surface-muted" />
        </div>
      </div>
    </div>
  );
}

/**
 * Loads the related products.
 *
 * The service returns the *ids* of the related products. Rather than a
 * second database query for each id, the listing endpoint is used with
 * the category filter — one query, and it returns the full summary the
 * card needs.
 */
async function fetchRelatedProducts(
  relatedIds: readonly string[],
  categorySlug: string,
): Promise<{ readonly products: Awaited<ReturnType<typeof fetchProducts>>["products"] }> {
  if (relatedIds.length === 0) {
    return { products: [] };
  }

  const result = await fetchProducts({
    category: categorySlug,
    limit: 4,
    sort: "newest",
  });

  // Prefer the ids the service nominated, in its order. The listing
  // may return more than four, or a different set, if the catalogue
  // changed between the two reads — so the intersection is taken
  // defensively rather than assumed.
  const byId = new Map(result.products.map((item) => [item.id, item]));
  const preferred = relatedIds
    .map((id) => byId.get(id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  return { products: preferred.length > 0 ? preferred : result.products.slice(0, 4) };
}
