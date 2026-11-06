"use client";

import Link from "next/link";

import {
  CreditCardIcon,
  EyeIcon,
  MobileIcon,
  PencilIcon,
  TrashIcon,
  WalletIcon,
} from "@/components/ui/icons";

import { formatPaisa } from "@/lib/format/money";
import { paymentMethodLabel } from "@/lib/format/payment";

/**
 * The admin order table.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * The order fulfilment desk, as an **enterprise data table**. One row per
 * order, one column per fact, and a set of row actions on the right.
 *
 * ── Why a table, and not cards ─────────────────────────────────────────────
 *
 * This is a *list of records*, not a set of individual things to read.
 * The admin's question is comparative — "which orders are pending?" "which
 * bKash transfers have not been confirmed?" "what did this week bring in?"
 * — and comparative questions are answered by a table, because a table
 * aligns the same fact in the same column on every row.
 *
 * The card layout that came before it gave each order room to breathe,
 * which was right for reading one order. But it made twenty orders into
 * twenty blocks of prose, and the admin could not scan the status column
 * or spot the three pending orders without reading every card.
 *
 * So: the table carries the **scan**, and the order's own page carries
 * the **detail**.
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. Two axes, and they are labelled.**
 *
 * Fulfilment and payment move independently — a cash-on-delivery order
 * can be `SHIPPED` while the payment is still `PENDING`. Both columns
 * are present, and each badge says which axis it belongs to.
 *
 * **2. The badges are dot-and-word, not colour alone.**
 *
 * A coloured pill on its own is a badge that fails for a colourblind
 * admin and a screen reader alike. So each badge carries a **dot** in the
 * same hue plus the word. The colour is a second signal, never the only
 * one.
 *
 * **3. The amount is right-aligned and tabular.**
 *
 * Every currency column in every tool the admin has ever used is
 * right-aligned with tabular figures, because that is what makes the
 * digits line up so the eye can compare magnitudes at a glance. This
 * table follows the same rule.
 *
 * **4. The row actions are icons, revealed on hover.**
 *
 * Three actions per row — view, quick status update, cancel. They are
 * icon buttons rather than text buttons because twenty rows of three
 * text buttons is a wall of text, and because an icon takes a fraction
 * of the width.
 *
 * They are **always in the DOM** (so they are reachable by keyboard and
 * announced by a screen reader) but **faded until the row is hovered or
 * focused within**. A row's actions are always in the same place, so
 * the muscle memory holds; they simply do not compete with the data
 * until the admin is actually looking at that row.
 *
 * **5. The actions on a terminal order are disabled, not hidden.**
 *
 * A `DELIVERED` order has no further moves. The buttons are still
 * there, and still greyed out, so the row does not change shape when it
 * moves to a terminal state — and so an admin can see *why* nothing can
 * be done rather than wondering whether the controls failed to load.
 */

/**
 * The props for the table.
 */
export type AdminOrderTableProps = {
  readonly orders: readonly AdminOrderTableRow[];
};

/**
 * One order, as the table renders it.
 */
export type AdminOrderTableRow = {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly paymentMethod: string;
  readonly totalAmountPaisa: number;
  readonly itemCount: number;
  readonly createdAt: string;
  readonly customer: {
    readonly name: string;
    readonly email: string;
    readonly phone: string | null;
  };
  /** The legal fulfilment moves, from the server's transition table. */
  readonly permittedStatuses: readonly string[];
  /** The legal payment moves, from the server's transition table. */
  readonly permittedPaymentStatuses: readonly string[];
};

/**
 * The fulfilment badge's colour, by status.
 */
const FULFILMENT_TONES: Record<string, string> = {
  PENDING: "bg-amber-500",
  PROCESSING: "bg-blue-500",
  SHIPPED: "bg-violet-500",
  DELIVERED: "bg-emerald-500",
  CANCELLED: "bg-neutral-400",
};

/**
 * The payment badge's colour, by status.
 */
const PAYMENT_TONES: Record<string, string> = {
  PENDING: "bg-amber-500",
  PAID: "bg-emerald-500",
  FAILED: "bg-red-500",
  REFUNDED: "bg-neutral-400",
};

/**
 * The order table.
 */
export function AdminOrderTable({ orders }: AdminOrderTableProps) {
  return (
    /*
     * The table wrapper.
     *
     * `overflow-x-auto` is what makes the table scroll sideways on a
     * narrow screen instead of forcing the whole page to scroll — the
     * page keeps its layout, and only the table moves.
     */
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] border-collapse text-left">
        {/*
          The header.

          `scope="col"` is what makes a screen reader announce the column
          name when the admin navigates cell by cell — the difference
          between "৳2,400" and "Total, ৳2,400".
        */}
        <thead>
          <tr className="border-b border-border bg-surface-muted/60">
            <Th className="pl-5">Order ID</Th>
            <Th>Customer</Th>
            <Th>Date / Time</Th>
            <Th>Payment Method</Th>
            <Th>Payment Status</Th>
            <Th>Fulfilment</Th>
            <Th className="text-center">Items</Th>
            <Th className="pr-5 text-right">Total</Th>
            <Th className="w-px pr-5">
              <span className="sr-only">Row actions</span>
            </Th>
          </tr>
        </thead>

        <tbody>
          {orders.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A header cell.
 */
function Th({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <th
      scope="col"
      className={[
        "px-3 py-3 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </th>
  );
}

/**
 * One order row.
 */
function OrderRow({ order }: { readonly order: AdminOrderTableRow }) {
  const isTerminal =
    order.status === "DELIVERED" ||
    order.status === "CANCELLED" ||
    order.permittedStatuses.length === 0;

  const canCancel =
    order.status === "PENDING" || order.status === "PROCESSING";

  return (
    <tr className="group border-b border-border last:border-b-0 transition-colors duration-200 hover:bg-surface-muted/40 focus-within:bg-surface-muted/40">
      {/*
        The order id.

        A link, and the row's primary target. It is the one thing an
        admin copies into a search, so it is bold and monospaced-ish in
        weight — but the monospace would be a lie, since the number is
        generated text, not code.
      */}
      <td className="whitespace-nowrap px-3 py-3 pl-5 align-middle">
        <Link
          href={`/admin/orders/${order.id}`}
          className="rounded text-xs font-bold text-foreground underline-offset-4 transition-colors hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          {order.orderNumber}
        </Link>

        <p className="mt-0.5 text-[11px] text-foreground-muted">
          {order.customer.email}
        </p>
      </td>

      {/*
        The customer.

        An avatar built from the **name**, not an uploaded image: a
        shop's customers do not all have profile photos, and a broken
        image next to every name would be worse than a monogram. The
        monogram is the initial, on a tinted disc.
      */}
      <td className="px-3 py-3 align-middle">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[11px] font-bold text-brand-800"
          >
            {initialOf(order.customer.name)}
          </span>

          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">
              {order.customer.name}
            </p>

            {order.customer.phone ? (
              <p className="truncate text-[11px] tabular-nums text-foreground-muted">
                {order.customer.phone}
              </p>
            ) : null}
          </div>
        </div>
      </td>

      {/*
        The date.

        The absolute date, because an admin reading a table wants to
        know *when*, not "3 days ago" — "3 days ago" is relative to
        whenever they happen to be reading it.
      */}
      <td className="whitespace-nowrap px-3 py-3 align-middle">
        <p className="text-xs text-foreground">{formatDate(order.createdAt)}</p>

        <p className="mt-0.5 text-[11px] tabular-nums text-foreground-muted">
          {formatTime(order.createdAt)}
        </p>
      </td>

      {/*
        The payment method.

        The icon the customer tapped at checkout, so the method is
        recognisable without reading it.
      */}
      <td className="whitespace-nowrap px-3 py-3 align-middle">
        <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
          <MethodIcon method={order.paymentMethod} />
          {paymentMethodLabel(order.paymentMethod)}
        </span>
      </td>

      <td className="whitespace-nowrap px-3 py-3 align-middle">
        <StatusPill
          axis="Payment"
          status={order.paymentStatus}
          tone={PAYMENT_TONES[order.paymentStatus] ?? "bg-neutral-400"}
        />
      </td>

      <td className="whitespace-nowrap px-3 py-3 align-middle">
        <StatusPill
          axis="Fulfilment"
          status={order.status}
          tone={FULFILMENT_TONES[order.status] ?? "bg-neutral-400"}
        />
      </td>

      {/*
        The item count.

        Centred, because it is a small integer with nothing to align to
        — centring it keeps the eye from hunting for it.
      */}
      <td className="px-3 py-3 text-center align-middle">
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-surface-muted px-2 text-xs font-semibold tabular-nums text-foreground-muted ring-1 ring-border">
          {order.itemCount}
        </span>
      </td>

      {/*
        The total.

        Right-aligned and tabular, so the column of figures lines up
        and the admin can compare magnitudes without reading them.
      */}
      <td className="whitespace-nowrap px-3 py-3 pr-5 text-right align-middle">
        <span className="text-sm font-bold tabular-nums text-foreground">
          {formatPaisa(order.totalAmountPaisa)}
        </span>
      </td>

      {/*
        The row actions.

        Three icons: view, quick status update, cancel.
      */}
      <td className="whitespace-nowrap px-3 py-3 pr-5 align-middle">
        <div className="flex items-center justify-end gap-0.5">
          <RowAction
            href={`/admin/orders/${order.id}`}
            label={`View order ${order.orderNumber}`}
          >
            <EyeIcon width={15} height={15} />
          </RowAction>

          <RowAction
            href={`/admin/orders/${order.id}`}
            label={`Update the status of order ${order.orderNumber}`}
            disabled={isTerminal}
          >
            <PencilIcon width={15} height={15} />
          </RowAction>

          <RowAction
            href={`/admin/orders/${order.id}`}
            label={`Cancel order ${order.orderNumber}`}
            disabled={!canCancel}
            tone="danger"
          >
            <TrashIcon width={15} height={15} />
          </RowAction>
        </div>
      </td>
    </tr>
  );
}

/**
 * One row action.
 *
 * An icon button that is **always in the DOM** and merely faded until
 * the row is hovered or the button is focused. The actions are in the
 * same place on every row, so the admin's hand learns the position; and
 * they are reachable by keyboard, because `opacity-0` does not remove
 * an element from the tab order — `focus-within:opacity-100` on the row
 * is what brings them back.
 */
function RowAction({
  href,
  label,
  children,
  disabled = false,
  tone = "neutral",
}: {
  readonly href: string;
  readonly label: string;
  readonly children: React.ReactNode;
  readonly disabled?: boolean;
  readonly tone?: "neutral" | "danger";
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={label}
      onClick={(event) => {
        // A disabled action must not navigate. The server would refuse
        // the change anyway, but a row that silently does nothing when
        // it looks clickable is a broken control.
        if (disabled) {
          event.preventDefault();
        }
      }}
      className={[
        "inline-flex h-8 w-8 items-center justify-center rounded-full",
        "text-foreground-muted transition-all duration-200",
        "hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        "focus-visible:opacity-100 focus-visible:text-foreground",
        "opacity-0 group-hover:opacity-100",
        disabled
          ? "cursor-not-allowed opacity-0 group-hover:opacity-40"
          : tone === "danger"
            ? "hover:bg-red-50 hover:text-red-700"
            : "hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </Link>
  );
}

/**
 * A status badge.
 *
 * A dot in the status hue, then the axis, then the status. The dot is
 * `aria-hidden`, so the announcement is "Payment: Paid" rather than
 * "amber dot, Payment, Paid".
 */
function StatusPill({
  axis,
  status,
  tone,
}: {
  readonly axis: string;
  readonly status: string;
  readonly tone: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-foreground ring-1 ring-border">
      <span
        aria-hidden="true"
        className={["h-1.5 w-1.5 rounded-full", tone].join(" ")}
      />

      <span className="text-foreground-muted">{axis}:</span>

      <span>{status.replace(/_/g, " ")}</span>
    </span>
  );
}

/**
 * The icon for a payment method.
 *
 * The same glyph the customer tapped on at checkout, so the admin
 * recognises the method without reading it.
 */
function MethodIcon({ method }: { readonly method: string }) {
  const className = "text-foreground-muted";

  if (method === "CARD") {
    return <CreditCardIcon width={14} height={14} className={className} />;
  }

  if (method === "BKASH" || method === "NAGAD") {
    return <MobileIcon width={14} height={14} className={className} />;
  }

  return <WalletIcon width={14} height={14} className={className} />;
}

/**
 * The initial for the customer's avatar.
 *
 * The **first** letter of the first word. A two-letter monogram would
 * be nicer, but it is two initials of two different people half the
 * time ("Ayesha Rahman" is one person; "Ayesha Rahman Ltd" is not), and
 * a wrong monogram is worse than a simple one.
 */
function initialOf(name: string): string {
  const trimmed = name.trim();

  if (!trimmed) return "?";

  return trimmed.charAt(0).toUpperCase();
}

/**
 * Formats the date part of a timestamp.
 */
function formatDate(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Formats the time part of a timestamp.
 */
function formatTime(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString("en-BD", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}
