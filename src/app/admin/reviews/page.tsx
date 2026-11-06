import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
} from "@/components/admin/primitives";
import { ReviewModerationTable } from "@/components/admin/reviews/ReviewModerationTable";
import {
  listAdminReviews,
  type ReviewState,
} from "@/lib/admin/reviews";
import { adminReviewQuerySchema } from "@/lib/validation/admin";

/**
 * The review moderation queue.
 *
 * ── Why the default view is PENDING ──────────────────────────────────────
 *
 * An admin opening this screen wants to know what needs a decision. The
 * pending queue is that list.
 *
 * The other two states are one click away, and their counts are always
 * on screen — so an admin can see "12 approved, 3 hidden" without
 * leaving the queue they are working in. A tab that hides its counts
 * forces a round trip to answer a question the page could have answered.
 *
 * ── Why "hide" is not "reject" ───────────────────────────────────────────
 *
 * A rejected review and a hidden review are the same thing in this
 * system, and the difference in wording is deliberate.
 *
 * A review that was approved and later withdrawn is **hidden**, not
 * rejected: it *was* published, and the audit trail records that it was
 * published and then withdrawn. Calling it "rejected" would erase the
 * fact that customers saw it — which is exactly the history the audit
 * log exists to preserve.
 */
export const metadata: Metadata = {
  title: "Reviews",
};

/**
 * The queue is session-gated, so it is rendered at request time.
 */
export const instant = false;

/**
 * The review moderation page.
 */
export default async function AdminReviewsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const raw = await searchParams;

  const query = adminReviewQuerySchema.safeParse({
    status: firstValue(raw.status),
    productId: firstValue(raw.productId),
    userId: firstValue(raw.userId),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Reviews"
          description="Approve, hide and restore customer reviews."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const result = await listAdminReviews(query.data).catch(
    (error: unknown) => {
      console.error("[admin] Review queue failed:", error);
      return null;
    },
  );

  if (!result) {
    return (
      <>
        <PageHeading
          title="Reviews"
          description="Approve, hide and restore customer reviews."
        />

        <AdminErrorState message="We could not load the moderation queue. Please try again in a moment." />
      </>
    );
  }

  const { reviews, pagination, counts } = result;

  const states: { value: ReviewState | "ALL"; label: string; count: number }[] =
    [
      { value: "PENDING", label: "Pending", count: counts.pending },
      { value: "APPROVED", label: "Published", count: counts.approved },
      { value: "HIDDEN", label: "Hidden", count: counts.hidden },
      { value: "ALL", label: "All", count: counts.all },
    ];

  return (
    <>
      <PageHeading
        title="Reviews"
        description="Approve, hide and restore customer reviews. Every decision is recorded in the audit log."
      />

      {/* ── The state filters ────────────────────────────────────────── */}
      <nav aria-label="Review state">
        <ul className="flex flex-wrap gap-2">
          {states.map((state) => {
            const isActive = query.data.status === state.value;

            return (
              <li key={state.value}>
                <Link
                  href={href({ status: state.value, page: query.data.page })}
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
                  {state.label}
                  <span
                    className={[
                      "text-xs tabular-nums",
                      isActive ? "text-neutral-300" : "text-foreground-muted",
                    ].join(" ")}
                  >
                    {state.count}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Moderation queue"
          description={`${pagination.total} review${pagination.total === 1 ? "" : "s"} in this queue.`}
        />

        {reviews.length === 0 ? (
          <AdminEmptyState
            title={
              query.data.status === "PENDING"
                ? "Nothing waiting for moderation"
                : "No reviews in this state"
            }
            description={
              query.data.status === "PENDING"
                ? "Every review has been dealt with. New submissions will appear here."
                : "Try another state above to see the rest of the queue."
            }
          />
        ) : (
          <ReviewModerationTable reviews={reviews} />
        )}
      </AdminCard>

      {pagination.totalPages > 1 ? (
        <nav aria-label="Pagination" className="mt-6 flex justify-center">
          <ul className="flex items-center gap-1.5">
            {pagination.hasPreviousPage ? (
              <li>
                <Link
                  href={href({
                    status: query.data.status,
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
                    status: query.data.status,
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
 * Builds a link to the moderation queue, preserving the current state.
 */
function href(params: {
  readonly status?: string;
  readonly page?: number;
}): string {
  const search = new URLSearchParams();

  if (params.status) search.set("status", params.status);
  if (params.page && params.page > 1) {
    search.set("page", String(params.page));
  }

  const query = search.toString();

  return query ? `/admin/reviews?${query}` : "/admin/reviews";
}
