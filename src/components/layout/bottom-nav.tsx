"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useCartDrawer } from "@/components/commerce/cart-drawer-provider";
import {
  CartIcon,
  GridIcon,
  HomeIcon,
  SparkleIcon,
  UserIcon,
} from "@/components/ui/icons";

/**
 * The bottom navigation.
 *
 * ── Why a bottom bar on mobile, and why it is hidden on desktop ────────
 *
 * A phone user holds the bottom of the screen with their thumb. The
 * top of a phone screen is the hardest place to reach one-handed, which
 * is why the tab bar sits at the bottom on mobile and the navigation
 * moves into the header on desktop.
 *
 * The two are **not** the same layout. A desktop header with four
 * inline links is better than a desktop bottom bar — a bottom bar on a
 * 1440px screen wastes the space where the header's search field
 * belongs.
 *
 * So: bottom bar below `lg`, inline header links above it.
 *
 * ── The active state ────────────────────────────────────────────────────
 *
 * `usePathname` decides which tab is active. The rule: a tab is active
 * when the current path is the tab's path, or a **descendant** of it —
 * so "Shop" stays active on `/products/abc`, and "Home" is active only
 * on `/`.
 *
 * ── The cart tab is a button, not a link ────────────────────────────────
 *
 * The cart tab opens the drawer rather than navigating. A customer on
 * a product page who taps "Cart" wants to see their basket *now*, not
 * to leave the page they are shopping on. The drawer is modal, so the
 * page stays exactly where it was behind it.
 *
 * A button that navigates would be a link; a button that opens a panel
 * is a button. The distinction is the same one the `Button` / `ButtonLink`
 * split makes everywhere else in the codebase.
 */

/**
 * One tab.
 */
type Tab = {
  readonly href: string;
  readonly label: string;
  readonly icon: (props: { width?: number; height?: number; className?: string }) => React.JSX.Element;
  /** Whether the tab opens the cart drawer instead of navigating. */
  readonly opensDrawer?: boolean;
};

/**
 * The tabs, in order.
 */
const TABS: readonly Tab[] = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/products", label: "Shop", icon: GridIcon },
  { href: "/advisor", label: "Advisor", icon: SparkleIcon },
  { href: "/cart", label: "Cart", icon: CartIcon, opensDrawer: true },
  { href: "/account", label: "Account", icon: UserIcon },
];

/**
 * Returns true when the tab is the active one.
 *
 * The home tab is active only on the home page. Every other tab is
 * active on its own path and on any path beneath it.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomNav() {
  const pathname = usePathname();
  const { open: openCart, itemCount } = useCartDrawer();

  return (
    <nav
      aria-label="Primary"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur-md lg:hidden"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between px-2 pt-1.5">
        {TABS.map((tab) => {
          const active = isActive(pathname, tab.href);
          const Icon = tab.icon;

          const classes = [
            "flex flex-col items-center gap-0.5 rounded-xl px-1 py-1.5",
            "transition-colors duration-200",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            active
              ? "text-brand-700"
              : "text-foreground-muted hover:text-foreground-muted",
          ].join(" ");

          const inner = (
            <>
              <span
                className={[
                  "relative flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200",
                  active ? "bg-brand-100" : "",
                ]
                  .filter(Boolean)
                  .join(" ")
                }
              >
                <Icon width={20} height={20} />

                {/* The item count, on the cart tab. */}
                {tab.opensDrawer && itemCount > 0 ? (
                  <span
                    aria-hidden="true"
                    className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-600 px-1 text-[9px] font-bold leading-none text-white"
                  >
                    {itemCount > 99 ? "99+" : itemCount}
                  </span>
                ) : null}
              </span>

              <span
                className={[
                  "text-[10px] font-medium leading-none",
                  active ? "text-brand-700" : "text-foreground-muted",
                ].join(" ")}
              >
                {tab.label}
              </span>
            </>
          );

          return (
            <li key={tab.href} className="flex-1">
              {tab.opensDrawer ? (
                <button
                  type="button"
                  onClick={openCart}
                  aria-label={
                    itemCount > 0
                      ? `Your cart, ${itemCount} ${itemCount === 1 ? "item" : "items"}`
                      : "Your cart, empty"
                  }
                  className={classes}
                >
                  {inner}
                </button>
              ) : (
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={classes}
                >
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
