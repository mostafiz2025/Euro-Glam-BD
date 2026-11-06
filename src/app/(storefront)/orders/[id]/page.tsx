import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon } from "@/components/ui/icons";
import { getOptionalUser, type SessionUser } from "@/lib/auth/guards";
import { formatPaisa } from "@/lib/format/money";
import {
  paidByLabel,
  paymentMethodLabel,
  paymentMethodNote,
} from "@/lib/format/payment";
import { getOrderById } from "@/lib/orders/service";
import {
  readPaymentNote,
  readPaymentOutcome,
  resolvePaymentBanner,
  shouldOfferPayNow,
} from "@/lib/orders/payment-banner";

import { PayNowButton } from "./pay-now-button";

/**
 * The order detail page.
 *
 * ── The rules that govern this page ──────────────────────────────────────
 *
 * **1. An order belongs to its owner.**
 *
 * `getOrderById` takes the user's id and the order's id, and returns
 * `null` for an order that is not theirs. The page never reads an
 * order without checking the owner — that check is the authorisation,
 * and it lives in the service where it cannot be forgotten.
 *
 * **2. A missing order is a 404.**
 *
 * Not an empty page. The order either does not exist or belongs to
 * someone else, and in both cases the customer should not be shown a
 * skeleton that never fills in.
 *
 * The 404 is raised *before* the response starts, which is why the
 * order is read at the top of the page rather than inside a
 * `<Suspense>` boundary. See the note on the page component below.
 *
 * **3. The totals are the server's.**
 *
 * The subtotal, the delivery charge and the total are rendered exactly
 * as the server computed them. The page does not add the lines up
 * again — a total that disagrees with the invoice is a support call.
 */

/**
 * The props for the page.
 */
type OrderPageProps = {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * This route is allowed to block.
 *
 * An order belongs to a user, so the page cannot be prerendered. Under
 * Cache Components a session-gated route must declare that it may
 * block, with `export const instant = false`.
 *
 * The session is read at the top of the page, outside any `<Suspense>`
 * boundary, because a dynamic read inside a boundary defers it
 * indefinitely — the fallback would be sent and the real content would
 * never arrive.
 */
export const instant = false;

/**
 * The page metadata.
 */
export async function generateMetadata({
  params,
}: OrderPageProps): Promise<Metadata> {
  const { id } = await params;

  const user = await getOptionalUser();

  if (!user) {
    return { title: "Order" };
  }

  const order = await getOrderById(user.id, id).catch(() => null);

  if (!order) {
    return { title: "Order not found" };
  }

  return {
    title: `Order ${order.orderNumber}`,
    description: `Your order ${order.orderNumber} from Euro Glam BD.`,
  };
}

/**
 * The order detail page.
 *
 * ── Where the 404 comes from ──────────────────────────────────────────────
 *
 * The order is read inside a `<Suspense>` boundary, so the shell is
 * sent to the browser before the order is known. If the order turns out
 * not to exist, `notFound()` throws — but the response has already
 * started, and Next.js documents that the status stays `200`.
 *
 * That is not a cosmetic problem. A missing order is a `404` in the
 * customer's browser, in the search engine's index, and on the
 * monitoring dashboard. A `200` says the page exists.
 *
 * So the **status** is decided by the proxy, which checks the order's
 * existence before the page renders and rewrites a missing order to
 * `/orders-not-found`. The page's own `notFound()` remains the
 * authority for the *content* — it decides what the customer reads.
 *
 * The two are not redundant. The proxy's check is a fast path that
 * produces the right status code; the page's check is the thing that
 * actually decides whether the order is there. If the proxy's check
 * cannot run — a database blip, a timeout — the page still refuses to
 * render an order that is not the caller's.
 */
export default async function OrderPage({
  params,
  searchParams,
}: OrderPageProps) {
  // The page depends on who is asking, so it is rendered at request
  // time and the session is read outside the `<Suspense>` boundary.
  await connection();

  const user = await getOptionalUser();

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <Suspense fallback={<OrderSkeleton />}>
        <OrderBody params={params} searchParams={searchParams} user={user} />
      </Suspense>
    </div>
  );
}

/**
 * The order body.
 */
async function OrderBody({
  params,
  searchParams,
  user,
}: {
  readonly params: OrderPageProps["params"];
  readonly searchParams: OrderPageProps["searchParams"];
  readonly user: SessionUser | null;
}) {
  const { id } = await params;

  /**
   * The payment callback's outcome.
   *
   * The SSLCOMMERZ callbacks redirect here with `payment=unconfirmed`,
   * `payment=failed` or `payment=cancelled`, and optionally a `note`.
   *
   * These are a **message**, not a record. The order's real payment
   * status is the row in the database, read below — and the row wins.
   *
   * A settled payment redirects with **no** outcome parameter at all,
   * because the row now says `PAID` and the page renders from that row.
   * The parameters only ever add a banner for the case the row cannot
   * express on its own: a payment the shop has not been able to confirm
   * with the gateway yet.
   */
  const query = await searchParams;
  const paymentOutcome = readPaymentOutcome(query.payment);
  const paymentNote = readPaymentNote(query.note);

  if (!user) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
        <h1 className="font-serif text-2xl font-bold text-foreground">
          Sign in to see your order
        </h1>

        <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
          Orders are tied to your account, so you can check on them from any
          device.
        </p>

        <div className="mt-6">
          <ButtonLink href="/login" variant="primary" size="sm">
            Sign in
          </ButtonLink>
        </div>
      </div>
    );
  }

  const order = await getOrderById(user.id, id).catch((error: unknown) => {
    console.error("[storefront] Order load failed:", error);
    return null;
  });

  // The order does not exist, or it belongs to someone else. Both are
  // a 404: the customer should not be able to tell the difference, and
  // neither should an attacker.
  if (!order) {
    notFound();
  }

  /**
   * Whether the payment is settled.
   *
   * Read from the **database**, not from the query string. The query
   * string is the customer's browser and can be edited; the row is the
   * shop's record. Every decision below — the banner, the badge, the
   * "Pay now" button — is made from the row.
   */
  const isPaid = order.paymentStatus === "PAID";

  /**
   * The banner to show, if any.
   *
   * The **order row decides** — see `resolvePaymentBanner`. A stale
   * `payment=unconfirmed` left in a URL from an earlier attempt must not
   * put an amber "we could not confirm" warning on an order that has
   * since been paid. That warning would tell a customer their money is
   * in doubt when it is not, and send them to pay a second time.
   */
  const banner = resolvePaymentBanner({
    paymentStatus: order.paymentStatus,
    outcome: paymentOutcome,
    note: paymentNote,
  });

  return (
    <>
      {/*
        The payment banner.

        It is rendered **above** the breadcrumb, because it is the thing
        the customer came here to read — they have just come back from
        the gateway, and the first question is "did it work?".

        It says what the **database** says. The status pill below says
        the same thing from the same row, so the two cannot disagree.
      */}
      {banner ? <PaymentBanner outcome={banner.outcome} note={banner.note} /> : null}

      {/* ── The breadcrumb ───────────────────────────────────────────── */}
      <nav aria-label="Breadcrumb" className="mb-4">
        <ol className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <li>
            <Link
              href="/"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Home
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <Link
              href="/account"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Account
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <span aria-current="page" className="font-medium text-foreground">
              {order.orderNumber}
            </span>
          </li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {order.orderNumber}
          </h1>

          <p className="mt-1.5 text-sm text-foreground-muted">
            Placed on {formatOrderDate(order.createdAt)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <StatusPill label="Order" value={order.status} tone={order.status} />

          {/*
            The payment pill.

            Three cases, and they are read from the **row**:

              - `PENDING` on a cash-on-delivery order — nothing has been
                paid yet, and the money is collected at the door.
              - `PENDING` on a gateway order — the money may be on its
                way, and the customer is being told we have not
                confirmed it yet.
              - Anything settled — the raw enum (`PAID`, `REFUNDED`).
                The **badge** next to it is where the *rail* is named;
                the pill keeps the status, so the two do not say the
                same thing twice in two different words.
          */}
          <StatusPill
            label="Payment"
            value={
              order.paymentStatus === "PENDING"
                ? order.paymentMethod === "COD"
                  ? "Due on delivery"
                  : "Verifying transfer"
                : order.paymentStatus
            }
            tone={order.paymentStatus}
          />

          {/*
            The paid badge.

            A settled payment gets an explicit, unmissable marker — not
            just a status pill reading `PAID` in a column of other
            pills. This is the thing the customer came back to check,
            so it is spelled out: the money is in, the order is ours to
            dispatch.

            It also names the **rail** the customer actually paid by —
            "Paid by bKash", "Paid by Nagad" — because the checkout
            bundles them into one option and the customer chose on the
            gateway's own page. The order row records what they chose,
            and this badge reports it back.
          */}
          {isPaid ? <PaidBadge method={order.paymentMethod} /> : null}
        </div>
      </div>

      {/* ── The items ─────────────────────────────────────────────────── */}
      <section aria-labelledby="items-heading" className="mt-8">
        <h2
          id="items-heading"
          className="text-sm font-bold uppercase tracking-wider text-foreground"
        >
          What you ordered
        </h2>

        <ul className="mt-4 divide-y divide-border border-y border-border">
          {order.items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-4 py-3.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  <Link
                    href={`/products/${item.productId}`}
                    className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:text-brand-700"
                  >
                    {item.productName}
                  </Link>
                </p>

                <p className="mt-0.5 text-xs text-foreground-muted">
                  {item.quantity} × {formatPaisa(item.pricePaisa)}
                </p>
              </div>

              <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                {formatPaisa(item.pricePaisa * item.quantity)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── The totals ────────────────────────────────────────────────── */}
      <section
        aria-labelledby="totals-heading"
        className="mt-6 rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]"
      >
        <h2
          id="totals-heading"
          className="text-sm font-bold uppercase tracking-wider text-foreground"
        >
          Payment summary
        </h2>

        <dl className="mt-4 space-y-2.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-foreground-muted">Subtotal</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {formatPaisa(order.subtotalPaisa)}
            </dd>
          </div>

          {/*
            The coupon's discount, shown **separately** from the total
            discount.

            The total discount is the free shipping plus the coupon, and
            the customer is entitled to see *which* one saved them what.
            A single anonymous "Discount" line would leave them unable
            to tell what their code did — and a customer who cannot tell
            what their code did cannot tell whether it worked.
          */}
          {order.couponDiscountPaisa > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-foreground-muted">
                Discount
                {order.couponCode ? (
                  <span className="ml-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                    {order.couponCode}
                  </span>
                ) : null}
              </dt>
              <dd className="font-medium tabular-nums text-emerald-600">
                −{formatPaisa(order.couponDiscountPaisa)}
              </dd>
            </div>
          ) : null}

          {/*
            The free-delivery discount, when the order qualified.

            Only shown when it is a *separate* fact — when there is no
            coupon, the total discount line below covers it, and two
            lines saying "৳0" and "৳80" for the same saving would be
            noise.
          */}
          {order.couponDiscountPaisa === 0 && order.discountAmountPaisa > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-foreground-muted">Free delivery</dt>
              <dd className="font-medium tabular-nums text-emerald-600">
                −{formatPaisa(order.discountAmountPaisa)}
              </dd>
            </div>
          ) : null}

          <div className="flex justify-between gap-4">
            <dt className="text-foreground-muted">Delivery</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {order.shippingPaisa === 0
                ? "Free"
                : formatPaisa(order.shippingPaisa)}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-border pt-4">
          <dt className="text-sm font-semibold text-foreground">Total</dt>
          <dd className="text-lg font-bold tabular-nums text-foreground">
            {formatPaisa(order.totalAmountPaisa)}
          </dd>
        </div>

        {/*
          The payment method and, for a mobile-banking order, the
          transfer reference the customer quoted.

          This used to be a hard-coded "Cash on delivery" line, which
          was correct while COD was the only method. With four methods
          available it would have told a bKash customer that they had
          paid cash on delivery — so the method is read from the order
          and the copy follows it.

          ── Why this can change ─────────────────────────────────────────
          *
          The checkout offers **one** "Online Payment" option that
          bundles bKash, Nagad and cards, because the customer picks the
          operator on the gateway's own page — after the order row
          already exists. So the row is created with the generic `CARD`
          and is **corrected at settlement**, when the gateway's
          validation response names the rail it actually used.

          That is why this line is not frozen at checkout time: it shows
          the order's **current** method, so a settled bKash order says
          "bKash" rather than "Card Payment" — the truth as of now.
        */}
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex justify-between gap-4 text-sm">
            <dt className="text-foreground-muted">Payment method</dt>
            <dd className="font-medium text-foreground">
              {paymentMethodLabel(order.paymentMethod)}
            </dd>
          </div>

          {order.paymentSenderNumber ? (
            <div className="mt-2 flex justify-between gap-4 text-sm">
              <dt className="text-foreground-muted">Sent from</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {order.paymentSenderNumber}
              </dd>
            </div>
          ) : null}

          {order.paymentTransactionId ? (
            <div className="mt-2 flex justify-between gap-4 text-sm">
              <dt className="text-foreground-muted">Transaction ID</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {order.paymentTransactionId}
              </dd>
            </div>
          ) : null}

          {/*
            The gateway's own reference, shown **separately** from the
            customer's transaction ID above.

            The two are different things — one is what the customer
            quoted, the other is what the gateway issued — and showing
            them under one label would make the shop's staff guess which
            one they are looking at when a customer reads it out over the
            phone.
          */}
          {order.paymentGatewayTransactionId ? (
            <div className="mt-2 flex justify-between gap-4 text-sm">
              <dt className="text-foreground-muted">Payment reference</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {order.paymentGatewayTransactionId}
              </dd>
            </div>
          ) : null}
        </div>

        <p className="mt-3 text-xs leading-relaxed text-foreground-muted">
          {paymentMethodNote(
            order.paymentMethod,
            order.paymentGatewayTransactionId !== null,
          )}
        </p>
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        {/**
         * "Pay now" — the way back into the gateway for an order whose
         * payment is still pending.
         *
         * This is the case where the customer closed the tab while the
         * payment window was open, or where a payment attempt failed and
         * they want to try again later. The order is still `PENDING` and
         * the stock is still reserved, so the payment can be settled
         * whenever they are ready.
         *
         * The rule lives in `shouldOfferPayNow`. A **paid** order never
         * gets the button, whatever the URL says.
         */}
        {shouldOfferPayNow({
          paymentStatus: order.paymentStatus,
          paymentMethod: order.paymentMethod,
        }) ? (
          <PayNowButton orderId={order.id} />
        ) : null}

        <ButtonLink href="/account" variant="outline" size="sm">
          All your orders
        </ButtonLink>

        <ButtonLink href="/products" variant="primary" size="sm">
          Continue shopping
        </ButtonLink>
      </div>
    </>
  );
}

/**
 * The outcome the payment callback reported.
 */
type PaymentOutcome = "confirmed" | "unconfirmed" | "failed" | "cancelled";

/**
 * The payment outcome banner.
 *
 * One component for four outcomes, because the four differ only in
 * their tone and their headline — and four near-identical blocks of JSX
 * would drift apart within a week.
 */
function PaymentBanner({
  outcome,
  note,
}: {
  readonly outcome: PaymentOutcome;
  readonly note: string | null;
}) {
  const tone: Record<
    PaymentOutcome,
    { readonly wrapper: string; readonly title: string; readonly body: string }
  > = {
    confirmed: {
      wrapper: "border-emerald-200 bg-emerald-50",
      title: "Payment confirmed",
      body: "Thank you — we have received your payment and your order is on its way to being dispatched.",
    },
    unconfirmed: {
      wrapper: "border-amber-200 bg-amber-50",
      title: "We could not confirm the payment yet",
      body: "Your order is placed and reserved. If you were charged, our team will verify it with the gateway and confirm your order shortly.",
    },
    failed: {
      wrapper: "border-red-200 bg-red-50",
      title: "The payment was not completed",
      body: "Your order is still reserved, so you can try paying again whenever you are ready.",
    },
    cancelled: {
      wrapper: "border-amber-200 bg-amber-50",
      title: "The payment was cancelled",
      body: "Your order is still reserved, so you can try paying again whenever you are ready.",
    },
  };

  const style = tone[outcome];

  return (
    <div
      role="status"
      className={[
        "mb-5 rounded-[var(--radius-card)] border px-4 py-3.5",
        style.wrapper,
      ].join(" ")}
    >
      <p className="text-sm font-bold text-foreground">{style.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
        {style.body}
      </p>

      {note ? (
        <p className="mt-1.5 text-xs leading-relaxed text-foreground-muted">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The "paid" badge.
 *
 * ── Why a badge and not just a status pill ────────────────────────────────
 *
 * The status pill reads `PAID` in a column of pills, in the same shape
 * and the same weight as `PENDING` and `SHIPPED`. It is accurate and
 * easy to miss in equal measure.
 *
 * The badge is the one piece of the page that says, in words, that the
 * money is in — which is the question the customer came back to ask.
 * It is green, it is rounded, it carries a tick, and it is the last
 * thing in the eye's path on the way to the items list.
 *
 * ── Why it names the rail ─────────────────────────────────────────────────
 *
 * The badge says **how** the customer paid, not just that they did:
 * "Paid by bKash", "Paid by Nagad", "Card Payment".
 *
 * That matters because the checkout offers one "Online Payment" option
 * that bundles bKash, Nagad and cards — the customer picks the operator
 * on the gateway's own page, after the order exists. So the order row
 * records the **real** rail, read from the gateway's validation
 * response, and the badge reports it back. A shopper who paid with
 * bKash sees "Paid by bKash" — matching the line on their own bank
 * statement, which is what they will check against.
 *
 * It is rendered **only** from the database row. There is no query
 * string that can put it there, and none that can take it away.
 */
function PaidBadge({ method }: { readonly method: string }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-2">
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"
      >
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3.5 w-3.5"
        >
          <path
            fillRule="evenodd"
            d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.25 7.5a1 1 0 0 1-1.442.006l-3.75-3.75a1 1 0 1 1 1.414-1.414l3.029 3.028 6.629-6.858a1 1 0 0 1 1.414-.006Z"
            clipRule="evenodd"
          />
        </svg>
      </span>

      <span className="text-xs font-bold text-emerald-700">
        {paidByLabel(method)}
      </span>
    </div>
  );
}

/**
 * A status pill.
 */
function StatusPill({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: string;
}) {
  const styles: Record<string, string> = {
    PENDING: "bg-amber-50 text-amber-700 border-amber-200",
    PROCESSING: "bg-blue-50 text-blue-700 border-blue-200",
    SHIPPED: "bg-violet-50 text-violet-700 border-violet-200",
    DELIVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
    CANCELLED: "bg-surface-muted text-foreground-muted border-border",
    PAID: "bg-emerald-50 text-emerald-700 border-emerald-200",
    FAILED: "bg-red-50 text-red-700 border-red-200",
    REFUNDED: "bg-surface-muted text-foreground-muted border-border",
  };

  return (
    <div
      className={[
        "rounded-2xl border px-3.5 py-2 text-center",
        styles[tone] ?? "bg-surface-muted text-foreground-muted border-border",
      ].join(" ")}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
        {label}
      </p>
      <p className="mt-0.5 text-xs font-bold">{value}</p>
    </div>
  );
}

/**
 * Formats an order date.
 */
function formatOrderDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-BD", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * The placeholder shown while the order loads.
 */
function OrderSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="h-8 w-52 animate-pulse rounded-full bg-surface-muted" />
      <div className="mt-2 h-4 w-40 animate-pulse rounded-full bg-surface-muted" />

      <div className="mt-8 space-y-4">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-12 animate-pulse rounded-full bg-surface-muted" />
        ))}
      </div>

      <div className="mt-6 h-52 animate-pulse rounded-[var(--radius-card)] bg-surface-muted" />
    </div>
  );
}
