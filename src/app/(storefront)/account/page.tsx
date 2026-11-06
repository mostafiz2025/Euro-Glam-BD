import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { LogoutButton } from "@/components/admin/logout-button";
import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon } from "@/components/ui/icons";
import { getOptionalUser, type SessionUser } from "@/lib/auth/guards";
import { listOrders } from "@/lib/orders/service";
import { formatPaisa } from "@/lib/format/money";

/**
 * The account page.
 *
 * ── The rules that govern this page ──────────────────────────────────────
 *
 * **1. A signed-out visitor is offered a sign-in.**
 *
 * The account is private, so there is nothing to show. The page says
 * so plainly and points at the way in, rather than rendering a 401.
 *
 * **2. The order history is the account's main content.**
 *
 * A customer's real question on this page is "where is my order?" So
 * the order list leads, and the profile details follow.
 *
 * **3. The prices are the server's.**
 *
 * The order totals are rendered exactly as the server sent them. The
 * page does not re-derive a total from a line, because a total that
 * disagrees with the invoice is a support call.
 */

/**
 * The page metadata.
 */
export const metadata: Metadata = {
  title: "Your Account",
  description: "Your orders, your details, and your saved delivery information.",
};

/**
 * This route is allowed to block.
 *
 * The account belongs to a user, so it cannot be prerendered. Under
 * Cache Components a session-gated route must declare that it may
 * block, with `export const instant = false`.
 *
 * The session is read at the top of the page, outside the `<Suspense>`
 * boundary, because a dynamic read inside a boundary defers it
 * indefinitely — the fallback would be sent and the real content would
 * never arrive.
 */
export const instant = false;

/**
 * The account page.
 */
export default async function AccountPage() {
  // The page depends on who is asking, so it is rendered at request
  // time and the session is read outside the `<Suspense>` boundary.
  await connection();

  const user = await getOptionalUser();

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
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
            <span aria-current="page" className="font-medium text-foreground">
              Your Account
            </span>
          </li>
        </ol>
      </nav>

      <Suspense fallback={<AccountSkeleton />}>
        <AccountBody user={user} />
      </Suspense>
    </div>
  );
}

/**
 * The account body.
 */
async function AccountBody({
  user,
}: {
  readonly user: SessionUser | null;
}) {
  if (!user) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
        <h1 className="font-serif text-2xl font-bold text-foreground">
          Your account
        </h1>

        <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
          Sign in to see your orders, your saved details and your refill
          reminders.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <ButtonLink href="/login?next=%2Faccount" variant="primary" size="sm">
            Sign in
          </ButtonLink>

          <ButtonLink href="/register" variant="outline" size="sm">
            Create an account
          </ButtonLink>
        </div>
      </div>
    );
  }

  const result = await listOrders(user.id, 1, 20).catch((error: unknown) => {
    console.error("[storefront] Order list failed:", error);
    return null;
  });

  return (
    <>
      <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {user.name}
      </h1>

      <p className="mt-1.5 text-sm text-foreground-muted">{user.email}</p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        {/* ── The orders ─────────────────────────────────────────────── */}
        <section aria-labelledby="orders-heading">
          <h2
            id="orders-heading"
            className="text-sm font-bold uppercase tracking-wider text-foreground"
          >
            Your orders
          </h2>

          {!result ? (
            <p
              role="status"
              className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
            >
              We could not load your orders. Please try again.
            </p>
          ) : result.orders.length === 0 ? (
            <div className="mt-4 rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-12 text-center">
              <p className="text-sm text-foreground-muted">
                You have not placed an order yet.
              </p>

              <div className="mt-4">
                <ButtonLink href="/products" variant="outline" size="sm">
                  Browse the catalogue
                </ButtonLink>
              </div>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {result.orders.map((order) => (
                <li key={order.id}>
                  <Link
                    href={`/orders/${order.id}`}
                    className="block rounded-[var(--radius-card)] border border-border bg-surface p-4 transition-colors hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {order.orderNumber}
                        </p>

                        <p className="mt-0.5 text-xs text-foreground-muted">
                          {formatOrderDate(order.createdAt)} ·{" "}
                          {order.itemCount}{" "}
                          {order.itemCount === 1 ? "item" : "items"}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="text-sm font-semibold tabular-nums text-foreground">
                          {formatPaisa(order.totalAmountPaisa)}
                        </p>

                        <div className="mt-1 flex justify-end gap-1.5">
                          <OrderStatusBadge status={order.status} />
                          <PaymentStatusBadge status={order.paymentStatus} />
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── The details ───────────────────────────────────────────── */}
        <aside className="space-y-4">
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
            <h2 className="text-sm font-bold text-foreground">Your details</h2>

            <dl className="mt-3 space-y-2.5 text-xs">
              <div>
                <dt className="text-foreground-muted">Name</dt>
                <dd className="mt-0.5 font-medium text-foreground">
                  {user.name}
                </dd>
              </div>

              <div>
                <dt className="text-foreground-muted">Email</dt>
                <dd className="mt-0.5 break-all font-medium text-foreground">
                  {user.email}
                </dd>
              </div>

              <div>
                <dt className="text-foreground-muted">Refill reminders</dt>
                <dd className="mt-0.5 font-medium text-foreground">
                  {user.smsOptIn ? "On" : "Off"}
                </dd>
              </div>
            </dl>

            {/*
              The link to the settings page.

              The details above are a **read-only summary**. The page
              that edits them is one click away, because a customer who
              reads "No mobile number on file" and then has to go hunting
              for the form to fix it has been left with a dead end.
            */}
            <div className="mt-4 border-t border-border pt-4">
              <ButtonLink href="/account/settings" variant="outline" size="sm">
                Edit your details
              </ButtonLink>
            </div>
          </div>

          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
            <h2 className="text-sm font-bold text-foreground">Quick links</h2>

            <ul className="mt-3 space-y-2">
              {[
                { href: "/account/settings", label: "Account settings" },
                { href: "/cart", label: "Your cart" },
                { href: "/products", label: "Browse the catalogue" },
                { href: "/products?isBestSeller=true", label: "Best sellers" },
              ].map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="inline-flex items-center gap-1 text-sm text-foreground-muted transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <ChevronRightIcon width={14} height={14} />
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>

            {/*
              The sign-out control. It is here as well as in the header
              menu, because the account page is where someone who wants
              to sign out will look for it.

              It is a **button**, not a link: it runs an action — a POST
              that clears the session cookie — rather than navigating.
            */}
            <div className="mt-4 border-t border-border pt-4">
              <LogoutButton className="w-full justify-center" />
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

/**
 * The badge for an order's fulfilment status.
 */
function OrderStatusBadge({ status }: { readonly status: string }) {
  const styles: Record<string, string> = {
    PENDING: "bg-amber-50 text-amber-700 border-amber-200",
    PROCESSING: "bg-blue-50 text-blue-700 border-blue-200",
    SHIPPED: "bg-violet-50 text-violet-700 border-violet-200",
    DELIVERED: "bg-emerald-50 text-emerald-700 border-emerald-200",
    CANCELLED: "bg-surface-muted text-foreground-muted border-border",
  };

  return (
    <span
      className={[
        "inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        styles[status] ?? "bg-surface-muted text-foreground-muted border-border",
      ].join(" ")}
    >
      {status}
    </span>
  );
}

/**
 * The badge for an order's payment status.
 */
function PaymentStatusBadge({ status }: { readonly status: string }) {
  const styles: Record<string, string> = {
    PENDING: "bg-surface-muted text-foreground-muted border-border",
    PAID: "bg-emerald-50 text-emerald-700 border-emerald-200",
    FAILED: "bg-red-50 text-red-700 border-red-200",
    REFUNDED: "bg-surface-muted text-foreground-muted border-border",
  };

  return (
    <span
      className={[
        "inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        styles[status] ?? "bg-surface-muted text-foreground-muted border-border",
      ].join(" ")}
    >
      {status === "PENDING" ? "Due on delivery" : status}
    </span>
  );
}

/**
 * Formats an order date.
 *
 * The date is read on the server and formatted in the `en-BD` locale,
 * so the server and the browser cannot disagree about what it says.
 */
function formatOrderDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * The placeholder shown while the account loads.
 */
function AccountSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="h-8 w-56 animate-pulse rounded-full bg-surface-muted" />
      <div className="mt-2 h-4 w-72 animate-pulse rounded-full bg-surface-muted" />

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="h-24 animate-pulse rounded-[var(--radius-card)] bg-surface-muted"
            />
          ))}
        </div>

        <div className="h-64 animate-pulse rounded-[var(--radius-card)] bg-surface-muted" />
      </div>
    </div>
  );
}
