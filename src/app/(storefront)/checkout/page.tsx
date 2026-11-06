import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { CheckoutForm } from "@/components/commerce/checkout-form";
import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon } from "@/components/ui/icons";
import { getCustomerProfile } from "@/lib/account/profile";
import { getOptionalUser, type SessionUser } from "@/lib/auth/guards";
import { getCartWithCoupon } from "@/lib/coupons/service";
import { fetchActiveCoupons } from "@/lib/format/server-data";

/**
 * The checkout page.
 *
 * ── The rules that govern this page ──────────────────────────────────────
 *
 * **1. A customer cannot check out an empty cart.**
 *
 * The order is built from the cart, so an empty cart means there is
 * nothing to check out. The page says so and sends them back to the
 * catalogue, rather than presenting a checkout form that would fail.
 *
 * **2. The prices are the server's.**
 *
 * The summary renders the totals the server sent. The page does not
 * compute a delivery charge, because the server computes it and a
 * second implementation would drift.
 *
 * **3. The shell is static; the form streams.**
 *
 * The form is a client component and the cart is a session read, so
 * both sit behind a `<Suspense>` boundary.
 */

/**
 * The page metadata.
 */
export const metadata: Metadata = {
  title: "Checkout",
  description:
    "Complete your order across Bangladesh — pay cash on delivery, or securely online by card, bKash or Nagad.",
};

/**
 * This route is allowed to block.
 *
 * The checkout belongs to a user, so it cannot be prerendered. Under
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
 * The checkout page.
 */
export default async function CheckoutPage() {
  // The page depends on who is asking, so it is rendered at request
  // time and the session is read outside the `<Suspense>` boundary.
  // A dynamic read inside a boundary defers it indefinitely, and the
  // customer would be left with a skeleton that never resolves.
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
            <Link
              href="/cart"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Cart
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <span aria-current="page" className="font-medium text-foreground">
              Checkout
            </span>
          </li>
        </ol>
      </nav>

      <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        Checkout
      </h1>

      <div className="mt-6">
        <Suspense fallback={<CheckoutSkeleton />}>
          <CheckoutBody user={user} />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * The checkout body.
 */
async function CheckoutBody({
  user,
}: {
  readonly user: SessionUser | null;
}) {
  if (!user) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
        <h2 className="text-base font-semibold text-foreground">
          Sign in to check out
        </h2>

        <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
          Your cart is saved to your account, so you can finish the order
          from any device.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <ButtonLink href="/login?next=%2Fcheckout" variant="primary" size="sm">
            Sign in
          </ButtonLink>

          <ButtonLink href="/cart" variant="outline" size="sm">
            Back to your cart
          </ButtonLink>
        </div>
      </div>
    );
  }

  const cart = await getCartWithCoupon(user.id).catch((error: unknown) => {
    console.error("[storefront] Checkout cart load failed:", error);
    return null;
  });

  if (!cart) {
    return (
      <div
        role="status"
        className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
      >
        We could not load your cart. Please try again.
      </div>
    );
  }

  if (cart.items.length === 0) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
        <h2 className="text-base font-semibold text-foreground">
          There is nothing to check out
        </h2>

        <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
          Your cart is empty. Add something first and come back.
        </p>

        <div className="mt-6">
          <ButtonLink href="/products" variant="primary" size="sm">
            Browse the catalogue
          </ButtonLink>
        </div>
      </div>
    );
  }

  /*
   * The live codes, for the helper.
   *
   * Read alongside the cart rather than inside it: the cart's arithmetic
   * is the cart's business, and the list of campaigns is the shop
   * floor's. This fetch never throws — a failed coupon query leaves the
   * checkout working and the helper simply has nothing to list.
   */
  const { coupons } = await fetchActiveCoupons();

  /*
   * The customer's saved delivery address, if they have one.
   *
   * This is what makes the saved address worth saving: the checkout
   * pre-fills the address form from it, so a customer who has already
   * told us where they live does not type it again.
   *
   * The read never throws — a failed profile query leaves the checkout
   * working with an empty address form, which is exactly where it
   * started before the saved address existed.
   */
  const profile = await getCustomerProfile(user.id).catch(
    (error: unknown) => {
      console.error("[storefront] Saved address load failed:", error);
      return null;
    },
  );

  return (
    <CheckoutForm
      cart={cart}
      customerName={user.name}
      customerPhone={user.phone}
      savedAddress={profile?.defaultAddress ?? null}
      coupons={coupons}
    />
  );
}

/**
 * The placeholder shown while the checkout loads.
 */
function CheckoutSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]"
    >
      <div className="space-y-4">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-11 animate-pulse rounded-xl bg-surface-muted" />
        ))}
      </div>

      <div className="h-96 animate-pulse rounded-[var(--radius-card)] bg-surface-muted" />
    </div>
  );
}
