"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { QuantitySelector } from "@/components/commerce/quantity-selector";
import { useCartDrawer } from "@/components/commerce/cart-drawer-provider";
import { useAddToCart } from "@/components/commerce/use-add-to-cart";
import { Button } from "@/components/ui/button";
import { CartIcon, CheckIcon, WarningIcon } from "@/components/ui/icons";

/**
 * The buy panel.
 *
 * ── What this component is responsible for ───────────────────────────────
 *
 * The quantity, the "Add to Bag" button, the "Buy Now" button, and the
 * sticky mobile bar that carries them.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. "Buy Now" adds to the cart and then goes to the cart.**
 *
 * It is not a separate checkout. The checkout service builds the order
 * from the cart, so a "Buy Now" that jumped straight to checkout would
 * have to build a cart first anyway. Doing it here — add, then
 * navigate — means the order is built from exactly the same cart the
 * customer can go back and check.
 *
 * **2. The mobile bar is fixed, and it carries the quantity.**
 *
 * On a phone the purchase controls sit at the bottom of the screen
 * while the customer scrolls the description, the ingredients and the
 * reviews. That bar is `position: fixed` — a `sticky` bar inside the
 * buy-box column would stop sticking the moment the column ended,
 * which is exactly where the customer starts reading the ingredients.
 *
 * The bar carries the **quantity selector** as well as the two
 * buttons. The inline panel is hidden on mobile, so a bar with only
 * buttons would leave no way to choose a quantity at all: the customer
 * would have to add one, open the drawer, and change it there.
 *
 * **3. It sits above the bottom navigation.**
 *
 * The site's tab bar is `fixed` at the bottom of the viewport on
 * mobile. The purchase bar is `fixed` too, so they would overlap. The
 * bar is offset by the tab bar's height and given a higher `z-index`,
 * so the two stack: tab bar at the very bottom, purchase bar above it.
 *
 * **4. The conflict warning is shown here too.**
 *
 * The cart API adds the item and reports the conflict. If the only
 * place that warning appeared was the product card, a customer who
 * used the mobile bar would never see it. So the panel owns the
 * conflict display, and it persists for six seconds.
 *
 * **4. A `BLOCK` conflict does not stop the purchase.**
 *
 * The platform's job is to make the customer aware, not to decide for
 * them. The warning says what the interaction is and what to do about
 * it.
 *
 * ── Where the banner's lifetime lives ────────────────────────────────────
 *
 * The banner must appear the moment a conflict arrives and disappear
 * after a few seconds. That is state, and it belongs with the rest of
 * the attempt's state — so the deadline lives in `useAddToCart` and the
 * visibility is derived from it here. See the hook for why a ref
 * holding a deadline does not work.
 */
export type BuyPanelProps = {
  readonly productId: string;
  readonly stockQuantity: number;
  readonly inStock: boolean;
};

/**
 * How long the "Added" confirmation stays on screen.
 */
const CONFIRMATION_MS = 1800;

export function BuyPanel({
  productId,
  stockQuantity,
  inStock,
}: BuyPanelProps) {
  const router = useRouter();
  const { addItem } = useCartDrawer();

  const [quantity, setQuantity] = useState(1);
  const [isBuyingNow, setIsBuyingNow] = useState(false);

  const {
    isPending,
    isAdded,
    error,
    conflicts,
    hasBlockingConflict,
    conflictExpiresAt,
    addToCart,
    reset,
  } = useAddToCart({
    // The shared cart performs the request, so the header badge and
    // the drawer reflect the addition immediately.
    add: addItem,
  });

  // The quantity is clamped during render rather than synced in an
  // effect. The stock can only decrease while the page is open, so the
  // clamp is a *derivation* of the stock and the chosen quantity — and
  // deriving it in an effect would show the customer a quantity they
  // can no longer buy for one frame.
  const maxQuantity = Math.max(1, Math.min(stockQuantity, 10));
  const effectiveQuantity = Math.min(Math.max(quantity, 1), maxQuantity);

  useEffect(() => {
    if (!isAdded) return;

    const timer = window.setTimeout(() => {
      reset();
    }, CONFIRMATION_MS);

    return () => window.clearTimeout(timer);
  }, [isAdded, reset]);

  const handleAdd = useCallback(async () => {
    await addToCart(productId, effectiveQuantity);
  }, [addToCart, productId, effectiveQuantity]);

  const handleBuyNow = useCallback(async () => {
    setIsBuyingNow(true);

    // "Buy Now" goes to the cart, so the drawer must not also open —
    // the customer would land on the cart page with a drawer sliding
    // over it. `openDrawer: false` suppresses it.
    const succeeded = await addToCart(productId, effectiveQuantity, {
      openDrawer: false,
    });

    setIsBuyingNow(false);

    if (succeeded) {
      router.push("/cart");
    }
  }, [addToCart, productId, effectiveQuantity, router]);

  const isOutOfStock = !inStock || stockQuantity <= 0;
  const isBusy = isPending || isBuyingNow;

  const showConflict = hasBlockingConflict && conflictExpiresAt !== null;

  /**
   * The conflict banner.
   *
   * Rendered in both the inline panel and the mobile bar, so it is
   * built once and placed twice. The customer must see the warning
   * whichever control they used.
   *
   * The margin is a prop because the two placements want different
   * spacing: the inline panel needs a gap below the buttons, and the
   * mobile bar sits in its own padded wrapper.
   */
  const conflictBanner = showConflict ? (
    <div
      role="alert"
      className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <WarningIcon width={14} height={14} className="shrink-0" />
        Added — with a caution
      </p>

      {conflicts.map((conflict) => (
        <p key={conflict.ruleId} className="mt-1.5 leading-relaxed">
          <span className="font-medium">{conflict.title}.</span>{" "}
          {conflict.message} {conflict.remedy}
        </p>
      ))}
    </div>
  ) : null;

  const controls = (
    <>
      <div className="flex items-center gap-4">
        <QuantitySelector
          value={effectiveQuantity}
          onChange={setQuantity}
          stockQuantity={stockQuantity}
        />

        <span className="text-xs text-foreground-muted">
          {isOutOfStock
            ? "Unavailable"
            : stockQuantity <= 5
              ? `Only ${stockQuantity} left`
              : "In stock"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Button
          size="lg"
          variant="primary"
          fullWidth
          disabled={isBusy || isOutOfStock}
          onClick={() => {
            void handleAdd();
          }}
          className={isAdded ? "bg-emerald-600 shadow-none hover:bg-emerald-600" : undefined}
        >
          {isOutOfStock ? null : isAdded ? (
            <CheckIcon width={16} height={16} />
          ) : isPending ? (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          ) : null}

          {isOutOfStock
            ? "Out of Stock"
            : isAdded
              ? "Added to Bag"
              : isPending
                ? "Adding…"
                : "Add to Bag"}
        </Button>

        <Button
          size="lg"
          variant="dark"
          fullWidth
          disabled={isBusy || isOutOfStock}
          onClick={() => {
            void handleBuyNow();
          }}
        >
          {isBuyingNow ? (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          ) : (
            <CartIcon width={16} height={16} />
          )}

          {isBuyingNow ? "Going to cart…" : "Buy Now"}
        </Button>
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-xs text-red-600"
        >
          <WarningIcon width={14} height={14} className="mt-0.5" />
          <span>{error}</span>
        </p>
      ) : null}

      {conflictBanner ? <div className="mt-2">{conflictBanner}</div> : null}
    </>
  );

  return (
    <>
      {/* ── The inline panel ─────────────────────────────────────────── */}
      <div className="hidden space-y-4 lg:block">{controls}</div>

      {/*
       * ── The mobile purchase bar ────────────────────────────────────
       *
       * `fixed`, not `sticky`. A sticky element inside the buy-box
       * column stops being sticky when that column scrolls out of the
       * containing block — which is precisely where the customer
       * starts reading the ingredients and the reviews. A purchase bar
       * that vanishes halfway down the page is not a purchase bar.
       *
       * It sits above the site's bottom tab bar, which is also
       * `fixed` at the bottom of the viewport. The bar reserves the
       * tab bar's height in its own bottom padding, so the two stack
       * rather than overlap — the tab bar at the very bottom of the
       * screen, the purchase bar directly above it.
       *
       * The `z-50` puts the purchase bar above the tab bar's `z-40`.
       * Both are `fixed` and both sit at `bottom-0`, so without the
       * higher z-index the tab bar would paint over the buttons.
       *
       * The quantity selector is here, not just the buttons — the
       * inline panel is `hidden` on mobile, so this is the only place
       * a phone customer can choose a quantity.
       */}
      <div className="fixed inset-x-0 bottom-0 z-50 lg:hidden">
        {/* The conflict banner. It sits above the bar rather than
            inside it, so the banner is readable and the bar keeps its
            height when the banner appears and disappears. */}
        {conflictBanner ? (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-2.5">
            {conflictBanner}
          </div>
        ) : null}

        <div className="border-t border-border bg-surface/95 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-3 backdrop-blur-md">
          <div className="flex items-center gap-3 px-4">
            <QuantitySelector
              value={effectiveQuantity}
              onChange={setQuantity}
              stockQuantity={stockQuantity}
              className="scale-90 origin-left"
            />

            <div className="grid flex-1 grid-cols-2 gap-2.5">
              <Button
                size="md"
                variant="primary"
                fullWidth
                disabled={isBusy || isOutOfStock}
                onClick={() => {
                  void handleAdd();
                }}
                className={
                  isAdded
                    ? "bg-emerald-600 shadow-none hover:bg-emerald-600"
                    : undefined
                }
              >
                {isOutOfStock ? null : isAdded ? (
                  <CheckIcon width={16} height={16} />
                ) : isPending ? (
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  />
                ) : null}

                {isOutOfStock
                  ? "Out of Stock"
                  : isAdded
                    ? "Added"
                    : isPending
                      ? "Adding…"
                      : "Add to Bag"}
              </Button>

              <Button
                size="md"
                variant="dark"
                fullWidth
                disabled={isBusy || isOutOfStock}
                onClick={() => {
                  void handleBuyNow();
                }}
              >
                {isBuyingNow ? (
                  <span
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                  />
                ) : (
                  <CartIcon width={16} height={16} />
                )}

                {isBuyingNow ? "Going…" : "Buy Now"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
