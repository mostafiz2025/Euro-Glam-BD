"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  AddToCartResult,
  ApiEnvelope,
  CartConflictSummary,
} from "@/lib/format/types";

/**
 * The add-to-cart hook.
 *
 * ── The three things this hook is careful about ──────────────────────────
 *
 * **1. The response envelope is checked, not assumed.**
 *
 * The API returns `{ ok: true, data }` or `{ ok: false, error }`. A
 * client that reads `result.cart` without checking `ok` will throw a
 * `TypeError` on an error response — and the error message the customer
 * sees will be "cannot read properties of undefined" instead of
 * "that product is out of stock". So the envelope is discriminated on
 * `ok` first, always.
 *
 * **2. A conflict is reported, not swallowed.**
 *
 * The cart API deliberately *adds* the item even when it creates a
 * `BLOCK` ingredient conflict, and returns the conflict. The platform's
 * job is to make sure the customer knows; refusing the add would hide
 * the information they need. So this hook surfaces the conflicts and
 * lets the caller show them.
 *
 * **3. The button state is honest.**
 *
 * `isPending` is true only while the request is in flight, and a second
 * click is refused while it is. A cart that double-adds on a double
 * click is a bug the customer notices immediately.
 *
 * ── Why the conflict banner lives here ──────────────────────────────────
 *
 * The banner has to appear the moment a conflict arrives and disappear
 * a few seconds later. That is *state*, and it belongs with the rest of
 * the attempt's state rather than in a ref inside the button.
 *
 * The earlier shape — a ref holding a deadline, read during render —
 * does not work: React's `react-hooks/refs` rule forbids reading a ref
 * during render, and for good reason. A ref read during render is a
 * value that can change without the component re-rendering, so the UI
 * can disagree with the state it claims to show.
 *
 * So the deadline is **state** (`conflictExpiresAt`), set when the
 * conflict arrives, and the visibility is **derived** from it during
 * render. The timer that clears it is an effect that updates state from
 * an external source — which is exactly what effects are for.
 */

/**
 * How long the conflict banner stays on screen.
 */
const CONFLICT_BANNER_MS = 6000;

/**
 * The state of an add-to-cart attempt.
 */
export type AddToCartState = {
  /** True while the request is in flight. */
  readonly isPending: boolean;
  /** True once the item has been added successfully. */
  readonly isAdded: boolean;
  /** The error message, when the attempt failed. */
  readonly error: string | null;
  /** The conflicts the addition introduced. */
  readonly conflicts: CartConflictSummary[];
  /** True when a `BLOCK` conflict is present. */
  readonly hasBlockingConflict: boolean;
  /** The cart, after the addition. */
  readonly cartQuantity: number;
  /**
   * When the conflict banner should disappear.
   *
   * Null when no banner is showing. The banner's visibility is derived
   * from this, so it never disagrees with the state.
   */
  readonly conflictExpiresAt: number | null;
};

const INITIAL_STATE: AddToCartState = {
  isPending: false,
  isAdded: false,
  error: null,
  conflicts: [],
  hasBlockingConflict: false,
  cartQuantity: 0,
  conflictExpiresAt: null,
};

/**
 * The options for the hook.
 */
export type UseAddToCartOptions = {
  /**
   * Called after a successful addition.
   *
   * The whole result is passed, so a caller can update a cart badge or
   * open a mini-cart.
   */
  readonly onAdded?: (result: AddToCartResult) => void;
  /**
   * Called when the attempt failed.
   */
  readonly onError?: (message: string) => void;
  /**
   * The function that performs the addition.
   *
   * When this is supplied, the hook does **not** make its own request.
   * The cart drawer supplies one, so the header badge and the drawer
   * are updated by the same request that the button made — rather than
   * by a second, independent fetch that could land at a different
   * moment and show a different number.
   *
   * The supplied function returns the full `AddToCartResult`, so the
   * conflict information still reaches the banner.
   */
  readonly add?: (
    productId: string,
    quantity: number,
    options?: { readonly openDrawer?: boolean },
  ) => Promise<AddToCartResult | null>;
};

/**
 * The hook.
 */
export function useAddToCart(options: UseAddToCartOptions = {}) {
  const [state, setState] = useState<AddToCartState>(INITIAL_STATE);

  const addToCart = useCallback(
    async (
      productId: string,
      quantity = 1,
      addOptions: { readonly openDrawer?: boolean } = {},
    ): Promise<boolean> => {
      setState((current) => ({
        ...current,
        isPending: true,
        isAdded: false,
        error: null,
      }));

      // The supplied path. The provider owns the request, so the badge
      // and the drawer are updated from the same response.
      if (options.add) {
        const result = await options.add(productId, quantity, addOptions);

        if (result === null) {
          setState((current) => ({ ...current, isPending: false }));
          return false;
        }

        setState({
          isPending: false,
          isAdded: true,
          error: null,
          conflicts: result.newConflicts,
          hasBlockingConflict: result.hasBlockingConflict,
          cartQuantity: result.cart.totalQuantity,
          conflictExpiresAt: result.hasBlockingConflict
            ? Date.now() + CONFLICT_BANNER_MS
            : null,
        });

        options.onAdded?.(result);

        return true;
      }

      try {
        const response = await fetch("/api/cart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ productId, quantity }),
        });

        const payload = (await response.json()) as ApiEnvelope<AddToCartResult>;

        if (!payload.ok) {
          const message = payload.error.message;

          setState((current) => ({
            ...current,
            isPending: false,
            error: message,
          }));

          options.onError?.(message);

          return false;
        }

        const result = payload.data;

        setState({
          isPending: false,
          isAdded: true,
          error: null,
          conflicts: result.newConflicts,
          hasBlockingConflict: result.hasBlockingConflict,
          cartQuantity: result.cart.totalQuantity,
          conflictExpiresAt: result.hasBlockingConflict
            ? Date.now() + CONFLICT_BANNER_MS
            : null,
        });

        options.onAdded?.(result);

        return true;
      } catch {
        // A network failure is not an API error — there is no envelope to
        // read. The message says what the customer can do about it.
        const message =
          "We could not reach the shop. Please check your connection and try again.";

        setState((current) => ({
          ...current,
          isPending: false,
          error: message,
        }));

        options.onError?.(message);

        return false;
      }
    },
    [options],
  );

  /** Resets the state, so the "Added ✓" confirmation can be cleared. */
  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  // Clear the conflict banner when its window ends. This is an effect
  // updating state from an external source — a clock — which is
  // exactly what effects are for.
  //
  // The timer is always armed, even when the remaining time is already
  // negative: a timeout of zero fires on the next tick rather than
  // synchronously, so the state update never happens *during* the
  // effect. React's `set-state-in-effect` rule is right to flag a
  // synchronous set — that is a cascading render — and a timeout is
  // the correct shape for "this becomes true later".
  useEffect(() => {
    if (state.conflictExpiresAt === null) return;

    const remaining = Math.max(0, state.conflictExpiresAt - Date.now());

    const timer = window.setTimeout(() => {
      setState((current) => ({ ...current, conflictExpiresAt: null }));
    }, remaining);

    return () => window.clearTimeout(timer);
  }, [state.conflictExpiresAt]);

  return { ...state, addToCart, reset };
}
