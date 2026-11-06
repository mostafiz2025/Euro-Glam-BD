import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { BrandFormDialog } from "@/components/admin/brands/BrandFormDialog";
import { DiscoveryDeleteDialog } from "@/components/admin/discovery/DiscoveryDeleteDialog";
import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatTile,
} from "@/components/admin/primitives";
import { listAdminBrands } from "@/lib/admin/brands";
import { imageUrl } from "@/lib/format/image";
import { adminBrandQuerySchema } from "@/lib/validation/admin";

/**
 * The brand management panel.
 *
 * ── What an admin can do here ──────────────────────────────────────────────
 *
 * Add a brand, rename it, give it a logo and a monogram, order it in the
 * carousel, and remove it. Every change is written to the audit log in
 * the same transaction as the change itself.
 *
 * ── Why the monogram is still shown alongside the logo ────────────────────
 *
 * The monogram is the **fallback**, not a removed feature. A brand with
 * no uploaded logo still has to render something in the carousel, and the
 * monogram is what it renders. So the table shows both: the logo when
 * there is one, and the monogram that stands in when there is not.
 *
 * ── Why deleting a brand is safe ──────────────────────────────────────────
 *
 * `Product.brand` is a plain string, not a foreign key. Deleting a brand
 * row removes its logo and its description — the products that carry that
 * brand name keep it, and simply have no logo to show, because the
 * storefront falls back to the monogram. A brand deletion is never
 * destructive to the catalogue.
 */
export const metadata: Metadata = {
  title: "Brands",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminBrandsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const raw = await searchParams;

  const query = adminBrandQuerySchema.safeParse({
    search: firstValue(raw.search),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Brands"
          description="Manage the brands customers browse in the shop."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const result = await listAdminBrands(query.data).catch(
    (error: unknown) => {
      console.error("[admin] Brand list failed:", error);
      return null;
    },
  );

  if (!result) {
    return (
      <>
        <PageHeading
          title="Brands"
          description="Manage the brands customers browse in the shop."
        />

        <AdminErrorState message="We could not load the brands. Please try again in a moment." />
      </>
    );
  }

  const { brands, pagination } = result;

  const withLogo = brands.filter((brand) => brand.logo !== null).length;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeading
          title="Brands"
          description="Manage the brands customers browse in the shop. Every change is recorded in the audit log."
        />

        <BrandFormDialog brand={null} />
      </div>

      {/* ── The headline counts ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile
          label="All brands"
          value={pagination.total}
          hint="Every brand in the shop"
        />

        <StatTile
          label="With a logo"
          value={withLogo}
          tone="good"
          hint="The rest show their monogram"
        />
      </div>

      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Brands"
          description={`${pagination.total} brand${pagination.total === 1 ? "" : "s"} match this filter. Only upload a logo you have permission to use.`}
        />

        {brands.length === 0 ? (
          <AdminEmptyState
            title="No brands yet"
            description="Add a brand and it will appear in the shop's &quot;Shop By Brand&quot; carousel straight away."
          />
        ) : (
          <>
            {/*
              The table is a real `<table>` on desktop and a stack of
              cards on mobile — the same split the inventory list uses.
              A `<table>` reflowed with CSS still reads its headers out
              of order on a phone, so the mobile layout drops the table
              semantics entirely.
            */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-foreground-muted">
                    <th scope="col" className="px-5 py-3 font-medium">
                      Brand
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Logo
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Monogram
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Order
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-neutral-100">
                  {brands.map((brand) => (
                    <tr key={brand.id} className="align-top">
                      <td className="px-5 py-3">
                        <span className="font-medium text-foreground">
                          {brand.name}
                        </span>

                        <p className="mt-0.5 font-mono text-xs text-foreground-muted">
                          {brand.slug}
                        </p>
                      </td>

                      <td className="px-5 py-3 text-foreground-muted">
                        {brand.logo ? (
                          <span className="relative inline-block h-10 w-10 overflow-hidden rounded-xl border border-border bg-surface-muted">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={imageUrl(brand.logo)}
                              alt=""
                              className="h-full w-full object-contain"
                            />
                          </span>
                        ) : (
                          <span className="text-xs">Monogram fallback</span>
                        )}
                      </td>

                      <td className="px-5 py-3">
                        <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-brand-50 px-2 font-serif text-xs font-bold text-brand-600">
                          {brand.monogram}
                        </span>
                      </td>

                      <td className="px-5 py-3 text-right tabular-nums text-foreground-muted">
                        {brand.sortOrder}
                      </td>

                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <BrandFormDialog
                            brand={{
                              id: brand.id,
                              name: brand.name,
                              slug: brand.slug,
                              monogram: brand.monogram,
                              logo: brand.logo,
                              description: brand.description,
                              sortOrder: brand.sortOrder,
                            }}
                          />

                          <DiscoveryDeleteDialog
                            entity="brand"
                            id={brand.id}
                            name={brand.name}
                            endpoint="/api/admin/brands"
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── The mobile layout ──────────────────────────────────── */}
            <ul className="divide-y divide-neutral-100 md:hidden">
              {brands.map((brand) => (
                <li key={brand.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {brand.name}
                      </p>

                      <p className="mt-0.5 font-mono text-xs text-foreground-muted">
                        {brand.slug}
                      </p>
                    </div>

                    <span className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 px-2 font-serif text-xs font-bold text-brand-600">
                      {brand.monogram}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <BrandFormDialog
                      brand={{
                        id: brand.id,
                        name: brand.name,
                        slug: brand.slug,
                        monogram: brand.monogram,
                        logo: brand.logo,
                        description: brand.description,
                        sortOrder: brand.sortOrder,
                      }}
                    />

                    <DiscoveryDeleteDialog
                      entity="brand"
                      id={brand.id}
                      name={brand.name}
                      endpoint="/api/admin/brands"
                    />
                  </div>
                </li>
              ))}
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
 * Builds a link to the brand list, preserving the current filters.
 */
function href(params: {
  readonly search?: string;
  readonly page?: number;
}): string {
  const search = new URLSearchParams();

  if (params.search) search.set("search", params.search);
  if (params.page && params.page > 1) {
    search.set("page", String(params.page));
  }

  const query = search.toString();

  return query ? `/admin/brands?${query}` : "/admin/brands";
}
