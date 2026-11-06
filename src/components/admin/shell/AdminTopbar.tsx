"use client";

import Link from "next/link";

import { CloseIcon, MenuIcon } from "@/components/ui/icons";

import { AdminNotificationBell } from "./AdminNotificationBell";
import { AdminProfileMenu } from "./AdminProfileMenu";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The admin top bar.
 *
 * ── What is in it, and what is not ──────────────────────────────────────
 *
 * The top bar holds the four things that must be reachable from every
 * admin page: the way back to the shop, the notification bell, the theme
 * switch, and the way out (the logout).
 *
 * It deliberately does **not** hold a search field. A global search box
 * that searches nothing is worse than no search box — an operator will
 * trust it, type a product name, and get an empty result with no
 * explanation. When search exists it must actually search.
 *
 * ── Why the bell lives here ──────────────────────────────────────────────
 *
 * The bell is the one control that must be visible from **every**
 * admin page. An order that arrives while the admin is on the products
 * page is exactly as urgent as one that arrives while they are on the
 * orders page — so the bell cannot live on the orders page alone. The
 * top bar is the only place every admin page shares.
 *
 * ── Where the settings live ──────────────────────────────────────────────
 *
 * The **account menu** — the admin's own name and avatar, at the end of
 * the bar — carries the settings link. The reasoning is in
 * `AdminProfileMenu`: the bar is already crowded, the sidebar is a
 * navigation list rather than an account surface, and "my account"
 * belongs at the end of the header next to the name that identifies it.
 */
export function AdminTopbar({
  userName,
  userEmail,
  onOpenDrawer,
}: {
  /** The signed-in administrator's name. */
  readonly userName: string;
  /** The signed-in administrator's email address. */
  readonly userEmail: string;
  /** Opens the sidebar drawer on narrow screens. */
  readonly onOpenDrawer: () => void;
}) {
  return (
    /*
     * The top bar is **sticky**, not fixed.
     *
     * It is sticky so the operator's controls — the bell, the theme
     * switch, the way out — stay reachable however far down the page
     * they have scrolled. It is not fixed because a fixed bar is taken
     * out of the flow and painted over whatever it lands on; here the
     * page content starts *below* the bar and scrolls under it, which
     * is what a sticky bar does.
     *
     * It carries no z-index of its own. It does not need one: the
     * sidebar is a sibling in the same flex row, and neither overlaps
     * the other, so there is nothing for the bar to paint over — and
     * nothing for it to be painted over by. The one overlay that does
     * need to sit on top (the mobile drawer) has its own `z-50`.
     */
    <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        {/*
          The drawer trigger. Only on narrow screens — on a wide screen
          the sidebar is already visible and the button would be a
          duplicate control for the same thing.
        */}
        <button
          type="button"
          onClick={onOpenDrawer}
          aria-label="Open the navigation menu"
          className={[
            "inline-flex h-10 w-10 items-center justify-center rounded-full",
            "text-foreground-muted transition-colors duration-200",
            "hover:bg-surface-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
            "focus-visible:ring-offset-surface",
            "lg:hidden",
          ].join(" ")}
        >
          <MenuIcon className="h-5 w-5" />
        </button>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {/*
            The notification bell.

            First in the cluster, before the theme switch: it is the
            control an operator looks for when they want to know whether
            something happened while they were on another page.
          */}
          <AdminNotificationBell />

          <ThemeToggle />

          {/*
            "View shop" is a **link** — it navigates. It is hidden on
            mobile, where the top bar is already tight and the shop is
            reachable from the brand mark in the drawer.
          */}
          <Link
            href="/"
            className={[
              "hidden rounded-full px-3 py-1.5 text-sm font-medium",
              "text-foreground-muted transition-colors duration-200",
              "hover:bg-surface-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
              "focus-visible:ring-offset-surface",
              "sm:inline-flex",
            ].join(" ")}
          >
            View shop
          </Link>

          {/*
            The account menu — the way to the settings, and to the way
            out.

            It is **last** in the bar, because it is the least
            urgent of the four controls: the bell is about something
            that just happened, and this is about something the admin
            wants to go and do.
          */}
          <AdminProfileMenu userName={userName} userEmail={userEmail} />
        </div>
      </div>
    </header>
  );
}

/**
 * The scrim behind the mobile drawer.
 *
 * A `button`, because clicking it closes the drawer — it *acts*, so it
 * is a button. It is also the accessible way out of the drawer for
 * anyone who does not want to reach the close button.
 */
export function AdminDrawerScrim({ onClose }: { readonly onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close the navigation menu"
      className="fixed inset-0 z-40 bg-neutral-900/50 backdrop-blur-sm lg:hidden"
    />
  );
}

/**
 * The close control for the mobile drawer.
 */
export function AdminDrawerClose({ onClose }: { readonly onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close the navigation menu"
      className={[
        "inline-flex h-10 w-10 items-center justify-center rounded-full",
        "text-foreground-muted transition-colors duration-200",
        "hover:bg-surface-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        "focus-visible:ring-offset-surface",
        "lg:hidden",
      ].join(" ")}
    >
      <CloseIcon className="h-5 w-5" />
    </button>
  );
}
