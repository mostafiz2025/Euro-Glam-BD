"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { AddToCartResult, ApiEnvelope } from "@/lib/format/types";
import type { CartView } from "@/lib/cart/service";

/**
 * The cart drawer provider.
 *
 * ── Why the cart lives in a context ──────────────────────────────────────
 *
 * A cart drawer needs to be reachable from everywhere — the header icon,
 * the "Add to Bag" button on a product card, the buy panel on the product
 * page — and all of them need to agree on what is in the cart and how
 * many items there are.
 *
 * Without a shared owner, the header badge and the drawer would each
 * fetch the cart independently, and the two would disagree: the badge
 * says "2" and the drawer says "3", because one was fetched before the
 * other. That is the classic bug of duplicated state, and it is exactly
 * the bug a shared provider removes.
 *
 * So there is **one** cart state, and the header badge, the drawer and
 * the add-to-cart buttons all read it.
 *
 * ── The rules that govern this provider ─────────────────────────────────
 *
 * **1. The server owns the cart.**
 *
 * The client never assembles a cart. It sends a request — "add this",
 * "set this quantity", "remove this" — and the server answers with the
 * whole cart. A client that patched its own cart locally would drift
 * from the server's view of stock and conflicts, and the customer would
 * be shown a cart the server will not honour.
 *
 * **2. A failed request leaves the cart exactly as it was.**
 *
 * The state is replaced only on success. There is no optimistic update
 * here, because an optimistic removal that the server rejects leaves the
 * customer looking at a cart that is not real.
 *
 * **3. The drawer opens after an add.**
 *
 * That is the behaviour of a modern shopping app, and it is the reason
 * the "Add to Bag" button can be a single tap: the customer sees the
 * result immediately, without navigating away from the product they are
 * looking at.
 *
 * **4. The provider discovers the session for itself.**
 *
 * A signed-out visitor must not see a cart badge, and must not get an
 * error banner on every page of the storefront. The provider could be
 * *told* whether the visitor is signed in — but that would mean a
 * `cookies()` read in the root layout, which makes every route in the
 * app request-time and fails the build's prerender.
 *
 * So the provider asks the cart API, and the API's own answer is the
 * answer: a `401 UNAUTHENTICATED` means signed out; a cart means
 * signed in. The initial state is "unknown", not "empty" and not
 * "signed out" — the badge appears once the answer arrives, which is
 * what a signed-in visitor expects and what a signed-out visitor never
 * sees.
 */
export type CartDrawerContextValue = {
  /** The cart, or `null` when it has not been loaded. */
  readonly cart: CartView | null;
  /** Whether the cart is currently loading. */
  readonly isLoading: boolean;
  /** The error message, when the last operation failed. */
  readonly error: string | null;
  /** The number of items in the cart. */
  readonly itemCount: number;
  /** Whether the drawer is open. */
  readonly isOpen: boolean;
  /** Opens the drawer. */
  readonly open: () => void;
  /** Closes the drawer. */
  readonly close: () => void;
  /** Re-reads the cart from the server. */
  readonly refresh: () => Promise<void>;
  /**
   * Forgets the session and the cart, without touching the server.
   *
   * This is what a **logout** needs. The cookie is cleared by
   * `POST /api/auth/logout`; this clears the part of the session that
   * lives in the browser.
   *
   * Why it matters: on a shared device, the next person to sign in would
   * otherwise see the previous customer's cart in the badge and the
   * drawer — the provider's state is not scoped to the session, it is
   * scoped to the browser tab, and only the sign-out event tells the
   * two apart.
   *
   * It also closes the drawer, because a drawer full of somebody else's
   * items is not a thing to leave on screen.
   */
  readonly reset: () => void;
  /**
   * Adds a product and opens the drawer.
   *
   * Returns the full result — the cart *and* the conflicts the addition
   * introduced — so the caller can show a conflict banner without making
   * a second request. Returns `null` when the add failed.
   *
   * Pass `openDrawer: false` for an addition that is immediately
   * followed by a navigation — "Buy Now" goes to the cart, and a drawer
   * sliding over the cart page it just navigated to is a race the
   * customer loses.
   */
  readonly addItem: (
    productId: string,
    quantity?: number,
    options?: { readonly openDrawer?: boolean },
  ) => Promise<AddToCartResult | null>;
  /** Sets a line's quantity. */
  readonly setQuantity: (lineId: string, quantity: number) => Promise<boolean>;
  /** Removes a line. */
  readonly removeItem: (lineId: string) => Promise<boolean>;
};

export const CartDrawerContext = createContext<CartDrawerContextValue | null>(null);

/**
 * The provider.
 */
export function CartDrawerProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const [cart, setCart] = useState<CartView | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  /**
   * Whether the visitor has a session.
   *
   * `null` means "not known yet". It becomes `false` when the cart API
   * answers `401`, and `true` when it answers with a cart.
   */
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  /**
   * Fetches the cart and folds the answer into the state.
   *
   * This is the single place the cart is read. Both the mount effect
   * and `refresh` go through it, so the 401 handling and the error
   * message are written once — a second copy of this logic is a second
   * place for the two to disagree.
   *
   * The `cancelled` flag is the mount effect's teardown signal. A
   * response that lands after the component has unmounted must not set
   * state on a dead component.
   *
   * ── The 401 is an answer, not a failure ────────────────────────────────
   *
   * `UNAUTHENTICATED` means "nobody is signed in". That is not an
   * error the customer should see — it is the answer to "is anyone
   * signed in", and the provider was asked exactly that question. So it
   * records the session as signed out and returns quietly, rather than
   * putting "You must be signed in to do that" on every page of the
   * storefront.
   */
  const loadCart = useCallback(async (isCancelled: () => boolean) => {
    try {
      const response = await fetch("/api/cart", {
        headers: { accept: "application/json" },
      });

      if (isCancelled()) return;

      const payload = (await response.json()) as ApiEnvelope<{ cart: CartView }>;

      if (!payload.ok) {
        if (payload.error.code === "UNAUTHENTICATED") {
          setIsAuthenticated(false);
          setCart(null);
          setError(null);
          return;
        }

        setError(payload.error.message);
        return;
      }

      setIsAuthenticated(true);
      setCart(payload.data.cart);
      setError(null);
    } catch {
      if (!isCancelled()) {
        setError("We could not reach the shop. Please try again.");
      }
    }
  }, []);

  /**
   * Re-reads the cart.
   */
  const refresh = useCallback(async () => {
    setIsLoading(true);

    try {
      await loadCart(() => false);
    } finally {
      setIsLoading(false);
    }
  }, [loadCart]);

  // Load the cart once, on mount.
  //
  // ── Why the fetch is started in a microtask ────────────────────────────
  //
  // React's `set-state-in-effect` rule forbids a *synchronous* state
  // update in an effect body: it causes a cascading render — the effect
  // runs, sets state, React re-renders, and the effect's dependencies
  // are checked again.
  //
  // The rule is right about the problem, and the answer is not to
  // suppress it. A network request is not synchronous — the state
  // update belongs to the *response*, not to the effect. Starting the
  // request inside a microtask puts the whole thing — including the
  // `setState` calls it eventually makes — outside the effect body's
  // synchronous execution, which is exactly the relationship the rule
  // is asking for.
  //
  // So the effect does not say "set the loading flag, then fetch". It
  // says "when this microtask runs, fetch, and let the response update
  // the state". The update is caused by the network, not by the effect.
  useEffect(() => {
    // The cleanup flag cancels the request if the component unmounts
    // before it lands — a response arriving after teardown must not
    // set state on a dead component.
    let cancelled = false;

    void Promise.resolve().then(async () => {
      if (cancelled) return;

      setIsLoading(true);

      try {
        await loadCart(() => cancelled);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadCart]);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Forgets the session and the cart.
   *
   * Called on logout. The server has already cleared the cookie by the
   * time this runs — this only clears what the browser was holding.
   *
   * The session goes to `null` ("not known") rather than `false` ("known
   * to be signed out"). The difference is subtle but real: `null` means
   * the provider has no opinion, so the cart stays hidden until a
   * request answers. `false` would be a claim the provider cannot
   * verify — and after a logout the cookie is gone, so the next cart
   * request answers `401` and the provider learns the truth for itself.
   */
  const reset = useCallback(() => {
    setCart(null);
    setError(null);
    setIsOpen(false);
    setIsAuthenticated(null);
  }, []);

  /**
   * Sends a request and replaces the cart with the answer.
   *
   * Shared by the add, the quantity change and the remove — all three
   * have the same shape, and the difference is only in the URL and the
   * body. One implementation means the error handling and the
   * "replace, never patch" rule are stated once.
   *
   * Returns the payload's data, or `null` when the request failed. The
   * add path needs the whole `AddToCartResult` — the cart *and* the
   * conflicts — so the caller can show a conflict banner without
   * making a second request.
   */
  const mutate = useCallback(
    async <T,>(url: string, init: RequestInit): Promise<T | null> => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(url, init);
        const payload = (await response.json()) as ApiEnvelope<T & {
          cart?: CartView;
        }>;

        if (!payload.ok) {
          // A 401 means the session is gone — the customer signed out in
          // another tab, or their token expired. The cart is no longer
          // theirs, so the badge must not keep showing it. The message
          // itself is still worth showing: a customer who clicked "Add
          // to Bag" deserves to know why nothing was added.
          if (payload.error.code === "UNAUTHENTICATED") {
            setIsAuthenticated(false);
            setCart(null);
          }

          setError(payload.error.message);
          return null;
        }

        // The server sent the whole cart back. It replaces the client's
        // copy — the client never patches its own.
        if (payload.data.cart) {
          setIsAuthenticated(true);
          setCart(payload.data.cart);
        } else {
          await refresh();
        }

        return payload.data;
      } catch {
        setError("We could not reach the shop. Your cart is unchanged.");
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [refresh],
  );

  const addItem = useCallback(
    async (
      productId: string,
      quantity = 1,
      options: { readonly openDrawer?: boolean } = {},
    ): Promise<AddToCartResult | null> => {
      const result = await mutate<AddToCartResult>("/api/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId, quantity }),
      });

      if (result && options.openDrawer !== false) {
        setIsOpen(true);
      }

      return result;
    },
    [mutate],
  );

  const setQuantity = useCallback(
    async (lineId: string, quantity: number): Promise<boolean> =>
      (
        await mutate<{ cart?: CartView }>(`/api/cart/items/${lineId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ quantity }),
        })
      ) !== null,
    [mutate],
  );

  const removeItem = useCallback(
    async (lineId: string): Promise<boolean> =>
      (
        await mutate<{ cart?: CartView }>(`/api/cart/items/${lineId}`, {
          method: "DELETE",
        })
      ) !== null,
    [mutate],
  );

  const value = useMemo<CartDrawerContextValue>(() => {
    /**
     * The cart, as the rest of the app sees it.
     *
     * A visitor who is not signed in has no cart — not an empty one.
     * Deriving it here rather than clearing it in an effect means the
     * state can never disagree with the session: there is exactly one
     * source of truth and the cart is read from it.
     *
     * `isAuthenticated` is `null` while the answer is still unknown, so
     * the cart is hidden until the API has said something. That is the
     * honest state — showing "0 items" to a signed-in customer whose
     * cart is on its way would be a lie for a frame.
     */
    const visibleCart = isAuthenticated === true ? cart : null;

    return {
      cart: visibleCart,
      isLoading,
      error,
      itemCount: visibleCart?.totalQuantity ?? 0,
      isOpen,
      open,
      close,
      refresh,
      reset,
      addItem,
      setQuantity,
      removeItem,
    };
  }, [
    cart,
    isAuthenticated,
    isLoading,
    error,
    isOpen,
    open,
    close,
    refresh,
    reset,
    addItem,
    setQuantity,
    removeItem,
  ]);

  return (
    <CartDrawerContext.Provider value={value}>
      {children}
    </CartDrawerContext.Provider>
  );
}

/**
 * Reads the cart drawer context.
 *
 * @throws when used outside the provider — a silent `null` would turn a
 *         wiring mistake into a component that does nothing.
 */
export function useCartDrawer(): CartDrawerContextValue {
  const context = useContext(CartDrawerContext);

  if (context === null) {
    throw new Error(
      "useCartDrawer must be used inside a <CartDrawerProvider>.",
    );
  }

  return context;
}
