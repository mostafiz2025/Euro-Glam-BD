import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { DiscoveryDeleteDialog } from "@/components/admin/discovery/DiscoveryDeleteDialog";
import { HeroBannerFormDialog } from "@/components/admin/hero-banners/HeroBannerFormDialog";
import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatTile,
} from "@/components/admin/primitives";
import { listAdminHeroBanners } from "@/lib/admin/hero-banners";
import { imageUrl } from "@/lib/format/image";
import { adminHeroBannerQuerySchema } from "@/lib/validation/admin";

/**
 * The hero-banner management panel.
 *
 * ── What an admin can do here ──────────────────────────────────────────────
 *
 * Add a banner, rewrite its copy, give it artwork, switch it off, and
 * remove it. Every change is written to the audit log in the same
 * transaction as the change itself.
 *
 * ── Why the banner is switched off rather than deleted ────────────────────
 *
 * A campaign ends; it is not erased. Deleting a banner removes the row
 * *and* its artwork, and the audit trail is left describing a record
 * that no longer exists. Switching it off keeps the row — and its
 * history — in place, and takes it out of the carousel.
 *
 * So the panel shows both, and the **Active** badge tells the two
 * apart. A banner that is switched off is still editable and still
 * auditable; it is simply not on the homepage.
 *
 * ── Why the order column matters ──────────────────────────────────────────
 *
 * The order is the carousel's order. `0` comes first, and the storefront
 * reads the same number, so what the admin sees in this table is what a
 * customer sees on the homepage — in the same sequence.
 */
export const metadata: Metadata = {
  title: "Hero Banners",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminHeroBannersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const raw = await searchParams;

  const query = adminHeroBannerQuerySchema.safeParse({
    search: firstValue(raw.search),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Hero Banners"
          description="Manage the carousel at the top of the homepage."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const result = await listAdminHeroBanners(query.data).catch(
    (error: unknown) => {
      console.error("[admin] Hero banner list failed:", error);
      return null;
    },
  );

  if (!result) {
    return (
      <>
        <PageHeading
          title="Hero Banners"
          description="Manage the carousel at the top of the homepage."
        />

        <AdminErrorState message="We could not load the banners. Please try again in a moment." />
      </>
    );
  }

  const { banners, pagination } = result;

  const activeCount = banners.filter((banner) => banner.isActive).length;
  const withArtwork = banners.filter((banner) => banner.image !== null).length;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeading
          title="Hero Banners"
          description="Manage the carousel at the top of the homepage. Every change is recorded in the audit log."
        />

        <HeroBannerFormDialog banner={null} />
      </div>

      {/* ── The headline counts ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="All banners"
          value={pagination.total}
          hint="Every banner in the shop"
        />

        <StatTile
          label="On the homepage"
          value={activeCount}
          tone="good"
          hint="The carousel shows these"
        />

        <StatTile
          label="With artwork"
          value={withArtwork}
          hint="The rest show a gradient wash"
        />
      </div>

      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Hero Banners"
          description={`${pagination.total} banner${pagination.total === 1 ? "" : "s"} match this filter. The order here is the order on the homepage.`}
        />

        {banners.length === 0 ? (
          <AdminEmptyState
            title="No banners yet"
            description="Add a banner and it appears in the homepage carousel straight away. Until you do, the homepage shows the shop's four built-in campaigns."
          />
        ) : (
          <>
            {/*
              The table is a real `<table>` on desktop and a stack of
              cards on mobile — the same split the concern list uses. A
              `<table>` reflowed with CSS still reads its headers out of
              order on a phone, so the mobile layout drops the table
              semantics entirely.
            */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-foreground-muted">
                    <th scope="col" className="px-5 py-3 font-medium">
                      Order
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Banner
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Artwork
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-neutral-100">
                  {banners.map((banner) => (
                    <tr key={banner.id} className="align-top">
                      <td className="px-5 py-3">
                        <span className="font-mono text-xs tabular-nums text-foreground-muted">
                          {banner.sortOrder}
                        </span>
                      </td>

                      <td className="px-5 py-3">
                        <span className="font-medium text-foreground">
                          {banner.title}
                        </span>

                        <p className="mt-0.5 text-xs text-foreground-muted">
                          {banner.eyebrow}
                        </p>
                      </td>

                      <td className="px-5 py-3 text-foreground-muted">
                        {banner.image ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="relative h-8 w-12 overflow-hidden rounded-lg border border-border bg-surface-muted">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={imageUrl(banner.image)}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            </span>
                            <span className="text-xs">Uploaded</span>
                          </span>
                        ) : (
                          <span className="text-xs">Gradient wash</span>
                        )}
                      </td>

                      <td className="px-5 py-3">
                        {banner.isActive ? (
                          <span className="inline-block rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
                            Active
                          </span>
                        ) : (
                          <span className="inline-block rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted ring-1 ring-border">
                            Hidden
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <HeroBannerFormDialog banner={banner} />

                          <DiscoveryDeleteDialog
                            entity="hero banner"
                            id={banner.id}
                            name={banner.title}
                            endpoint="/api/admin/hero-banners"
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
              {banners.map((banner) => (
                <li key={banner.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        {banner.title}
                      </p>

                      <p className="mt-0.5 text-xs text-foreground-muted">
                        {banner.eyebrow} · order {banner.sortOrder}
                      </p>
                    </div>

                    {banner.isActive ? (
                      <span className="inline-block shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
                        Active
                      </span>
                    ) : (
                      <span className="inline-block shrink-0 rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted ring-1 ring-border">
                        Hidden
                      </span>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <HeroBannerFormDialog banner={banner} />

                    <DiscoveryDeleteDialog
                      entity="hero banner"
                      id={banner.id}
                      name={banner.title}
                      endpoint="/api/admin/hero-banners"
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
 * Builds a link to the banner list, preserving the current filters.
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

  return query ? `/admin/hero-banners?${query}` : "/admin/hero-banners";
}
