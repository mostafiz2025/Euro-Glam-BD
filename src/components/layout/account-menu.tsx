"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { LogoutButton } from "@/components/admin/logout-button";
import { ChevronDownIcon, UserIcon } from "@/components/ui/icons";

/**
 * The account menu.
 *
 * ── Why this is a client component ───────────────────────────────────────
 *
 * It opens and closes, and it closes on an outside click and on
 * `Escape`. That is runtime behaviour, so it belongs in the browser.
 *
 * ── How it knows whether anyone is signed in ─────────────────────────────
 *
 * The same way the cart provider does: it asks the API, and the API's
 * answer is the answer. A `401 UNAUTHENTICATED` means signed out.
 *
 * The alternative — reading the session cookie in the root layout and
 * passing the result down — would make every route in the storefront
 * request-time and break the build's prerender. That trade was already
 * made once, for the cart; the menu follows the same rule rather than
 * inventing a second way to answer the same question.
 *
 * ── The accessibility contract ──────────────────────────────────────────
 *
 * The trigger is a `<button>` with `aria-expanded` and `aria-controls`.
 * The panel is closed with `hidden`, so its links are not focusable when
 * it is closed. `Escape` closes it and returns focus to the trigger.
 */
export function AccountMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState<boolean | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Discover the session.
   *
   * The request is started in a microtask, for the same reason the cart
   * provider does it that way: a *synchronous* `setState` inside an
   * effect body triggers React's cascading-render rule. The state
   * update belongs to the response, not to the effect.
   */
  useEffect(() => {
    let cancelled = false;

    void Promise.resolve().then(async () => {
      if (cancelled) return;

      try {
        const response = await fetch("/api/cart", {
          headers: { accept: "application/json" },
        });

        const payload = (await response.json()) as {
          ok: boolean;
          error?: { code?: string };
        };

        if (cancelled) return;

        setIsSignedIn(payload.ok === true);
      } catch {
        if (!cancelled) {
          // The session is genuinely unknown. Leaving it `null` keeps
          // the menu showing the "Sign in" affordance, which is the safe
          // default — it never pretends someone is signed in.
          setIsSignedIn(false);
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Close on an outside click.
   */
  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const container = containerRef.current;

      if (container && !container.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isOpen]);

  /**
   * Close on `Escape`, and hand focus back to the trigger so the user
   * is not dropped at the top of the document.
   */
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-controls="account-menu"
        aria-label="Your account"
        className="inline-flex h-10 items-center gap-1 rounded-full px-1.5 text-foreground-muted transition-colors hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <UserIcon />

        <ChevronDownIcon
          width={14}
          height={14}
          className={[
            "hidden transition-transform duration-200 sm:block",
            isOpen ? "rotate-180" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        />
      </button>

      {/*
        The panel.

        It is `absolute`, so it is positioned against this component —
        which now lives **inside the sticky header**, which is `z-50`.
        A `z-50` child inside a `z-50` parent does not rise above the
        parent's stacking context; it is trapped inside it. The panel
        therefore uses `z-[60]`, which lifts it clear of the header's
        own level while still being clipped by it — which is correct,
        because the panel should not be able to float away from the
        button that opens it.
      */}
      <div
        id="account-menu"
        hidden={!isOpen}
        className="absolute right-0 z-[60] mt-2 w-56 overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
      >
        {isSignedIn === true ? (
          <div className="p-2">
            <Link
              href="/account"
              onClick={() => setIsOpen(false)}
              className="block rounded-xl px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Your account
            </Link>

            <Link
              href="/orders"
              onClick={() => setIsOpen(false)}
              className="block rounded-xl px-3 py-2 text-sm text-foreground-muted transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Your orders
            </Link>

            {/*
              The settings entry.

              It sits here, beside "Your orders", because this menu is the
              one place in the shop that says *who is signed in* — and
              "where do I change my details?" is asked by somebody who is
              looking at their own name. The account page carries a link
              as well, so both ways of looking for it work.
            */}
            <Link
              href="/account/settings"
              onClick={() => setIsOpen(false)}
              className="block rounded-xl px-3 py-2 text-sm text-foreground-muted transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Settings
            </Link>

            <div className="my-1 h-px bg-surface-muted" />

            {/*
              The logout control. It is a **button**, because it runs an
              action — a POST that clears the session cookie — rather
              than navigating. A link would issue a GET, and a logout
              that a prefetcher could trigger by accident is not a
              logout.
            */}
            <div className="px-1 pb-1">
              <LogoutButton className="w-full justify-center" />
            </div>
          </div>
        ) : (
          <div className="p-2">
            <Link
              href="/login?next=%2F"
              onClick={() => setIsOpen(false)}
              className="block rounded-xl px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Sign in
            </Link>

            <Link
              href="/register"
              onClick={() => setIsOpen(false)}
              className="block rounded-xl px-3 py-2 text-sm text-foreground-muted transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Create an account
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
