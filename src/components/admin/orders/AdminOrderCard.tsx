import Link from "next/link";

import {
  FulfilmentActions,
  PaymentActions,
} from "@/components/admin/order-status-actions";
import {
  CreditCardIcon,
  MobileIcon,
  WalletIcon,
} from "@/components/ui/icons";
import { formatPaisa } from "@/lib/format/money";
import { paymentMethodLabel } from "@/lib/format/payment";

/**
 * The order card.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * One order in the fulfilment desk, as a **card** rather than a table
 * row. A table is the right shape for a spreadsheet of identical rows;
 * an order is not a spreadsheet row. It has a customer, an amount, two
 * independent status axes, a payment method and a set of actions, and
 * the actions differ from order to order because the transition table
 * differs. A card gives each of those things room to breathe.
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. Two axes, and they are labelled.**
 *
 * Fulfilment and payment move independently — a cash-on-delivery
 * order can be `SHIPPED` while the payment is still `PENDING`. The
 * card shows both, and each badge says which axis it belongs to, so a
 * pair of badges is never a puzzle.
 *
 * **2. The badges are dot-and-word, not colour alone.**
 *
 * A coloured pill alone is a badge that fails for a colourblind admin
 * and a screen reader alike. So each badge carries a **dot** in the
 * same hue plus the word — the colour is a second signal, not the
 * only one.
 *
 * **3. The actions live in a toolbar, not a pile.**
 *
 * Fulfilment and payment are separate axes, so they get separate
 * groups, each with its own label. The layout is a two-column grid on
 * a wide screen, so the two axes sit side by side and a long list of
 * orders can be scanned down the columns rather than read.
 *
 * **4. The amount is the anchor.**
 *
 * The total is the figure the admin is looking for, so it is the
 * largest type on the card and it sits in the top-right corner, where
 * a price column sits in every other list the admin already knows.
 *
 * **5. The card lifts on hover, but only on hover.**
 *
 * The hover elevation is a small, deliberate lift — the card
 * acknowledges the pointer, and the row it is in becomes obvious. It
 * does not scale or glow, because a list of twenty order cards that
 * each animate on hover is a list that is noisy.
 */

/**
 * The props for the card.
 */
export type AdminOrderCardProps = {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly paymentMethod: string;
  readonly totalAmountPaisa: number;
  readonly discountAmountPaisa: number;
  readonly itemCount: number;
  readonly createdAt: Date;
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
 * The order card.
 */
export function AdminOrderCard({
  id,
  orderNumber,
  status,
  paymentStatus,
  paymentMethod,
  totalAmountPaisa,
  discountAmountPaisa,
  itemCount,
  createdAt,
  customer,
  permittedStatuses,
  permittedPaymentStatuses,
}: AdminOrderCardProps) {
  return (
    <li>
      <article className="group rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)] transition-all duration-200 ease-[var(--ease-out-soft)] hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[var(--shadow-lift)] sm:p-5">
        {/*
          The head.

          The order number and its two status badges on the left, the
          amount on the right. The amount is right-aligned and
          tabular-nums, so a column of them lines up — which is what
          makes a list of orders scannable.
        */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/orders/${id}`}
                className="rounded text-sm font-bold text-foreground underline-offset-4 transition-colors hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                {orderNumber}
              </Link>

              <StatusPill
                axis="Fulfilment"
                status={status}
                tone={FULFILMENT_TONES[status] ?? "bg-neutral-400"}
              />

              <StatusPill
                axis="Payment"
                status={paymentStatus}
                tone={PAYMENT_TONES[paymentStatus] ?? "bg-neutral-400"}
                label={
                  paymentStatus === "PENDING" ? "Due on delivery" : undefined
                }
              />
            </div>

            {/*
              The customer.

              The name is the strong element and the email and phone
              are the supporting ones, because the name is what an
              admin scans for and the rest is what they reach for
              when the name is not enough.
            */}
            <p className="mt-2 text-xs text-foreground-muted">
              <span className="font-semibold text-foreground">
                {customer.name}
              </span>

              <span className="mx-1.5 text-neutral-300">·</span>

              <span className="break-all">{customer.email}</span>

              {customer.phone ? (
                <>
                  <span className="mx-1.5 text-neutral-300">·</span>
                  <span className="tabular-nums">{customer.phone}</span>
                </>
              ) : null}
            </p>

            {/*
              The metadata line.

              The payment method gets an icon, so the method is
              recognisable at a glance without reading it — and the
              icon is the one the customer chose, not a generic
              "payment" glyph.
            */}
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-foreground-muted">
              <span className="inline-flex items-center gap-1.5">
                <MethodIcon method={paymentMethod} />
                {paymentMethodLabel(paymentMethod)}
              </span>

              <span aria-hidden="true" className="text-neutral-300">
                ·
              </span>

              <span>
                {itemCount} line{itemCount === 1 ? "" : "s"}
              </span>

              <span aria-hidden="true" className="text-neutral-300">
                ·
              </span>

              <time dateTime={createdAt.toISOString()}>
                {formatDate(createdAt)}
              </time>
            </div>
          </div>

          {/*
            The amount.

            The anchor of the card — the largest type on it, and the
            only figure in tabular numerals at that size.
          */}
          <div className="shrink-0 text-right">
            <p className="text-lg font-bold tabular-nums tracking-tight text-foreground">
              {formatPaisa(totalAmountPaisa)}
            </p>

            {discountAmountPaisa > 0 ? (
              <p className="mt-0.5 text-xs tabular-nums text-emerald-600">
                −{formatPaisa(discountAmountPaisa)}
              </p>
            ) : null}
          </div>
        </div>

        {/*
          The action toolbars.

          Two axes, two toolbars, side by side on a wide screen. The
          grid keeps the two columns aligned down the whole list, so
          the eye can run down the fulfilment column without the rows
          drifting.
        */}
        <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-2 sm:gap-5">
          <ActionToolbar label="Fulfilment">
            <FulfilmentActions
              orderId={id}
              status={status}
              permittedStatuses={permittedStatuses}
            />
          </ActionToolbar>

          <ActionToolbar label="Payment">
            <PaymentActions
              orderId={id}
              permittedPaymentStatuses={permittedPaymentStatuses}
            />
          </ActionToolbar>
        </div>
      </article>
    </li>
  );
}

/**
 * One axis's toolbar.
 *
 * The label is a small uppercase heading, and the controls sit under
 * it. The label is what makes the two axes legible — two rows of
 * buttons with no labels would be unreadable.
 */
function ActionToolbar({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-foreground-muted">
        {label}
      </p>

      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * A status badge.
 *
 * A dot in the status hue, then the word. The dot is `aria-hidden`, so
 * the announcement is just the axis and the status — "Payment, Due on
 * delivery" — which is what a screen reader should say.
 */
function StatusPill({
  axis,
  status,
  tone,
  label,
}: {
  readonly axis: string;
  readonly status: string;
  readonly tone: string;
  readonly label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-foreground ring-1 ring-border">
      <span aria-hidden="true" className={["h-1.5 w-1.5 rounded-full", tone].join(" ")} />

      <span className="text-foreground-muted">{axis}:</span>

      <span>{label ?? status.replace(/_/g, " ")}</span>
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
    return <CreditCardIcon width={13} height={13} className={className} />;
  }

  if (method === "BKASH" || method === "NAGAD") {
    return <MobileIcon width={13} height={13} className={className} />;
  }

  return <WalletIcon width={13} height={13} className={className} />;
}

/**
 * Formats an order date.
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
