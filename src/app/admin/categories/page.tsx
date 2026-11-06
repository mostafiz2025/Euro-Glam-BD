import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { CategoryFormDialog } from "@/components/admin/categories/CategoryFormDialog";
import { DiscoveryDeleteDialog } from "@/components/admin/discovery/DiscoveryDeleteDialog";
import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatTile,
} from "@/components/admin/primitives";
import { listAdminCategories } from "@/lib/admin/categories";
import { imageUrl } from "@/lib/format/image";
import { adminCategoryQuerySchema } from "@/lib/validation/admin";

/**
 * The category management panel.
 *
 * ── What an admin can do here ──────────────────────────────────────────────
 *
 * Add a category, rename it, give it a card image, and remove it. Every
 * change is written to the audit log in the same transaction as the change
 * itself — a category whose picture was swapped with no record of who
 * swapped it is a storefront surface nobody can account for.
 *
 * ── Why a category with products cannot be deleted ─────────────────────────
 *
 * `Product.categoryId` is `onDelete: Restrict`, so the database refuses
 * the delete anyway. But a bare constraint violation is not an
 * explanation. So the list shows the product count, the delete button
 * says *why* it is unavailable, and the service reports the count if the
 * admin gets there anyway.
 *
 * ── Why the image is optional ──────────────────────────────────────────────
 *
 * A category with no image renders its SVG icon, keyed by slug. The icon
 * table **decorates** the catalogue; it never gates it — and an uploaded
 * image is the same kind of enhancement, only better. So a category the
 * admin has not yet decorated still renders.
 */
export const metadata: Metadata = {
  title: "Categories",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminCategoriesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const raw = await searchParams;

  const query = adminCategoryQuerySchema.safeParse({
    search: firstValue(raw.search),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Categories"
          description="Manage the categories customers browse in the shop."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const result = await listAdminCategories(query.data).catch(
    (error: unknown) => {
      console.error("[admin] Category list failed:", error);
      return null;
    },
  );

  if (!result) {
    return (
      <>
        <PageHeading
          title="Categories"
          description="Manage the categories customers browse in the shop."
        />

        <AdminErrorState message="We could not load the categories. Please try again in a moment." />
      </>
    );
  }

  const { categories, pagination } = result;

  const withImage = categories.filter((category) => category.image !== null).length;

  const withProducts = categories.filter(
    (category) => category.productCount > 0,
  ).length;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeading
          title="Categories"
          description="Manage the categories customers browse in the shop. Every change is recorded in the audit log."
        />

        <CategoryFormDialog category={null} />
      </div>

      {/* ── The headline counts ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatTile
          label="All categories"
          value={pagination.total}
          hint="Every category in the shop"
        />

        <StatTile
          label="With a card image"
          value={withImage}
          tone="good"
          hint="The rest show their icon instead"
        />

        <StatTile
          label="Holding products"
          value={withProducts}
          tone="warn"
          hint="These cannot be deleted yet"
        />
      </div>

      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Categories"
          description={`${pagination.total} categor${pagination.total === 1 ? "y" : "ies"} match this filter. A category that still holds products cannot be deleted.`}
        />

        {categories.length === 0 ? (
          <AdminEmptyState
            title="No categories yet"
            description="Add a category and it will appear in the shop's &quot;Shop By Category&quot; row straight away."
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
                      Category
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Slug
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Image
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Products
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-neutral-100">
                  {categories.map((category) => (
                    <tr key={category.id} className="align-top">
                      <td className="px-5 py-3">
                        <span className="font-medium text-foreground">
                          {category.name}
                        </span>
                      </td>

                      <td className="px-5 py-3 font-mono text-xs text-foreground-muted">
                        {category.slug}
                      </td>

                      <td className="px-5 py-3 text-foreground-muted">
                        {category.image ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="relative h-8 w-8 overflow-hidden rounded-full border border-border bg-surface-muted">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={imageUrl(category.image)}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            </span>
                            <span className="text-xs">Uploaded</span>
                          </span>
                        ) : (
                          <span className="text-xs">Icon fallback</span>
                        )}
                      </td>

                      <td className="px-5 py-3 text-right tabular-nums text-foreground-muted">
                        {category.productCount}
                      </td>

                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <CategoryFormDialog
                            category={{
                              id: category.id,
                              name: category.name,
                              slug: category.slug,
                              image: category.image,
                            }}
                          />

                          <DiscoveryDeleteDialog
                            entity="category"
                            id={category.id}
                            name={category.name}
                            endpoint="/api/admin/categories"
                            blockedReason={
                              category.productCount > 0
                                ? `This category still has ${category.productCount} product${category.productCount === 1 ? "" : "s"} in it. Move them to another category first.`
                                : undefined
                            }
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
              {categories.map((category) => (
                <li key={category.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {category.name}
                      </p>

                      <p className="mt-0.5 font-mono text-xs text-foreground-muted">
                        {category.slug}
                      </p>
                    </div>

                    <span className="shrink-0 text-xs tabular-nums text-foreground-muted">
                      {category.productCount} product
                      {category.productCount === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <CategoryFormDialog
                      category={{
                        id: category.id,
                        name: category.name,
                        slug: category.slug,
                        image: category.image,
                      }}
                    />

                    <DiscoveryDeleteDialog
                      entity="category"
                      id={category.id}
                      name={category.name}
                      endpoint="/api/admin/categories"
                      blockedReason={
                        category.productCount > 0
                          ? `This category still has ${category.productCount} product${category.productCount === 1 ? "" : "s"} in it. Move them to another category first.`
                          : undefined
                      }
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
 * Builds a link to the category list, preserving the current filters.
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

  return query ? `/admin/categories?${query}` : "/admin/categories";
}
