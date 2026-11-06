"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { CouponBox } from "@/components/commerce/coupon-box";
import { QuantitySelector } from "@/components/commerce/quantity-selector";
import { ButtonLink } from "@/components/ui/button";
import { TrashIcon } from "@/components/ui/icons";
import { Price } from "@/components/ui/price";
import { ProductImage } from "@/components/ui/product-image";
import type { CartLine, CartView } from "@/lib/cart/service";
import { formatPaisa } from "@/lib/format/money";
import type { PublicCoupon } from "@/lib/format/types";

/**
 * The cart.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The server owns the money; the client owns the interaction.**
 *
 * Every total on this screen — the line total, the subtotal, the
 * delivery charge — is computed by the server and rendered as it was
 * received. The client never re-derives a price, because the server is
 * the one that charges the card. A cart that shows ৳2,499 and then
 * charges ৳2,599 is worse than a cart that cannot be edited.
 *
 * So the client sends a *quantity* and the server answers with a
 * *cart*. The whole cart is replaced, not patched, because a single
 * change can affect the ingredient conflicts and the totals of every
 * other line.
 *
 * **2. A failed change leaves the cart as it was.**
 *
 * The `useTransition` flag drives the pending state. When the request
 * fails, the error is shown and the cart is left exactly as the server
 * last confirmed it. The client never optimistically removes a line —
 * an optimistic removal that the server rejects leaves the customer
 * looking at a cart that is not real.
 *
 * **3. A blocking conflict is a warning, not a wall.**
 *
 * The cart service already decided this: a `BLOCK` conflict still
 * allows the customer to proceed, because they are told and they
 * decide. The cart page says so plainly and offers the remedy.
 */

/**
 * The props for the cart.
 */
export type CartViewProps = {
  readonly cart: CartView;
  /**
   * The discount codes that are live right now.
   *
   * The cart lists them so a customer who has seen a campaign can find
   * the code without having to remember it.
   */
  readonly coupons?: readonly PublicCoupon[];
  /**
   * A code to pre-fill the discount field with.
   *
   * The announcement bar links here with `?coupon=CODE`, and the code
   * arrives already in the field.
   */
  readonly suggestedCode?: string | null;
};

export function CartView({
  cart,
  coupons = [],
  suggestedCode,
}: CartViewProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  /**
   * Sends a change to the server and replaces the cart with the answer.
   *
   * `onSettled` runs after the request finishes, whether it succeeded
   * or not. It exists because `startTransition` returns `void` — the
   * transition's promise is not exposed — so a caller that needs to
   * clear a "this row is busy" flag has to be told when the work is
   * over rather than awaiting it.
   */
  function applyChange(
    request: () => Promise<{ ok: boolean; error?: { message: string } }>,
    onSettled?: () => void,
  ): void {
    startTransition(async () => {
      setError(null);

      try {
        const response = await request();

        if (!response.ok) {
          setError(response.error?.message ?? "We could not update your cart.");
          return;
        }

        // The server has the authority on the cart's contents, so the
        // page is refreshed from it rather than patched locally.
        router.refresh();
      } catch {
        setError("We could not reach the server. Your cart is unchanged.");
      } finally {
        onSettled?.();
      }
    });
  }

  function changeQuantity(line: CartLine, quantity: number): void {
    applyChange(async () => {
      const response = await fetch(`/api/cart/items/${line.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity }),
      });

      return (await response.json()) as {
        ok: boolean;
        error?: { message: string };
      };
    });
  }

  function removeLine(line: CartLine): void {
    setRemovingId(line.id);

    applyChange(
      async () => {
        const response = await fetch(`/api/cart/items/${line.id}`, {
          method: "DELETE",
        });

        return (await response.json()) as {
          ok: boolean;
          error?: { message: string };
        };
      },
      () => {
        setRemovingId(null);
      },
    );
  }

  const blockingConflicts = cart.conflicts.filter(
    (conflict) => conflict.severity === "BLOCK",
  );
  const warningConflicts = cart.conflicts.filter(
    (conflict) => conflict.severity === "WARN",
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      {/* ── The lines ─────────────────────────────────────────────────── */}
      <div>
        {error ? (
          <div
            role="status"
            className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
          >
            {error}
          </div>
        ) : null}

        <ul className="divide-y divide-border border-y border-border">
          {cart.items.map((line) => (
            <li
              key={line.id}
              className="flex gap-3 py-4 sm:gap-4"
              aria-busy={isPending && removingId === line.id}
            >
              <Link
                href={`/products/${line.product.id}`}
                className="shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                <div className="h-20 w-16 overflow-hidden rounded-xl bg-surface-muted sm:h-24 sm:w-20">
                  <ProductImage
                    images={line.product.images}
                    name={line.product.name}
                    categoryName={line.product.category.name}
                    sizes="80px"
                  />
                </div>
              </Link>

              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-brand-600">
                  {line.product.category.name}
                </p>

                <h3 className="mt-0.5 text-sm font-medium leading-snug text-foreground">
                  <Link
                    href={`/products/${line.product.id}`}
                    className="line-clamp-2 transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:text-brand-700"
                  >
                    {line.product.name}
                  </Link>
                </h3>

                {line.exceedsStock ? (
                  <p className="mt-1 text-xs font-medium text-amber-600">
                    Only {line.product.stockQuantity} left — please reduce the
                    quantity
                  </p>
                ) : null}

                <div className="mt-2.5 flex flex-wrap items-center gap-3">
                  <QuantitySelector
                    value={line.quantity}
                    onChange={(quantity) => changeQuantity(line, quantity)}
                    stockQuantity={line.product.stockQuantity}
                    className="scale-90 origin-left"
                  />

                  <button
                    type="button"
                    onClick={() => removeLine(line)}
                    disabled={isPending && removingId === line.id}
                    className="inline-flex items-center gap-1 text-xs font-medium text-foreground-muted transition-colors hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <TrashIcon width={14} height={14} />
                    Remove
                    <span className="sr-only"> {line.product.name}</span>
                  </button>
                </div>
              </div>

              <div className="shrink-0 text-right">
                <Price
                  pricePaisa={line.unitPricePaisa}
                  discountPricePaisa={
                    line.product.discountPricePaisa !== null &&
                    line.product.discountPricePaisa < line.product.pricePaisa
                      ? line.product.discountPricePaisa
                      : null
                  }
                  size="sm"
                />

                <p className="mt-1 text-sm font-semibold text-foreground">
                  {formatPaisa(line.lineTotalPaisa)}
                </p>

                {line.quantity > 1 ? (
                  <p className="mt-0.5 text-[11px] text-foreground-muted">
                    {formatPaisa(line.unitPricePaisa)} each
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <Link
          href="/products"
          className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-brand-700 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Continue shopping
        </Link>
      </div>

      {/* ── The summary ──────────────────────────────────────────────── */}
      <aside className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)] lg:sticky lg:top-24">
        <h2 className="text-sm font-bold text-foreground">Order summary</h2>

        <dl className="mt-4 space-y-2.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-foreground-muted">
              Subtotal ({cart.totalQuantity}{" "}
              {cart.totalQuantity === 1 ? "item" : "items"})
            </dt>
            <dd className="font-medium tabular-nums text-foreground">
              {formatPaisa(cart.subtotalPaisa)}
            </dd>
          </div>

          {/*
            The discount line.

            It appears only when a code is applied, because a discount row
            reading "৳0" is noise — it makes the customer look for a
            discount that is not there.

            The figure is the **server's**. The client never re-derives
            what a code is worth.
          */}
          {cart.coupon && cart.coupon.discountPaisa > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-foreground-muted">
                Discount
                <span className="ml-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
                  {cart.coupon.code}
                </span>
              </dt>
              <dd className="font-medium tabular-nums text-brand-700 dark:text-brand-300">
                −{formatPaisa(cart.coupon.discountPaisa)}
              </dd>
            </div>
          ) : null}

          <div className="flex justify-between gap-4">
            <dt className="text-foreground-muted">Delivery</dt>
            <dd className="font-medium tabular-nums text-foreground">
              Calculated at checkout
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex items-baseline justify-between gap-4 border-t border-border pt-4">
          <span className="text-sm font-semibold text-foreground">Total</span>
          <span className="text-lg font-bold tabular-nums text-foreground">
            {/*
              The total the customer will pay for the **goods**, after
              the discount. Delivery is not included — it is charged at
              checkout, and the server adds it there. So this is not a
              guess at the final amount; it is the same arithmetic the
              server does, minus the shipping it has not added yet.
            */}
            {formatPaisa(
              cart.subtotalPaisa - (cart.coupon?.discountPaisa ?? 0),
            )}
          </span>
        </div>

        <p className="mt-1.5 text-[11px] text-foreground-muted">
          Cash on delivery available nationwide. Delivery is charged at
          checkout.
        </p>

        {/* ── The discount code helper ─────────────────────────────── */}
        <CouponBox
          applied={cart.coupon}
          available={coupons}
          suggestedCode={suggestedCode}
        />

        <div className="mt-5">
          <ButtonLink href="/checkout" variant="primary" size="lg" fullWidth>
            Proceed to checkout
          </ButtonLink>
        </div>

        <div className="mt-3">
          <ButtonLink href="/products" variant="outline" size="md" fullWidth>
            Keep shopping
          </ButtonLink>
        </div>

        {/* ── The conflicts ─────────────────────────────────────────── */}
        {blockingConflicts.length > 0 ? (
          <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-red-700">
              Check this combination
            </h3>

            <ul className="mt-2 space-y-3">
              {blockingConflicts.map((conflict) => (
                <li key={conflict.ruleId}>
                  <p className="text-xs font-semibold text-red-800">
                    {conflict.title}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-red-700">
                    {conflict.message}
                  </p>
                  <p className="mt-1 text-[11px] font-medium text-red-800">
                    {conflict.remedy}
                  </p>
                </li>
              ))}
            </ul>

            <p className="mt-3 text-[11px] leading-relaxed text-red-700">
              You can still check out — we are telling you, not stopping you.
            </p>
          </div>
        ) : null}

        {warningConflicts.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-amber-700">
              Worth knowing
            </h3>

            <ul className="mt-2 space-y-3">
              {warningConflicts.map((conflict) => (
                <li key={conflict.ruleId}>
                  <p className="text-xs font-semibold text-amber-800">
                    {conflict.title}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-amber-700">
                    {conflict.message}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
