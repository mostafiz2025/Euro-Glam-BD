"use client";

import { useRouter } from "next/navigation";
import { useContext, useState } from "react";

import { CartDrawerContext } from "@/components/commerce/cart-drawer-provider";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The logout button.
 *
 * ── What "logging out" actually means here ───────────────────────────────
 *
 * Four things have to happen, in this order, and all four matter:
 *
 *   1. **The server must clear the cookie.** The JWT lives in an
 *      HTTP-only cookie, so no amount of client-side tidying can end the
 *      session — only `POST /api/auth/logout` can, by writing the cookie
 *      back with `maxAge: 0`. A logout that only navigates to `/login`
 *      leaves a perfectly valid session token in the browser.
 *
 *   2. **The client must forget the cart.** The cart drawer holds the
 *      signed-in customer's cart in memory. After a logout that memory
 *      is stale — it describes a cart belonging to a session that no
 *      longer exists, and it may belong to whoever signs in next on a
 *      shared device. The provider's `reset()` clears it.
 *
 *      This step is **optional**. The button is used in the storefront's
 *      account menu *and* in the admin top bar, and only the storefront
 *      has a cart. The admin panel has no drawer, so there is nothing
 *      to clear there — and reading the cart context optionally is what
 *      lets one button serve both shells without the admin panel having
 *      to mount the storefront's cart provider.
 *
 *   3. **The page must not keep the old state.** The admin layout reads
 *      the session on the server. A `router.refresh()` after the
 *      cookie is cleared makes the server re-render with the new (signed
 *      out) session, so the protected layout redirects rather than
 *      continuing to render a dashboard the user no longer has access to.
 *
 *   4. **The user must land somewhere real.** `/login`, with a `next`
 *      parameter so they can be sent back to where they were — but
 *      *only* to a path inside this application. The `next` value is
 *      attacker-controllable through a crafted link, so it is validated
 *      against a strict pattern before it is used. Without that check,
 *      `?next=https://evil.example` would turn the login page into an
 *      open redirect.
 *
 * ── Why the button is disabled while it works ────────────────────────────
 *
 * The POST is idempotent — logging out twice is harmless — but a
 * double-click would fire two requests, and the second one would race
 * the redirect. The button is disabled while the request is in flight so
 * the action happens exactly once.
 */
export function LogoutButton({
  className,
  label = "Sign out",
}: {
  readonly className?: string;
  readonly label?: string;
}) {
  const router = useRouter();

  /**
   * The cart drawer, **if there is one**.
   *
   * The button is used in two places: the storefront's account menu, and
   * the admin top bar. The storefront is wrapped in a
   * `CartDrawerProvider`; the admin panel is deliberately **not** — the
   * admin shell has no cart, no drawer and no shop furniture at all.
   *
   * So the context is read **optionally** here. `useCartDrawer()` throws
   * when it is used outside the provider, which is the right default for
   * a component that genuinely cannot work without it — but the logout
   * button can work without a cart: it clears the session cookie, and
   * the cart reset is only a tidying step on top of that.
   *
   * The optional read is what lets one component serve both shells
   * without dragging the storefront's cart provider into the admin
   * panel — which would be exactly the coupling this layout is being
   * dismantled to remove.
   */
  const cart = useContext(CartDrawerContext);

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogout() {
    if (isPending) return;

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { accept: "application/json" },
      });

      const payload = (await response.json()) as ApiEnvelope<{
        success: boolean;
      }>;

      if (!payload.ok) {
        setError(payload.error.message);
        setIsPending(false);
        return;
      }

      // The cookie is gone. Forget everything the old session put in
      // the browser, then re-render the server's view of the world.
      //
      // The cart reset is skipped when there is no cart — the admin
      // panel has no drawer to clear.
      cart?.reset();

      router.replace("/login?next=%2F");
      router.refresh();
    } catch {
      setError("We could not sign you out. Please try again.");
      setIsPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleLogout}
        disabled={isPending}
        className={[
          "inline-flex h-9 items-center justify-center rounded-full px-3.5 text-sm font-medium",
          "border border-border bg-surface text-foreground-muted",
          "transition-colors duration-200",
          "hover:border-neutral-400 hover:bg-surface-sunken hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          "disabled:pointer-events-none disabled:opacity-60",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {isPending ? "Signing out…" : label}
      </button>

      {/*
        The error is announced. A logout that silently fails leaves the
        user believing they are signed out when the token is still in
        their browser — so the failure has to be visible, and it has to
        be in the accessibility tree.
      */}
      <p role="alert" className="sr-only">
        {error}
      </p>
    </>
  );
}
