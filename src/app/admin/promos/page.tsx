import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { CouponFormDialog } from "@/components/admin/promos/CouponFormDialog";
import { DeactivateCouponDialog } from "@/components/admin/promos/DeactivateCouponDialog";
import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatTile,
  StatusBadge,
} from "@/components/admin/primitives";
import { couponStatus, listAdminCoupons } from "@/lib/admin/coupons";
import { formatPaisa } from "@/lib/format/money";
import { adminCouponQuerySchema } from "@/lib/validation/admin";

/**
 * The promo & coupon management panel.
 *
 * ── What an admin can do here ──────────────────────────────────────────────
 *
 * Create a discount code, change what it is worth, extend its life, and
 * switch it off. That is the whole surface, and it is deliberately
 * narrow: a coupon is a **commercial decision with a monetary value**,
 * so every change to its terms requires a reason and is written to the
 * audit log in the same transaction as the change.
 *
 * ── Why the status is derived, not stored ─────────────────────────────────
 *
 * A coupon can be unusable for three different reasons, and an admin
 * looking at the panel needs to tell them apart:
 *
 *   • **Inactive** — an admin switched it off.
 *   • **Expired** — the clock ran out.
 *   • **Exhausted** — the usage limit was reached.
 *
 * Only the first is a stored column. The other two are *facts about the
 * current time*, so storing them would mean a nightly job updating
 * rows that are already correct by derivation. The status is computed on
 * read, by `couponStatus` — the same function the API uses, so the badge
 * on the page and the decision at checkout can never disagree.
 *
 * ── Why a coupon is deactivated, never deleted ─────────────────────────────
 *
 * A coupon that has been redeemed has history. Deleting the row would
 * erase the record of the campaign, and the orders that used it would
 * point at a code that no longer exists. So the ordinary path is "switch
 * it off" — the row stays and the redemption count is preserved.
 */
export const metadata: Metadata = {
  title: "Promos",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminPromosPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const raw = await searchParams;

  const query = adminCouponQuerySchema.safeParse({
    search: firstValue(raw.search),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Promos"
          description="Create and track the discount codes customers use at checkout."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const result = await listAdminCoupons(query.data).catch(
    (error: unknown) => {
      console.error("[admin] Coupon list failed:", error);
      return null;
    },
  );

  if (!result) {
    return (
      <>
        <PageHeading
          title="Promos"
          description="Create and track the discount codes customers use at checkout."
        />

        <AdminErrorState message="We could not load the coupons. Please try again in a moment." />
      </>
    );
  }

  const { coupons, pagination, counts } = result;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeading
          title="Promos"
          description="Create and track the discount codes customers use at checkout. Every change is recorded in the audit log."
        />

        <CouponFormDialog coupon={null} />
      </div>

      {/* ── The headline counts ───────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="All coupons"
          value={counts.total}
          hint="Every code ever created"
        />

        <StatTile
          label="Switched on"
          value={counts.active}
          tone="good"
          hint="Live and redeemable at checkout"
        />

        <StatTile
          label="Expired"
          value={counts.expired}
          tone="warn"
          hint="The clock ran out"
        />

        <StatTile
          label="Exhausted"
          value={counts.exhausted}
          tone="warn"
          hint="The usage limit was reached"
        />
      </div>

      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Coupons"
          description={`${pagination.total} coupon${pagination.total === 1 ? "" : "s"} match this filter. A change to what a coupon is worth needs a reason.`}
        />

        {coupons.length === 0 ? (
          <AdminEmptyState
            title="No coupons yet"
            description="Add a discount code and it will start working at checkout straight away."
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
                      Code
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Discount
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Expires
                    </th>
                    <th scope="col" className="px-5 py-3 text-right font-medium">
                      Used
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
                  {coupons.map((coupon) => {
                    const status = couponStatus(coupon);

                    return (
                      <tr key={coupon.id} className="align-top">
                        <td className="px-5 py-3">
                          <span className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
                            {coupon.code}
                          </span>

                          {coupon.description ? (
                            <p className="mt-0.5 max-w-xs truncate text-xs text-foreground-muted">
                              {coupon.description}
                            </p>
                          ) : null}
                        </td>

                        <td className="px-5 py-3 text-foreground-muted">
                          {coupon.discountType === "PERCENTAGE"
                            ? `${coupon.percentOff}% off`
                            : `${formatPaisa(coupon.amountOffPaisa ?? 0)} off`}
                        </td>

                        <td className="px-5 py-3 text-foreground-muted">
                          <span className="tabular-nums">
                            {formatDate(coupon.expiresAt)}
                          </span>
                        </td>

                        <td className="px-5 py-3 text-right tabular-nums text-foreground-muted">
                          {coupon.usageCount}
                          {coupon.usageLimit !== null
                            ? ` / ${coupon.usageLimit}`
                            : ""}
                        </td>

                        <td className="px-5 py-3">
                          <StatusBadge
                            status={status}
                            label={COUPON_STATUS_LABELS[status]}
                          />
                        </td>

                        <td className="px-5 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <CouponFormDialog
                              coupon={{
                                id: coupon.id,
                                code: coupon.code,
                                description: coupon.description,
                                discountType: coupon.discountType,
                                percentOff: coupon.percentOff,
                                amountOffPaisa: coupon.amountOffPaisa,
                                expiresAt: coupon.expiresAt,
                                usageLimit: coupon.usageLimit,
                              }}
                            />

                            <DeactivateCouponDialog
                              couponId={coupon.id}
                              couponCode={coupon.code}
                              isActive={coupon.isActive}
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
              {coupons.map((coupon) => {
                const status = couponStatus(coupon);

                return (
                  <li key={coupon.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-semibold uppercase tracking-wide text-foreground">
                          {coupon.code}
                        </p>

                        <p className="mt-0.5 text-xs text-foreground-muted">
                          {coupon.discountType === "PERCENTAGE"
                            ? `${coupon.percentOff}% off`
                            : `${formatPaisa(coupon.amountOffPaisa ?? 0)} off`}{" "}
                          · expires {formatDate(coupon.expiresAt)}
                        </p>
                      </div>

                      <div className="shrink-0">
                        <StatusBadge
                          status={status}
                          label={COUPON_STATUS_LABELS[status]}
                        />
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <CouponFormDialog
                        coupon={{
                          id: coupon.id,
                          code: coupon.code,
                          description: coupon.description,
                          discountType: coupon.discountType,
                          percentOff: coupon.percentOff,
                          amountOffPaisa: coupon.amountOffPaisa,
                          expiresAt: coupon.expiresAt,
                          usageLimit: coupon.usageLimit,
                        }}
                      />

                      <DeactivateCouponDialog
                        couponId={coupon.id}
                        couponCode={coupon.code}
                        isActive={coupon.isActive}
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
 * The badge labels.
 *
 * The status strings are the ones `StatusBadge` already knows how to
 * colour. `EXHAUSTED` is not one of them, so it falls back to the
 * neutral badge — and the label below carries the meaning.
 */
const COUPON_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Live",
  INACTIVE: "Switched off",
  EXPIRED: "Expired",
  EXHAUSTED: "Used up",
};

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
 * Formats a date for the table.
 *
 * The `en-GB` shape — day first, month second — because this is a
 * Bangladeshi shop and the audience reads dates that way. The
 * `en-US` default would put the month first and make "03/04" ambiguous.
 */
function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
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
 * Builds a link to the coupon list, preserving the current filters.
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

  return query ? `/admin/promos?${query}` : "/admin/promos";
}
