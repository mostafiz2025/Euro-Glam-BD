import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";

import { StockAdjustDialog } from "@/components/admin/inventory/StockAdjustDialog";
import {
  LowStockBadge,
  OutOfStockBadge,
} from "@/components/admin/inventory/LowStockBadge";
import { DeleteProductDialog } from "@/components/admin/products/DeleteProductDialog";
import { ProductFormDialog } from "@/components/admin/products/ProductFormDialog";
import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatusBadge,
} from "@/components/admin/primitives";
import {
  LOW_STOCK_THRESHOLD,
  listAdminProducts,
  type ProductStockFilter,
} from "@/lib/admin/stats";
import {
  computeMarginPercentage,
  unitProfitPaisa,
} from "@/lib/admin/profit";
import { db } from "@/lib/db";
import { displayBrand, splitBrandAndTitle } from "@/lib/format/brand";
import { imageUrl } from "@/lib/format/image";
import { discountPercent, formatPaisa } from "@/lib/format/money";
import { adminProductQuerySchema } from "@/lib/validation/admin";

/**
 * The inventory management screen.
 *
 * ── What an admin can do here ────────────────────────────────────────────
 *
 * Adjust how many units of a product are on the shelf. That is the whole
 * surface, and it is deliberately narrow.
 *
 * A product's **price** and **identity** are not editable here. Those are
 * part of the catalogue's contract with the customer, and changing a
 * price is a commercial decision that belongs to the shop owner with a
 * clear record of the old price, the new price and the reason. Stock is
 * different: it moves daily, it is corrected after a miscount, and it is
 * the one number that must never be wrong in a way that lets a customer
 * order something the shop does not have.
 *
 * ── The filters are links ────────────────────────────────────────────────
 *
 * Each stock band is a URL, not a button that swaps a list in place. An
 * admin looking at "12 out of stock" can send that link to a colleague,
 * and the back button returns to where they were — the same rule the
 * storefront's pagination follows.
 *
 * ── What a row shows ─────────────────────────────────────────────────────
 *
 * A row carries a **thumbnail**, the **brand** above the **title**, and
 * **both prices**.
 *
 * The thumbnail exists because an admin scanning a shelf of products
 * recognises them by their photograph, not by a line of text. The image
 * is a **derived** one — the row holds storage keys and the URL is
 * computed at render time — so the same row keeps working if the
 * storage driver is swapped for a bucket.
 *
 * The brand is **derived** from the product name rather than stored: the
 * catalogue has no `Brand` table, and the brand has always lived inside
 * the name ("CeraVe Hydrating Facial Cleanser"). The derivation uses a
 * closed registry of the brands this shop stocks, so it never guesses —
 * an unregistered product shows its whole name as the title rather than
 * a wrong brand.
 *
 * Both prices are shown because the row has to answer two questions at
 * once: what does the customer pay, and what did it cost before? A row
 * that shows only the effective price cannot answer "is this
 * discounted?", and an admin judging a discount needs to.
 *
 * ── The cost side of the row ──────────────────────────────────────────────
 *
 * The row also carries the **purchase price** — what the shop paid — the
 * **selling price** — what it charges — and the **margin** on one unit,
 * as an amount and as a percentage.
 *
 * These are what turn the inventory list from a stock sheet into a
 * costing sheet: an admin can see at a glance which products earn
 * nothing, which are sold at a loss, and which carry the shop.
 *
 * A **missing** cost is shown as a dash, never as a zero. A zero would
 * claim the goods were free and report a 100% margin on a product the
 * shop paid real money for — and the profit figures exclude such a
 * product rather than counting it at zero, so the row and the dashboard
 * agree on what is and is not covered.
 *
 * A **negative** margin is coloured red. A loss that does not look like
 * a loss is a loss that goes unnoticed.
 */
export const metadata: Metadata = {
  title: "Inventory",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

/**
 * The inventory page.
 */
export default async function AdminProductsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const raw = await searchParams;

  const query = adminProductQuerySchema.safeParse({
    stock: firstValue(raw.stock),
    search: firstValue(raw.search),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Inventory"
          description="Adjust how many units of each product are on the shelf."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const [result, categories, concerns] = await Promise.all([
    listAdminProducts(query.data).catch((error: unknown) => {
      console.error("[admin] Inventory list failed:", error);
      return null;
    }),
    db.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    /*
      The skin concerns, for the "Shop by Concern" picker.

      Read from the `SkinConcern` table, so the vocabulary is the shop's
      own — an admin adds a concern in the Concerns panel and it is
      available in the product form immediately, with no code change.

      The read is **not** fatal: a failed concern query leaves the
      inventory list working, and the picker simply offers nothing.
    */
    db.skinConcern
      .findMany({
        select: { slug: true, name: true, description: true },
        orderBy: { name: "asc" },
      })
      .catch((error: unknown) => {
        console.error("[admin] Concern list failed:", error);
        return [];
      }),
  ]);

  if (!result) {
    return (
      <>
        <PageHeading
          title="Inventory"
          description="Adjust how many units of each product are on the shelf."
        />

        <AdminErrorState message="We could not load the inventory. Please try again in a moment." />
      </>
    );
  }

  const { products, pagination, counts } = result;

  const filters: { value: ProductStockFilter; label: string; count: number }[] =
    [
      { value: "ALL", label: "All", count: counts.all },
      { value: "IN_STOCK", label: "In stock", count: counts.inStock },
      { value: "OUT_OF_STOCK", label: "Out of stock", count: counts.outOfStock },
      { value: "LOW_STOCK", label: "Low stock", count: counts.lowStock },
      { value: "ARCHIVED", label: "Archived", count: counts.archived },
    ];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeading
          title="Inventory"
          description="Add, edit and archive products, and adjust how many units of each are on the shelf."
        />

        <ProductFormDialog
          categories={categories}
          concerns={concerns}
          product={null}
        />
      </div>

      {/* ── The stock filters ─────────────────────────────────────────── */}
      <nav aria-label="Stock filter">
        <ul className="flex flex-wrap gap-2">
          {filters.map((filter) => {
            const isActive = query.data.stock === filter.value;

            return (
              <li key={filter.value}>
                <Link
                  href={href({ stock: filter.value, search: query.data.search })}
                  aria-current={isActive ? "page" : undefined}
                  className={[
                    "inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium",
                    "transition-colors duration-200",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                    isActive
                      ? "bg-neutral-900 text-white"
                      : "bg-surface text-foreground-muted ring-1 ring-border hover:bg-surface-sunken hover:text-foreground",
                  ].join(" ")}
                >
                  {filter.label}
                  <span
                    className={[
                      "text-xs tabular-nums",
                      isActive ? "text-neutral-300" : "text-foreground-muted",
                    ].join(" ")}
                  >
                    {filter.count}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Products"
          description={`${pagination.total} product${pagination.total === 1 ? "" : "s"} match this filter. Adjustments are recorded in the audit log.`}
        />

        {products.length === 0 ? (
          <AdminEmptyState
            title="No products in this band"
            description="Nothing matches this stock filter right now. Try another band above."
          />
        ) : (
          <>
            {/*
              The table is a real `<table>` on desktop and a stack of
              cards on mobile. A `<table>` that is reflowed with CSS
              still reads its headers out of order on a phone, so the
              mobile layout drops the table semantics entirely and uses
              labelled blocks instead.
            */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-foreground-muted">
                    <th scope="col" className="px-5 py-3 font-medium">
                      Product
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Category
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Concerns
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Price
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Cost
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Margin
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Stock
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Sold
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-neutral-100">
                  {products.map((product) => {
                    /*
                      The brand is the **stored** column when the admin
                      has set one, and the derivation from the name when
                      they have not — so a product written before the
                      column existed still shows a brand, and a product
                      whose brand was deliberately cleared stays blank
                      rather than being re-derived behind the admin's
                      back.

                      The title still comes from the derivation. The name
                      is the product's identity — it feeds the image alt
                      text and the `OrderItem` snapshot — so it is never
                      rewritten.
                    */
                    const brand = displayBrand(product.brand, product.name);
                    const { title } = splitBrandAndTitle(product.name);

                    return (
                    <tr key={product.id} className="align-top">
                      <td className="px-5 py-3">
                        {/*
                          The thumbnail and the name sit side by side so
                          an admin recognises the product by its photo
                          rather than by reading a string of text. The
                          thumbnail is a **derived** image — the row
                          holds storage keys, and the URL is computed at
                          render time, so a product whose image was
                          uploaded last week shows that image without
                          the row ever holding a URL.
                        */}
                        <div className="flex items-start gap-3">
                          <div
                            className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-brand-gradient"
                            aria-hidden="true"
                          >
                            {product.images.length > 0 ? (
                              <Image
                                src={imageUrl(product.images[0])}
                                alt=""
                                fill
                                sizes="48px"
                                className="object-cover"
                              />
                            ) : null}
                          </div>

                          <div className="min-w-0">
                            {brand ? (
                              <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                                {brand}
                              </p>
                            ) : null}

                            <Link
                              href={`/products/${product.id}`}
                              className="font-medium text-foreground underline-offset-2 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                            >
                              {title}
                            </Link>

                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {product.isBestSeller ? (
                                <StatusBadge status="APPROVED" label="Best seller" />
                              ) : null}
                              {product.isNewArrival ? (
                                <StatusBadge status="APPROVED" label="New" />
                              ) : null}
                              {product.archivedAt ? (
                                <StatusBadge status="HIDDEN" label="Archived" />
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="px-5 py-3 text-foreground-muted">
                        {product.category.name}
                      </td>

                      {/*
                        The skin concerns the product addresses.

                        The slugs are the **stored** values, so they are
                        read straight from the row. A product with no
                        concerns shows a dash rather than an empty cell,
                        so the column never looks like it failed to
                        render.
                      */}
                      <td className="px-5 py-3 text-foreground-muted">
                        {product.concernSlugs.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {product.concernSlugs.map((slug) => (
                              <span
                                key={slug}
                                className="rounded-full bg-surface-muted px-2 py-0.5 text-xs capitalize"
                              >
                                {slug.replace(/-/g, " ")}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-foreground-muted">—</span>
                        )}
                      </td>

                      {/*
                        Both prices are shown. The customer pays the
                        discount price, but an admin looking at the
                        shelf needs to see what the product *was* worth
                        to judge whether the discount is sensible — and
                        a row showing only one price cannot answer
                        "is this discounted?".
                      */}
                      <td className="px-5 py-3 text-right">
                        <span className="flex flex-wrap items-baseline justify-end gap-x-2">
                          <span className="font-semibold tabular-nums text-foreground">
                            {formatPaisa(
                              product.discountPricePaisa ?? product.pricePaisa,
                            )}
                          </span>

                          {product.discountPricePaisa !== null &&
                          product.discountPricePaisa < product.pricePaisa ? (
                            <span className="text-xs tabular-nums text-foreground-muted line-through">
                              {formatPaisa(product.pricePaisa)}
                            </span>
                          ) : null}
                        </span>

                        {discountPercent(
                          product.pricePaisa,
                          product.discountPricePaisa,
                        ) !== null ? (
                          <span className="mt-1 block text-xs font-medium text-brand-700">
                            {discountPercent(
                              product.pricePaisa,
                              product.discountPricePaisa,
                            )}
                            % off
                          </span>
                        ) : null}
                      </td>

                      {/*
                        The cost side of the ledger.

                        The **purchase price** is what the shop paid and
                        the **selling price** is what it charges. Both
                        are shown because both can be blank, and a
                        blank is a meaningful state — "not known" — not
                        a zero. The row says so rather than rendering a
                        zero that would report a 100% margin.
                      */}
                      <td className="px-5 py-3 text-right tabular-nums">
                        {product.purchasePricePaisa !== null ? (
                          <span className="text-foreground">
                            {formatPaisa(product.purchasePricePaisa)}
                          </span>
                        ) : (
                          <span
                            className="text-foreground-muted"
                            title="The cost of this product has not been recorded."
                          >
                            —
                          </span>
                        )}

                        {product.sellingPricePaisa !== null ? (
                          <span className="mt-1 block text-xs text-foreground-muted">
                            sells {formatPaisa(product.sellingPricePaisa)}
                          </span>
                        ) : null}
                      </td>

                      {/*
                        The margin on one unit.

                        The margin is the selling price minus the cost,
                        and it is shown as the **amount** and the
                        **percentage**. The percentage is `null` when
                        there is no revenue to divide by — a percentage
                        against a zero base is a division by zero
                        wearing a percentage's clothes, and the row
                        renders it as a dash.

                        The amount is negative when the product is sold
                        at a loss, and it is coloured to say so. A loss
                        that does not look like a loss is a loss that
                        goes unnoticed.
                      */}
                      <td className="px-5 py-3 text-right tabular-nums">
                        {(() => {
                          const sellingPaisa =
                            product.sellingPricePaisa ??
                            product.discountPricePaisa ??
                            product.pricePaisa;

                          if (
                            product.purchasePricePaisa === null ||
                            sellingPaisa <= 0
                          ) {
                            return (
                              <span
                                className="text-foreground-muted"
                                title="The cost of this product has not been recorded."
                              >
                                —
                              </span>
                            );
                          }

                          const marginPaisa = unitProfitPaisa(
                            sellingPaisa,
                            product.purchasePricePaisa,
                            0,
                          );

                          /*
                            The shared percentage function, so this
                            row and the dashboard's margin cannot
                            report different numbers for the same sale.

                            It is `null` against a zero base — a
                            percentage against zero is a division by
                            zero wearing a percentage's clothes.
                          */
                          const marginPercentage = computeMarginPercentage(
                            marginPaisa,
                            sellingPaisa,
                          );

                          return (
                            <>
                              <span
                                className={[
                                  "font-semibold",
                                  marginPaisa < 0
                                    ? "text-red-700"
                                    : marginPaisa === 0
                                      ? "text-foreground-muted"
                                      : "text-foreground",
                                ].join(" ")}
                              >
                                {formatPaisa(marginPaisa)}
                              </span>

                              <span
                                className={[
                                  "mt-1 block text-xs",
                                  marginPaisa < 0
                                    ? "text-red-700"
                                    : "text-foreground-muted",
                                ].join(" ")}
                              >
                                {marginPercentage === null
                                  ? "—"
                                  : `${Math.round(marginPercentage)}%`}
                              </span>
                            </>
                          );
                        })()}
                      </td>

                      <td className="px-5 py-3 text-right">
                        <span className="font-semibold tabular-nums text-foreground">
                          {product.stockQuantity}
                        </span>

                        <div className="mt-1 flex justify-end">
                          <StockBadge quantity={product.stockQuantity} />
                        </div>
                      </td>

                      {/*
                        The units sold.

                        This is the point-of-sale counter. It is a
                        convenience figure, not an accounting record —
                        the authoritative figure is always the sum of
                        the order items — so a counter that drifted
                        would misreport a popularity ranking but could
                        never misreport the shop's money.
                      */}
                      <td className="px-5 py-3 text-right tabular-nums text-foreground-muted">
                        {product.soldCount}
                      </td>

                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <ProductFormDialog
                            categories={categories}
                            concerns={concerns}
                            product={product}
                          />

                          <StockAdjustDialog
                            productId={product.id}
                            productName={product.name}
                            currentQuantity={product.stockQuantity}
                          />

                          <DeleteProductDialog
                            productId={product.id}
                            productName={product.name}
                            isArchived={product.archivedAt !== null}
                            canHardDelete={
                              product.references.orderItems === 0 &&
                              product.references.cartItems === 0 &&
                              product.references.reviews === 0
                            }
                          />
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── The mobile layout ──────────────────────────────────── */}
            <ul className="divide-y divide-neutral-100 md:hidden">
              {products.map((product) => {
                // The same rule as the desktop table — see above.
                const brand = displayBrand(product.brand, product.name);
                const { title } = splitBrandAndTitle(product.name);

                return (
                <li key={product.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <div
                        className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-brand-gradient"
                        aria-hidden="true"
                      >
                        {product.images.length > 0 ? (
                          <Image
                            src={imageUrl(product.images[0])}
                            alt=""
                            fill
                            sizes="48px"
                            className="object-cover"
                          />
                        ) : null}
                      </div>

                      <div className="min-w-0">
                        {brand ? (
                          <p className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
                            {brand}
                          </p>
                        ) : null}

                        <Link
                          href={`/products/${product.id}`}
                          className="text-sm font-semibold text-foreground underline-offset-2 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                        >
                          {title}
                        </Link>

                        {/*
                          Both prices are shown here too. A phone shows
                          fewer columns, not less information — an admin
                          working from a shelf on a phone still needs
                          to see what the product cost before the
                          discount.
                        */}
                        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-foreground-muted">
                          <span className="text-sm font-semibold tabular-nums text-foreground">
                            {formatPaisa(
                              product.discountPricePaisa ?? product.pricePaisa,
                            )}
                          </span>

                          {product.discountPricePaisa !== null &&
                          product.discountPricePaisa < product.pricePaisa ? (
                            <span className="tabular-nums line-through">
                              {formatPaisa(product.pricePaisa)}
                            </span>
                          ) : null}

                          <span>{product.category.name}</span>
                        </p>

                        {/*
                          The cost side, and the units sold.

                          A phone shows fewer **columns**, not less
                          information — an admin working from a shelf
                          still needs to see what the product cost
                          before the discount, and how many have gone.

                          A product whose cost has never been recorded
                          says so with a dash, not a zero. A zero would
                          claim the goods were free.
                        */}
                        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-foreground-muted">
                          {product.purchasePricePaisa !== null ? (
                            <span className="tabular-nums">
                              cost {formatPaisa(product.purchasePricePaisa)}
                            </span>
                          ) : (
                            <span className="text-foreground-muted">
                              cost not recorded
                            </span>
                          )}

                          <span className="tabular-nums">
                            {product.soldCount} sold
                          </span>
                        </p>

                        {product.archivedAt ? (
                          <div className="mt-1.5">
                            <StatusBadge status="HIDDEN" label="Archived" />
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums text-foreground">
                        {product.stockQuantity}
                      </p>

                      <div className="mt-1 flex justify-end">
                        <StockBadge quantity={product.stockQuantity} />
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ProductFormDialog
                      categories={categories}
                      concerns={concerns}
                      product={product}
                    />

                    <StockAdjustDialog
                      productId={product.id}
                      productName={product.name}
                      currentQuantity={product.stockQuantity}
                    />

                    <DeleteProductDialog
                      productId={product.id}
                      productName={product.name}
                      isArchived={product.archivedAt !== null}
                      canHardDelete={
                        product.references.orderItems === 0 &&
                        product.references.cartItems === 0 &&
                        product.references.reviews === 0
                      }
                    />
                  </div>
                </li>
                );
              })}
            </ul>
          </>
        )}
      </AdminCard>

      {pagination.totalPages > 1 ? (
        <nav aria-label="Pagination" className="mt-6 flex justify-center">
          <ul className="flex items-center gap-1.5">
            {pagination.hasPreviousPage ? (
              <li>
                <Link
                  href={href({
                    stock: query.data.stock,
                    search: query.data.search,
                    page: pagination.page - 1,
                  })}
                  className="inline-flex h-9 items-center rounded-full border border-border bg-surface px-3.5 text-sm font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  Previous
                </Link>
              </li>
            ) : null}

            <li className="px-3 text-sm tabular-nums text-foreground-muted">
              Page {pagination.page} of {pagination.totalPages}
            </li>

            {pagination.hasNextPage ? (
              <li>
                <Link
                  href={href({
                    stock: query.data.stock,
                    search: query.data.search,
                    page: pagination.page + 1,
                  })}
                  className="inline-flex h-9 items-center rounded-full border border-border bg-surface px-3.5 text-sm font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  Next
                </Link>
              </li>
            ) : null}
          </ul>
        </nav>
      ) : null}
    </>
  );
}

/**
 * The stock badge for a quantity.
 *
 * ── Why this delegates to the shared badges ──────────────────────────────
 *
 * The bands are defined in `src/lib/admin/stats.ts`, and the **same**
 * predicates must decide both the badge and the filter counts. A second
 * copy of the rule — even a correct one — is a rule that will drift when
 * the threshold changes.
 *
 * And the bands are **nested**, not a partition:
 *
 *   • `stockQuantity <= 0` → **out of stock**. Not buyable at all.
 *   • `0 < stockQuantity <= LOW_STOCK_THRESHOLD` → **low stock**. Buyable,
 *     but nearly gone.
 *   • Above the threshold → nothing. No badge: a badge on every row
 *     would train the eye to ignore badges, and "plenty of stock" is not
 *     news.
 *
 * The `> 0` half of the low-stock rule is what keeps a zero-unit product
 * out of the amber band. It means "reorder soon", not "there are none".
 */
function StockBadge({ quantity }: { readonly quantity: number }) {
  if (quantity <= 0) {
    return <OutOfStockBadge />;
  }

  if (quantity <= LOW_STOCK_THRESHOLD) {
    return <LowStockBadge stockQuantity={quantity} />;
  }

  return null;
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

/**
 * Reads the first value of a query parameter that may be repeated.
 */
function firstValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

/**
 * Builds a link to the inventory list, preserving the current filters.
 */
function href(params: {
  readonly stock?: string;
  readonly search?: string;
  readonly page?: number;
}): string {
  const search = new URLSearchParams();

  if (params.stock) search.set("stock", params.stock);
  if (params.search) search.set("search", params.search);
  if (params.page && params.page > 1) {
    search.set("page", String(params.page));
  }

  const query = search.toString();

  return query ? `/admin/products?${query}` : "/admin/products";
}
