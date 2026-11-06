import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { AdminOrderActionBar } from "@/components/admin/orders/AdminOrderActionBar";
import { AdminOrderTable } from "@/components/admin/orders/AdminOrderTable";
import { OrderFilterBar } from "@/components/admin/orders/OrderFilterBar";
import {
  AdminCard,
  AdminEmptyState,
  AdminErrorState,
} from "@/components/admin/primitives";
import {
  listAdminOrders,
  permittedOrderTargets,
  permittedPaymentTargets,
} from "@/lib/admin/orders";
import { adminOrderQuerySchema } from "@/lib/validation/admin";

/**
 * The order fulfilment desk.
 *
 * ── What this screen is ───────────────────────────────────────────────────
 *
 * The admin's view of every order the shop has taken. It is an
 * **enterprise data table**: one row per order, one column per fact, and
 * a set of row actions on the right.
 *
 * ── Two axes, not one ────────────────────────────────────────────────────
 *
 * An order has a **fulfilment** status and a **payment** status, and
 * they move independently. A cash-on-delivery order can be `SHIPPED`
 * while the payment is still `PENDING`, because the cash is collected on
 * delivery — that is the normal case for this shop, not an edge case.
 *
 * So the table carries both columns, and each badge says which axis it
 * belongs to. Collapsing them into a single "status" would force the
 * shop to record a payment it has not received.
 *
 * ── The filters are URL filters ──────────────────────────────────────────
 *
 * Every filter is a query parameter, and the server reads the query
 * parameters. The filter bar navigates; it does not filter. So a
 * filtered list can be reproduced by copying the URL, the back button
 * steps through the filters that were applied, and the counts on the
 * pills describe the **whole** table rather than the filtered page.
 */
export const metadata: Metadata = {
  title: "Orders",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

/**
 * The orders page.
 */
export default async function AdminOrdersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();

  const raw = await searchParams;

  const query = adminOrderQuerySchema.safeParse({
    status: firstValue(raw.status),
    paymentStatus: firstValue(raw.paymentStatus),
    paymentMethod: firstValue(raw.paymentMethod),
    sort: firstValue(raw.sort),
    userId: firstValue(raw.userId),
    search: firstValue(raw.search),
    page: firstValue(raw.page),
    limit: firstValue(raw.limit),
  });

  if (!query.success) {
    return (
      <>
        <PageHeading
          title="Orders"
          description="Move orders through the fulfilment pipeline."
        />

        <AdminErrorState message="That filter is not one we recognise." />
      </>
    );
  }

  const result = await listAdminOrders(query.data).catch((error: unknown) => {
    console.error("[admin] Order list failed:", error);
    return null;
  });

  if (!result) {
    return (
      <>
        <PageHeading
          title="Orders"
          description="Move orders through the fulfilment pipeline."
        />

        <AdminErrorState message="We could not load the orders. Please try again in a moment." />
      </>
    );
  }

  const { orders, pagination, counts } = result;

  /**
   * The fulfilment pills.
   *
   * The counts come from the server, over the whole table — so "14
   * pending" means fourteen pending orders, whether or not the current
   * filter is hiding some of them.
   */
  const statusOptions = [
    { value: "", label: "All Orders", count: counts.total },
    { value: "PENDING", label: "Pending", count: counts.byStatus.PENDING },
    {
      value: "PROCESSING",
      label: "Processing",
      count: counts.byStatus.PROCESSING,
    },
    { value: "SHIPPED", label: "Shipped", count: counts.byStatus.SHIPPED },
    {
      value: "DELIVERED",
      label: "Delivered",
      count: counts.byStatus.DELIVERED,
    },
    {
      value: "CANCELLED",
      label: "Cancelled",
      count: counts.byStatus.CANCELLED,
    },
  ];

  const paymentStatusOptions = [
    { value: "PENDING", label: "Pending", count: counts.byPaymentStatus.PENDING },
    { value: "PAID", label: "Paid", count: counts.byPaymentStatus.PAID },
    { value: "FAILED", label: "Failed", count: counts.byPaymentStatus.FAILED },
    {
      value: "REFUNDED",
      label: "Refunded",
      count: counts.byPaymentStatus.REFUNDED,
    },
  ];

  const paymentMethodOptions = [
    { value: "BKASH", label: "bKash", count: counts.byPaymentMethod.BKASH },
    { value: "NAGAD", label: "Nagad", count: counts.byPaymentMethod.NAGAD },
    { value: "CARD", label: "Card", count: counts.byPaymentMethod.CARD },
    { value: "COD", label: "Cash on Delivery", count: counts.byPaymentMethod.COD },
  ];

  /**
   * The sort orders.
   *
   * The labels say what the result *is*, not what the database does —
   * "Newest first" rather than "createdAt DESC".
   */
  const sortOptions = [
    { value: "newest", label: "Newest first" },
    { value: "oldest", label: "Oldest first" },
    { value: "highest", label: "Highest total" },
    { value: "lowest", label: "Lowest total" },
  ];

  /**
   * The rows, shaped for the table.
   *
   * The permitted moves are computed **here**, from the server's
   * transition tables, so the row actions can be disabled on a terminal
   * order without the client knowing the rules. The server still
   * enforces them.
   */
  const rows = orders.map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    totalAmountPaisa: order.totalAmountPaisa,
    itemCount: order.itemCount,
    createdAt: order.createdAt.toISOString(),
    customer: order.customer,
    permittedStatuses: permittedOrderTargets(order.status),
    permittedPaymentStatuses: permittedPaymentTargets(order.paymentStatus),
  }));

  return (
    <>
      <PageHeading
        title="Orders"
        description="Move orders through the fulfilment pipeline. Every change is recorded in the audit log."
      />

      {/*
        The action bar.

        It reads the URL with `useSearchParams`, so it sits behind a
        `<Suspense>` boundary — a client component that reads search
        params opts its whole subtree out of static rendering.
      */}
      <Suspense fallback={<ActionBarSkeleton />}>
        <AdminOrderActionBar
          paymentStatusOptions={paymentStatusOptions}
          paymentMethodOptions={paymentMethodOptions}
          sortOptions={sortOptions}
          matchingCount={pagination.total}
          totalCount={counts.total}
        />
      </Suspense>

      {/*
        The status pills.

        They are their own block rather than part of the action bar,
        because they are the **primary** way the admin navigates the
        desk — six of them, each with a live count, and they need the
        full width to breathe.
      */}
      <Suspense fallback={<PillBarSkeleton />}>
        <OrderFilterBar
          statusOptions={statusOptions}
          paymentStatusOptions={paymentStatusOptions}
          paymentMethodOptions={paymentMethodOptions}
        />
      </Suspense>

      <AdminCard className="mt-4">
        {orders.length === 0 ? (
          <AdminEmptyState
            title="No orders in this view"
            description="Nothing matches this filter right now. Try another status above."
            action={
              <Link
                href="/admin/orders"
                className="inline-flex h-9 items-center rounded-full border border-border bg-surface px-4 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                Clear the filters
              </Link>
            }
          />
        ) : (
          <AdminOrderTable orders={rows} />
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
                    paymentStatus: query.data.paymentStatus,
                    paymentMethod: query.data.paymentMethod,
                    sort: query.data.sort,
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
                    status: query.data.status,
                    paymentStatus: query.data.paymentStatus,
                    paymentMethod: query.data.paymentMethod,
                    sort: query.data.sort,
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
 * The placeholder shown while the action bar resolves.
 *
 * The same height as the real bar, so the table below does not jump
 * when the bar arrives.
 */
function ActionBarSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="h-10 w-full animate-pulse rounded-full bg-surface-muted xl:max-w-sm" />

        <div className="flex flex-wrap items-center gap-2">
          <div className="h-9 w-32 animate-pulse rounded-full bg-surface-muted" />
          <div className="h-9 w-32 animate-pulse rounded-full bg-surface-muted" />
          <div className="h-9 w-28 animate-pulse rounded-full bg-surface-muted" />
          <div className="h-9 w-24 animate-pulse rounded-full bg-surface-muted" />
          <div className="h-9 w-36 animate-pulse rounded-full bg-neutral-900/10" />
        </div>
      </div>
    </div>
  );
}

/**
 * The placeholder shown while the status pills resolve.
 */
function PillBarSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="mt-4 rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5"
    >
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="h-9 w-24 animate-pulse rounded-full bg-surface-muted"
          />
        ))}
      </div>
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
 * Builds a link to the order list, preserving the current filters.
 */
function href(params: {
  readonly status?: string;
  readonly paymentStatus?: string;
  readonly paymentMethod?: string;
  readonly sort?: string;
  readonly search?: string;
  readonly page?: number;
}): string {
  const search = new URLSearchParams();

  if (params.status) search.set("status", params.status);
  if (params.paymentStatus) search.set("paymentStatus", params.paymentStatus);
  if (params.paymentMethod) search.set("paymentMethod", params.paymentMethod);
  if (params.sort) search.set("sort", params.sort);
  if (params.search) search.set("search", params.search);
  if (params.page && params.page > 1) {
    search.set("page", String(params.page));
  }

  const query = search.toString();

  return query ? `/admin/orders?${query}` : "/admin/orders";
}
