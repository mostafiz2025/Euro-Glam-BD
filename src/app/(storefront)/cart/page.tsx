import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { CartView } from "@/components/commerce/cart-view";
import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon } from "@/components/ui/icons";
import { getOptionalUser, type SessionUser } from "@/lib/auth/guards";
import { getCartWithCoupon } from "@/lib/coupons/service";
import { fetchActiveCoupons } from "@/lib/format/server-data";

/**
 * The cart page.
 *
 * ── The rules that govern this page ──────────────────────────────────────
 *
 * **1. A signed-out visitor is offered a sign-in, not an error.**
 *
 * The cart belongs to a user, so a visitor without a session cannot
 * have one. A 401 on this page would be technically true and useless:
 * the customer clicked "Add to cart" and got told they were wrong.
 * Instead the page explains what a cart is for and points them at the
 * sign-in.
 *
 * **2. The cart is read on the server.**
 *
 * `getCart` is called directly, not over HTTP. The same reasoning as
 * the catalogue pages applies: no base URL, no round-trip, one
 * implementation of the cart's arithmetic.
 *
 * **3. The session is read at the top of the page.**
 *
 * This page is **request-time**, and it says so with `await
 * connection()`. That is not a workaround — it is the correct model
 * for a page whose content depends on who is asking.
 *
 * The reason it matters: a session read goes through `cookies()`, which
 * is a *dynamic* API. Under Cache Components, a dynamic read inside a
 * `<Suspense>` boundary defers that boundary indefinitely — the
 * fallback is sent, and the real content never arrives. The customer
 * would be left staring at a skeleton that never resolves.
 *
 * So the session is read **outside** the boundary, where the framework
 * can see that the page is dynamic and render it at request time. The
 * cart itself — the database read — still streams behind the boundary,
 * because a database read does defer cleanly.
 */

/**
 * The page metadata.
 */
export const metadata: Metadata = {
  title: "Your Cart",
  description:
    "Review the products in your cart before checking out — cash on delivery available nationwide.",
};

/**
 * This route is allowed to block.
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 *
 * The cart belongs to a user, so the page cannot be prerendered: it
 * depends on who is asking. Under Cache Components a route that reads
 * the session has to declare that it may block, with
 * `export const instant = false`.
 *
 * The alternative — reading the session inside the `<Suspense>`
 * boundary — is worse, and it fails in a way that is easy to miss. A
 * dynamic read inside a boundary defers that boundary indefinitely:
 * the fallback is sent and the real content never arrives. The
 * customer is left looking at a skeleton that never resolves, and the
 * page still returns a `200`.
 *
 * So the session is read at the top of the page, and the cart itself —
 * a database read, which defers cleanly — streams behind the
 * boundary.
 */
export const instant = false;

/**
 * The props for the cart page.
 */
export type CartPageProps = {
  /**
   * The query string.
   *
   * Read for `?coupon=CODE` — the announcement bar links to the cart
   * with the code in the query string, so the discount field opens with
   * the code already in it and the customer presses apply.
   */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The cart page.
 */
export default async function CartPage({ searchParams }: CartPageProps) {
  // This page depends on who is asking, so it is rendered at request
  // time. The session is read here — outside the `<Suspense>`
  // boundary — so the framework knows the page is dynamic.
  await connection();

  const user = await getOptionalUser();

  const params = await searchParams;
  const rawCoupon = params.coupon;
  const suggestedCode =
    typeof rawCoupon === "string" && rawCoupon.trim().length > 0
      ? rawCoupon.trim().toUpperCase()
      : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
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
            <span aria-current="page" className="font-medium text-foreground">
              Your Cart
            </span>
          </li>
        </ol>
      </nav>

      <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        Your Cart
      </h1>

      <div className="mt-6">
        <Suspense fallback={<CartSkeleton />}>
          <CartBody user={user} suggestedCode={suggestedCode} />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * The cart body.
 *
 * Reads the cart, then renders one of three states: the cart, the
 * empty cart, or the signed-out prompt.
 */
async function CartBody({
  user,
  suggestedCode,
}: {
  readonly user: SessionUser | null;
  readonly suggestedCode: string | null;
}) {
  if (!user) {
    return <SignedOut />;
  }

  /*
   * The cart is read **with its coupon resolved**.
   *
   * `getCartWithCoupon` is the single read path for a cart that a
   * customer is about to be charged for: it reads the cart, resolves the
   * code that is on it, and returns the discount the server will apply.
   * The cart page and the checkout page both use it, so the two screens
   * cannot show different discounts for the same basket.
   */
  const cart = await getCartWithCoupon(user.id).catch((error: unknown) => {
    console.error("[storefront] Cart load failed:", error);
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
    return <EmptyCart />;
  }

  /*
   * The live codes, for the helper.
   *
   * Read alongside the cart rather than inside it: the cart's arithmetic
   * is the cart's business, and the list of campaigns is the shop
   * floor's. This fetch never throws — a failed coupon query leaves the
   * cart working and the helper simply has nothing to list.
   */
  const { coupons } = await fetchActiveCoupons();

  return (
    <CartView
      cart={cart}
      coupons={coupons}
      suggestedCode={suggestedCode}
    />
  );
}

/**
 * The signed-out state.
 *
 * A cart is tied to an account, so the page explains why a session is
 * needed and offers the way in. It does not pretend the cart is empty
 * — an empty cart and a signed-out cart are different states, and the
 * customer should not be told their basket vanished.
 */
function SignedOut() {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
      <h2 className="text-base font-semibold text-foreground">
        Sign in to see your cart
      </h2>

      <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
        Your cart is saved to your account, so you can pick up where you
        left off on any device.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink href="/login" variant="primary" size="sm">
          Sign in
        </ButtonLink>

        <ButtonLink href="/products" variant="outline" size="sm">
          Browse the catalogue
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * The empty cart.
 */
function EmptyCart() {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
      <h2 className="text-base font-semibold text-foreground">
        Your cart is empty
      </h2>

      <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
        Nothing here yet. Start with a bestseller, or browse by what your
        skin needs.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink href="/products" variant="primary" size="sm">
          Start shopping
        </ButtonLink>

        <ButtonLink href="/products?isBestSeller=true" variant="outline" size="sm">
          See best sellers
        </ButtonLink>
      </div>
    </div>
  );
}

/**
 * The placeholder shown while the cart loads.
 */
function CartSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex gap-4 border-b border-border pb-4">
            <div className="h-24 w-20 animate-pulse rounded-xl bg-surface-muted" />
            <div className="flex-1">
              <div className="h-3 w-24 animate-pulse rounded-full bg-surface-muted" />
              <div className="mt-2 h-4 w-3/5 animate-pulse rounded-full bg-surface-muted" />
              <div className="mt-4 h-9 w-28 animate-pulse rounded-full bg-surface-muted" />
            </div>
          </div>
        ))}
      </div>

      <div className="h-72 animate-pulse rounded-[var(--radius-card)] bg-surface-muted" />
    </div>
  );
}
