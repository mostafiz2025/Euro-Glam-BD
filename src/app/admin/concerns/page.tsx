import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { ConcernFormDialog } from "@/components/admin/concerns/ConcernFormDialog";
import { DiscoveryDeleteDialog } from "@/components/admin/discovery/DiscoveryDeleteDialog";
import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatTile,
} from "@/components/admin/primitives";
import { listAdminConcerns } from "@/lib/admin/concerns";
import { imageUrl } from "@/lib/format/image";
import { adminConcernQuerySchema } from "@/lib/validation/admin";

/**
 * The skin-concern management panel.
 *
 * ── What an admin can do here ──────────────────────────────────────────────
 *
 * Add a concern, rename it, point it at an ingredient, give it a card
 * image, and remove it. Every change is written to the audit log in the
 * same transaction as the change itself.
 *
 * ── Why the ingredient tag matters ────────────────────────────────────────
 *
 * A concern filters on a **canonical ingredient ID** — the same list the
 * conflict engine compares. That is what makes a concern filter and a
 * conflict rule agree about what "BHA" means. A typo in the tag does not
 * fail loudly; it produces a filter that matches nothing, so the field is
 * spelled out on the row and explained on the form.
 *
 * ── Why deleting a concern is safe ────────────────────────────────────────
 *
 * A concern is a way of *featuring* an ingredient, not a link to it. The
 * products carry their ingredient tags directly, so removing a concern
 * removes the shop's way of advertising it — never the products
 * themselves.
 */
export const metadata: Metadata = {
  title: "Concerns",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminConcernsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const raw = await searchParams;

  const query = adminConcernQuerySchema.safeParse({
    search: firstValue(raw.search),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Skin Concerns"
          description="Manage the skin concerns customers browse in the shop."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const result = await listAdminConcerns(query.data).catch(
    (error: unknown) => {
      console.error("[admin] Concern list failed:", error);
      return null;
    },
  );

  if (!result) {
    return (
      <>
        <PageHeading
          title="Skin Concerns"
          description="Manage the skin concerns customers browse in the shop."
        />

        <AdminErrorState message="We could not load the concerns. Please try again in a moment." />
      </>
    );
  }

  const { concerns, pagination } = result;

  const withImage = concerns.filter((concern) => concern.image !== null).length;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeading
          title="Skin Concerns"
          description="Manage the skin concerns customers browse in the shop. Every change is recorded in the audit log."
        />

        <ConcernFormDialog concern={null} />
      </div>

      {/* ── The headline counts ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile
          label="All concerns"
          value={pagination.total}
          hint="Every concern in the shop"
        />

        <StatTile
          label="With a card image"
          value={withImage}
          tone="good"
          hint="The rest show as a plain chip"
        />
      </div>

      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Skin Concerns"
          description={`${pagination.total} concern${pagination.total === 1 ? "" : "s"} match this filter. Each one filters on a canonical ingredient ID.`}
        />

        {concerns.length === 0 ? (
          <AdminEmptyState
            title="No concerns yet"
            description="Add a skin concern and it will appear in the shop's &quot;Shop By Concern&quot; section straight away."
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
                      Concern
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Ingredient
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Related
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Image
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-neutral-100">
                  {concerns.map((concern) => (
                    <tr key={concern.id} className="align-top">
                      <td className="px-5 py-3">
                        <span className="font-medium text-foreground">
                          {concern.name}
                        </span>

                        <p className="mt-0.5 font-mono text-xs text-foreground-muted">
                          {concern.slug}
                        </p>
                      </td>

                      <td className="px-5 py-3">
                        <span className="font-mono text-xs uppercase tracking-wide text-foreground">
                          {concern.tag}
                        </span>
                      </td>

                      <td className="px-5 py-3 text-xs text-foreground-muted">
                        {concern.relatedTags.length > 0
                          ? concern.relatedTags.join(", ")
                          : "—"}
                      </td>

                      <td className="px-5 py-3 text-foreground-muted">
                        {concern.image ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="relative h-8 w-8 overflow-hidden rounded-full border border-border bg-surface-muted">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={imageUrl(concern.image)}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            </span>
                            <span className="text-xs">Uploaded</span>
                          </span>
                        ) : (
                          <span className="text-xs">Plain chip</span>
                        )}
                      </td>

                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <ConcernFormDialog
                            concern={{
                              id: concern.id,
                              name: concern.name,
                              slug: concern.slug,
                              tag: concern.tag,
                              relatedTags: concern.relatedTags,
                              image: concern.image,
                              description: concern.description,
                            }}
                          />

                          <DiscoveryDeleteDialog
                            entity="concern"
                            id={concern.id}
                            name={concern.name}
                            endpoint="/api/admin/concerns"
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
              {concerns.map((concern) => (
                <li key={concern.id} className="p-4">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">
                      {concern.name}
                    </p>

                    <p className="mt-0.5 font-mono text-xs uppercase tracking-wide text-foreground-muted">
                      {concern.tag}
                    </p>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ConcernFormDialog
                      concern={{
                        id: concern.id,
                        name: concern.name,
                        slug: concern.slug,
                        tag: concern.tag,
                        relatedTags: concern.relatedTags,
                        image: concern.image,
                        description: concern.description,
                      }}
                    />

                    <DiscoveryDeleteDialog
                      entity="concern"
                      id={concern.id}
                      name={concern.name}
                      endpoint="/api/admin/concerns"
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
 * Builds a link to the concern list, preserving the current filters.
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

  return query ? `/admin/concerns?${query}` : "/admin/concerns";
}
