import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import {
  FulfilmentActions,
  PaymentActions,
} from "@/components/admin/order-status-actions";
import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatusBadge,
} from "@/components/admin/primitives";
import { getAdminOrder, permittedOrderTargets, permittedPaymentTargets } from "@/lib/admin/orders";
import { formatPaisa } from "@/lib/format/money";
import { paymentMethodLabel } from "@/lib/format/payment";

/**
 * One order, in full.
 *
 * ── Why this page exists ──────────────────────────────────────────────────
 *
 * The orders table is a **scan**. It answers "which orders need me?" in
 * one glance, and it does that by keeping each order to a single row.
 *
 * But a row cannot hold an order. It cannot hold the items, the
 * shipping address, the transfer reference, or the audit trail. So the
 * table's row actions point here, where there is room for the whole
 * order and the controls that move it.
 *
 * ── What the page shows ───────────────────────────────────────────────────
 *
 * The order's identity, its customer, its money, its items, its
 * shipping address, and the two action toolbars — fulfilment and
 * payment, on their own axes.
 */
export const metadata: Metadata = {
  title: "Order",
};

/**
 * The screen is session-gated, so it is rendered at request time.
 */
export const instant = false;

/**
 * The order detail page.
 */
export default async function AdminOrderDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  await connection();

  const { id } = await params;

  const order = await getAdminOrder(id).catch((error: unknown) => {
    console.error("[admin] Order detail failed:", error);
    return null;
  });

  if (!order) {
    return (
      <>
        <PageHeading
          title="Order"
          description="The order could not be loaded."
          backHref="/admin/orders"
        />

        <AdminErrorState message="We could not load that order. Please try again in a moment." />
      </>
    );
  }

  const permittedStatuses = permittedOrderTargets(order.status);
  const permittedPaymentStatuses = permittedPaymentTargets(order.paymentStatus);

  const address = readShippingAddress(order.shippingAddress);

  return (
    <>
      <PageHeading
        title={order.orderNumber}
        description={`Placed ${formatDate(order.createdAt)} · ${order.customer.name}`}
        backHref="/admin/orders"
      />

      <div className="grid gap-4 lg:grid-cols-3">
        {/*
          The items and the money.

          Two columns on a wide screen: the items take the room, the
          totals take the sidebar.
        */}
        <AdminCard className="lg:col-span-2">
          <AdminCardHeader
            title="Items"
            description={`${order.itemCount} line${order.itemCount === 1 ? "" : "s"}`}
            action={
              <span className="text-sm font-bold tabular-nums text-foreground">
                {formatPaisa(order.totalAmountPaisa)}
              </span>
            }
          />

          {order.items.length === 0 ? (
            <AdminEmptyState
              title="No items on this order"
              description="This order has no line items recorded."
            />
          ) : (
            <ul className="divide-y divide-border">
              {order.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-4 px-5 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.productName}
                    </p>

                    <p className="mt-0.5 text-xs tabular-nums text-foreground-muted">
                      {formatPaisa(item.pricePaisa)} × {item.quantity}
                    </p>
                  </div>

                  <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {formatPaisa(item.pricePaisa * item.quantity)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {/*
            The totals.

            Each line is labelled and right-aligned, and the grand
            total is the only line in bold — so the eye lands on the
            number that matters.
          */}
          <dl className="space-y-1.5 border-t border-border px-5 py-4 text-sm">
            <TotalRow
              label="Subtotal"
              value={formatPaisa(order.subtotalPaisa)}
            />

            <TotalRow
              label="Shipping"
              value={formatPaisa(order.shippingAmountPaisa)}
            />

            {/*
              The discount rows.

              The coupon is shown **separately** from the free-delivery
              discount, because they are different facts. The admin's
              question about an order is usually "which campaign did
              this come from?" — and one anonymous "Discount" line
              cannot answer it.

              The coupon's line carries the code, so a campaign's
              redemptions can be traced back to it without opening the
              database.
            */}
            {order.couponDiscountPaisa > 0 ? (
              <TotalRow
                label={
                  order.couponCode ? `Discount (${order.couponCode})` : "Discount"
                }
                value={`−${formatPaisa(order.couponDiscountPaisa)}`}
                tone="good"
              />
            ) : null}

            {order.couponDiscountPaisa === 0 && order.discountAmountPaisa > 0 ? (
              <TotalRow
                label="Free delivery"
                value={`−${formatPaisa(order.discountAmountPaisa)}`}
                tone="good"
              />
            ) : null}

            <div className="flex items-center justify-between border-t border-border pt-2">
              <dt className="font-semibold text-foreground">Total</dt>

              <dd className="text-base font-bold tabular-nums text-foreground">
                {formatPaisa(order.totalAmountPaisa)}
              </dd>
            </div>
          </dl>
        </AdminCard>

        {/*
          The sidebar.

          The order's status, its customer, its address and the two
          action toolbars.
        */}
        <div className="space-y-4">
          <AdminCard>
            <AdminCardHeader title="Status" />

            <div className="space-y-4 px-5 py-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted">
                  Fulfilment
                </p>

                <div className="mt-1.5">
                  <StatusBadge status={order.status} />
                </div>
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted">
                  Payment
                </p>

                <div className="mt-1.5">
                  <StatusBadge status={order.paymentStatus} />
                </div>
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted">
                  Method
                </p>

                <p className="mt-1.5 text-sm text-foreground">
                  {paymentMethodLabel(order.paymentMethod)}
                </p>
              </div>

              {order.paymentTransactionId ? (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted">
                    TrxID
                  </p>

                  <p className="mt-1.5 break-all text-sm tabular-nums text-foreground">
                    {order.paymentTransactionId}
                  </p>

                  {order.paymentSenderNumber ? (
                    <p className="mt-0.5 text-xs tabular-nums text-foreground-muted">
                      Sent from {order.paymentSenderNumber}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </AdminCard>

          <AdminCard>
            <AdminCardHeader title="Customer" />

            <div className="space-y-1 px-5 py-4 text-sm">
              <p className="font-semibold text-foreground">
                {order.customer.name}
              </p>

              <p className="break-all text-xs text-foreground-muted">
                {order.customer.email}
              </p>

              {order.customer.phone ? (
                <p className="text-xs tabular-nums text-foreground-muted">
                  {order.customer.phone}
                </p>
              ) : null}
            </div>
          </AdminCard>

          <AdminCard>
            <AdminCardHeader title="Delivery address" />

            <address className="space-y-0.5 px-5 py-4 text-sm not-italic text-foreground">
              <p className="font-semibold">{address.fullName}</p>
              <p className="text-foreground-muted">{address.addressLine1}</p>

              {address.addressLine2 ? (
                <p className="text-foreground-muted">{address.addressLine2}</p>
              ) : null}

              <p className="text-foreground-muted">
                {address.city}, {address.district} {address.postalCode}
              </p>

              {address.phone ? (
                <p className="mt-1 tabular-nums text-foreground-muted">
                  {address.phone}
                </p>
              ) : null}

              {address.notes ? (
                <p className="mt-2 rounded-xl bg-surface-muted px-3 py-2 text-xs text-foreground-muted">
                  {address.notes}
                </p>
              ) : null}
            </address>
          </AdminCard>
        </div>
      </div>

      {/*
        The action toolbars.

        Two axes, two toolbars. They are full-width and below the fold of
        the summary, because moving an order is a deliberate act and the
        buttons should not sit directly under the customer's name.
      */}
      <AdminCard className="mt-4">
        <AdminCardHeader
          title="Move this order"
          description="Every change is recorded in the audit log."
        />

        <div className="grid gap-5 px-5 py-4 sm:grid-cols-2">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted">
              Fulfilment
            </p>

            <div className="mt-2">
              <FulfilmentActions
                orderId={order.id}
                status={order.status}
                permittedStatuses={permittedStatuses}
              />
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted">
              Payment
            </p>

            <div className="mt-2">
              <PaymentActions
                orderId={order.id}
                permittedPaymentStatuses={permittedPaymentStatuses}
              />
            </div>
          </div>
        </div>
      </AdminCard>
    </>
  );
}

/**
 * The page heading, with a way back.
 */
function PageHeading({
  title,
  description,
  backHref,
}: {
  readonly title: string;
  readonly description: string;
  readonly backHref: string;
}) {
  return (
    <div className="mb-6">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-xs font-medium text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      >
        ← Back to orders
      </Link>

      <h1 className="mt-2 font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>

      <p className="mt-1.5 text-sm text-foreground-muted">{description}</p>
    </div>
  );
}

/**
 * One line of the totals block.
 */
function TotalRow({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "good";
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-foreground-muted">{label}</dt>

      <dd
        className={[
          "tabular-nums",
          tone === "good" ? "text-emerald-600" : "text-foreground",
        ].join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The shipping address, read defensively.
 *
 * The column is an untyped `Json`, so its shape is only known at
 * runtime. Every field is checked, and a missing one renders as
 * nothing rather than as the word "undefined" — a broken address must
 * not take the page down.
 */
function readShippingAddress(value: unknown): {
  fullName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  district: string;
  postalCode: string;
  phone: string | null;
  notes: string | null;
} {
  const raw = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;

  function text(key: string): string | null {
    const field = raw[key];

    return typeof field === "string" && field.trim() ? field : null;
  }

  return {
    fullName: text("fullName") ?? "Unknown recipient",
    addressLine1: text("addressLine1") ?? "",
    addressLine2: text("addressLine2"),
    city: text("city") ?? "",
    district: text("district") ?? "",
    postalCode: text("postalCode") ?? "",
    phone: text("phone"),
    notes: text("notes"),
  };
}

/**
 * Formats a date.
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-BD", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}
