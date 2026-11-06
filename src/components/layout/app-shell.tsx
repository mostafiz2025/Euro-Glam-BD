import type { ReactNode } from "react";
import { Suspense } from "react";

import { TrafficBeacon } from "@/components/analytics/traffic-beacon";
import { CartDrawer } from "@/components/commerce/cart-drawer";
import { CartDrawerProvider } from "@/components/commerce/cart-drawer-provider";

import { BottomNav } from "./bottom-nav";
import { CategoryNavSection } from "./category-nav-section";
import { SiteFooter } from "./footer";
import { SiteHeader } from "./header";
import { MarqueeBannerSection } from "./marquee-banner-section";
import { PromoBannerSection } from "./promo-banner-section";

/**
 * The application shell.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The bottom padding is not optional.**
 *
 * The mobile tab bar is `fixed` at the bottom of the viewport, so it
 * sits *over* the page content. Without the padding, the last row of
 * the footer is unreachable behind the bar — and on a phone, "the last
 * thing on the page is hidden" is the kind of bug nobody reports, they
 * just cannot find the trust badges.
 *
 * The padding is applied on `<main>`, and it is generous enough to
 * clear the bar plus the iPhone home indicator.
 *
 * **2. The shell is a server component.**
 *
 * Only `BottomNav` is a client component — it needs `usePathname` to
 * know which tab is active. The header and footer are static and stay
 * on the server.
 *
 * **3. `<main>` is a landmark.**
 *
 * A screen reader user can jump straight to the main content with the
 * "skip to content" shortcut, and the landmark is what makes that
 * possible. The header and footer are `<header>` and `<footer>` for the
 * same reason.
 *
 * **4. The cart provider wraps everything.**
 *
 * The cart drawer is reachable from the header and from every add-to-cart
 * button, so its state has to live above both. The provider is a client
 * component, and the shell — a server component — renders it as a
 * client child, which is fine: a server component may import a client
 * component, and the reverse would pull the whole shell into the browser
 * bundle.
 *
 * **5. The shell does not know whether the visitor is signed in.**
 *
 * The provider works it out for itself, from the cart API's answer.
 * Passing it down from the server would mean a `cookies()` read in the
 * root layout, which makes every route request-time and breaks the
 * build's prerender.
 */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <CartDrawerProvider>
      <div className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className={[
            "sr-only focus:not-sr-only",
            "focus:absolute focus:left-4 focus:top-4 focus:z-50",
            "focus:rounded-full focus:bg-brand-600 focus:px-4 focus:py-2",
            "focus:text-sm focus:font-medium focus:text-white",
          ].join(" ")}
        >
          Skip to content
        </a>

        {/* ── The announcement marquee ────────────────────────────────────
         *
         * It is the **first** thing on the page — above the header, not
         * below it — because it is the shop's first sentence. The
         * header is the shop's name and it is permanent; the marquee is
         * what the shop has to say this week.
         *
         * It renders **nothing at all** when the admin has switched it
         * off, so a shop with no announcement shows no strip.
         *
         * It is streamed behind its own `<Suspense>` boundary for the
         * same reason the promo bar is: the settings query is a
         * database round-trip, and the rest of the storefront should not
         * wait for it.
         */}
        <MarqueeBannerSection />

        <SiteHeader />

        {/* ── The promotional bar ────────────────────────────────────────
         *
         * It sits between the header and the sticky category strip, and
         * it is **not** sticky — it is an announcement, and an
         * announcement that follows the customer down the page becomes
         * furniture.
         *
         * The bar renders nothing at all when there are no active
         * campaigns, so a shop with no coupons shows no empty strip.
         *
         * It is streamed behind its own `<Suspense>` boundary for the
         * same reason the category strip is: the coupon query is a
         * database round-trip, and the rest of the storefront should not
         * wait for it.
         */}
        <PromoBannerSection />

        {/*
          The category navigation strip.

          It is the **sticky** part of the header, and it is separated
          from the main bar on purpose: the main bar carries the brand
          and the tools (search, account, cart), while this strip carries
          the catalogue's own axes.

          ── The offset is the whole trick ──────────────────────────────
          Two elements cannot both claim `top-0`. The second one pins
          itself to the viewport's top edge and paints over the first,
          so the strip would slide underneath the main bar and the bar
          would disappear.

          So the strip sticks at `top-[4.5rem]` — the main bar's height —
          and the two travel together as a single header: the brand and
          the tools on top, the catalogue's axes underneath. Nothing
          overlaps and nothing is hidden.

          The offset is a literal rather than a CSS variable because
          the main bar's height is also written literally, in
          `header.tsx`. The two must agree, and the pair of literals
          sitting in two files is a smaller thing to keep in step than a
          shared token would be for two uses.
        */}
        <div className="sticky top-[4.5rem] z-40">
          <CategoryNavSection />
        </div>

        {/* ── The cart drawer ────────────────────────────────────────────
         *
         * The drawer lives in the shell, not on a page, because it has
         * to be reachable from everywhere — the header icon and the
         * bottom nav's cart tab both open it. */}
        <CartDrawer />

        <main id="main" className="flex-1 pb-24 lg:pb-0">
          {children}
        </main>

        <SiteFooter />

        {/* ── The traffic beacon ────────────────────────────────────────
         *
         * It renders nothing. It fires one request per storefront route
         * change and forgets about it — an analytics failure must never
         * break a customer's page, so there is no error path here at
         * all.
         *
         * It is wrapped in a `<Suspense>` boundary because it reads
         * `usePathname()`. That is **runtime** data — it is only known
         * when the request arrives — so it cannot be baked into a
         * prerendered page. Next.js refuses to prerender a client
         * component that reads it outside a `<Suspense>` boundary, and
         * the build fails. The same reason the `BottomNav` below is
         * wrapped.
         *
         * The fallback is `null`: the beacon renders nothing anyway, so
         * there is nothing to reserve.
         */}
        <Suspense fallback={null}>
          <TrafficBeacon />
        </Suspense>

        {/* ── The bottom navigation ───────────────────────────────────────
         *
         * `BottomNav` reads `usePathname()` to decide which tab is
         * active. That is **runtime** data — it is only known when the
         * request arrives, so it cannot be baked into a prerendered
         * page. Next.js refuses to prerender a client component that
         * reads it outside a `<Suspense>` boundary.
         *
         * The fallback keeps the bar's space reserved so the page does
         * not shift when the real nav streams in. It renders the links
         * without the active state, because the active state is exactly
         * the part that needs the pathname.
         */}
        <Suspense fallback={<BottomNavFallback />}>
          <BottomNav />
        </Suspense>
      </div>
    </CartDrawerProvider>
  );
}

/**
 * The placeholder for the bottom navigation.
 *
 * It reserves the bar's height so the content above it does not jump
 * when the real navigation replaces it. The links are present but
 * carry no active state — that is the part that needs the pathname.
 */
function BottomNavFallback() {
  return (
    <div
      aria-hidden="true"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 backdrop-blur-md lg:hidden"
    >
      <div className="mx-auto flex max-w-lg items-stretch justify-between px-2 pt-1.5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex-1 px-1 py-1.5">
            <div className="mx-auto h-7 w-12 animate-pulse rounded-full bg-surface-muted" />
            <div className="mx-auto mt-1 h-2 w-8 animate-pulse rounded-full bg-surface-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}
