"use client";

import { useEffect } from "react";

import { useCartDrawer } from "@/components/commerce/cart-drawer-provider";
import { Button } from "@/components/ui/button";
import {
  CheckIcon,
  ShoppingBagIcon,
  WarningIcon,
} from "@/components/ui/icons";

import { useAddToCart } from "./use-add-to-cart";

/**
 * The add-to-cart button.
 *
 * ── What this component is responsible for ───────────────────────────────
 *
 * It owns the interaction, and it is the only place the customer
 * learns that an ingredient conflict was created. A `BLOCK` conflict
 * does not stop the add — the cart API adds the item and reports the
 * conflict — so the button has to be the thing that *shows* it.
 *
 * The states, in order:
 *
 *   • idle      — "Add to Cart"
 *   • pending   — a spinner, and the button is disabled
 *   • added     — "Added ✓", reverting to idle after a moment
 *   • blocked   — the item was added, but a `BLOCK` conflict was found
 *   • errored   — the message from the API, in place of the label
 *
 * The last two are the important ones, and they are the reason this is
 * a component and not a `<form>`.
 *
 * ── Why the button uses the shared cart, not its own ────────────────────
 *
 * The button adds through `useCartDrawer`, so the header's badge and
 * the drawer update from the *same* request. If the button had its own
 * fetch — as it did before the drawer existed — the badge would keep
 * showing the old count until the next page load, and the customer
 * would add three items and see "1" in the header.
 *
 * The conflict banner still belongs here, on the button, because that is
 * where the customer is looking when they add. The drawer shows the
 * conflicts too, but the button shows them *first*.
 *
 * ── Where the banner's lifetime lives ────────────────────────────────────
 *
 * The banner must appear the moment a conflict arrives and disappear
 * after a few seconds. That is state, and it belongs with the rest of
 * the attempt's state — so the deadline lives in `useAddToCart` and the
 * visibility is derived from it here. See the hook for why a ref
 * holding a deadline does not work.
 */

/**
 * The props for the button.
 */
export type AddToCartButtonProps = {
  readonly productId: string;
  /** The stock level. At zero the button is disabled. */
  readonly stockQuantity: number;
  /** The size of the button. */
  readonly size?: "sm" | "card" | "md" | "lg";
  /** Whether the button fills its container. */
  readonly fullWidth?: boolean;
  /**
   * The product's name, for the button's accessible name.
   *
   * The visible label is the same on every screen, but the accessible
   * name is always the full sentence — "Add CeraVe Hydrating Cleanser to
   * cart" — because "Add to Cart" on its own tells a screen-reader user
   * *which* product they are adding nothing about. The id alone is
   * useless to them; it is an opaque identifier.
   */
  readonly productName?: string;
  /** Called after a successful addition. */
  readonly onAdded?: () => void;
};

/**
 * How long the "Added" confirmation stays on screen.
 */
const CONFIRMATION_MS = 1800;

export function AddToCartButton({
  productId,
  stockQuantity,
  size = "md",
  fullWidth = false,
  productName,
  onAdded,
}: AddToCartButtonProps) {
  const { addItem } = useCartDrawer();

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
    // The provider performs the request, so the header badge and the
    // drawer are updated from the *same* response that the button
    // received. Two independent fetches would eventually disagree.
    add: addItem,
    onAdded: () => {
      onAdded?.();
    },
  });

  useEffect(() => {
    if (!isAdded) return;

    const timer = window.setTimeout(() => {
      reset();
    }, CONFIRMATION_MS);

    return () => window.clearTimeout(timer);
  }, [isAdded, reset]);

  const isOutOfStock = stockQuantity <= 0;

  const showConflict = hasBlockingConflict && conflictExpiresAt !== null;

  /*
    The label.

    "Add to Cart" is the **full** statement of the action, and it is the
    label the button carries wherever it fits. The bare "Add" that used
    to sit on a grid card was a compromise made to protect the price's
    alignment — and it cost more than it bought, because a shopper
    reading "Add" has to work out *what* is being added. The icon
    carries the meaning; the words carry it too, wherever there is
    room.

    So the idle label is rendered **twice**, and the breakpoint picks
    one: "Add" on a two-column phone grid, "Add to Cart" from `sm`
    upward, where the grid is three or four columns wide and the card
    has the room.

    Two spans rather than one string, because the *width* of the label
    is what decides whether the button can share its row with the
    price. A string that changes at a breakpoint would change the
    button's measured width at the same moment — and the button's width
    is exactly what the price has to give way to. Rendering both and
    toggling them keeps the layout decision explicit and CSS-driven,
    with no JavaScript and no hydration to keep in step.

    The **status** labels are not responsive: "Adding…", "Added" and
    "Out of Stock" are short, and they are the states a shopper is
    actually watching for.
  */
  const isIdle = !isOutOfStock && !isPending && !isAdded;

  const statusLabel = isOutOfStock
    ? "Out of Stock"
    : isPending
      ? "Adding…"
      : isAdded
        ? "Added"
        : null;

  /*
    The accessible name.

    It is set only in the **idle** state, and only when the caller
    supplied the product's name. Three reasons:

      • In the idle state the visible label is "Add to Cart" (or "Add"),
        which says *what* the button does but not *which product* it
        acts on. The name supplies the rest.

      • In the pending and added states the visible label is the status
        ("Adding…", "Added"), and overwriting that with a static
        sentence would tell a screen-reader user "Add X to cart" while
        the button is visibly confirming an addition. The status is the
        more urgent information, and `aria-live` announces it.

      • On an out-of-stock button the action sentence is a lie — there
        is nothing to add.
  */
  const accessibleLabel =
    isIdle && productName ? `Add ${productName} to cart` : undefined;

  return (
    <div className="relative">
      <Button
        size={size}
        fullWidth={fullWidth}
        disabled={isPending || isOutOfStock}
        aria-live="polite"
        aria-label={accessibleLabel}
        onClick={() => {
          void addToCart(productId, 1);
        }}
        className={
          isAdded ? "bg-emerald-600 shadow-none hover:bg-emerald-600" : undefined
        }
      >
        {isOutOfStock ? null : isAdded ? (
          <CheckIcon width={16} height={16} />
        ) : isPending ? (
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
          />
        ) : (
          <ShoppingBagIcon width={16} height={16} />
        )}

        {statusLabel !== null ? (
          statusLabel
        ) : (
          <>
            {/*
              The idle label, in two widths.

              `whitespace-nowrap` on the button keeps whichever one is
              showing on a single line — a two-line button is what
              breaks the price row's alignment, and the row's
              alignment is what keeps a grid of cards reading as a
              grid.
            */}
            <span className="hidden sm:inline">Add to Cart</span>
            <span className="sm:hidden">Add</span>
          </>
        )}
      </Button>

      {error ? (
        <p
          role="alert"
          className="mt-2 flex items-start gap-1.5 text-xs text-red-600"
        >
          <WarningIcon width={14} height={14} className="mt-0.5" />
          <span>{error}</span>
        </p>
      ) : null}

      {showConflict ? (
        <div
          role="alert"
          className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
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
      ) : null}
    </div>
  );
}
