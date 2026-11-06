"use client";

import { useCartDrawer } from "@/components/commerce/cart-drawer-provider";
import { CartIcon } from "@/components/ui/icons";

/**
 * The cart button.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The badge comes from the shared cart state.**
 *
 * It reads the count from the provider, not from its own fetch. Two
 * components that each fetch the cart will disagree — the badge says
 * "2" and the drawer says "3" — and the customer sees both at once.
 * There is one cart state, and this is a view of it.
 *
 * **2. The badge is hidden when the cart is empty.**
 *
 * A "0" badge on every page is noise. The icon alone says "cart"; the
 * badge appears only when there is something to count.
 *
 * **3. The accessible name says what the button does.**
 *
 * "Cart, 3 items" rather than "Cart". A screen-reader user hears the
 * count without having to open the drawer.
 */
export function CartButton() {
  const { itemCount, open } = useCartDrawer();

  return (
    <button
      type="button"
      onClick={open}
      aria-label={
        itemCount > 0
          ? `Your cart, ${itemCount} ${itemCount === 1 ? "item" : "items"}`
          : "Your cart, empty"
      }
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <CartIcon />

      {itemCount > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[10px] font-bold leading-none text-white shadow-sm"
        >
          {itemCount > 99 ? "99+" : itemCount}
        </span>
      ) : null}
    </button>
  );
}
