import Link from "next/link";

import { AccountMenu } from "@/components/layout/account-menu";
import { CartButton } from "@/components/layout/cart-button";
import { SearchIcon, SparkleIcon } from "@/components/ui/icons";

/**
 * The site header.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. Mobile-first, and the mobile header is not the desktop header
 * shrunk.**
 *
 * The desktop header carries the search field inline. On a phone there
 * is no room for it, so the search becomes a **link that opens the
 * catalogue's own search**. Two layouts, one component, because a header
 * squeezed into 360px with a logo, a search box, a cart and an avatar
 * is a header where nothing fits properly.
 *
 * **2. The header is a server component.**
 *
 * It renders the navigation, which is static. The interactive parts —
 * the account menu, the cart badge — are separate client components
 * below. A server component that imports a client component is fine;
 * the reverse (marking the header `"use client"`) would pull the whole
 * shell into the browser bundle for no reason.
 *
 * **3. The logo is text, not an image.**
 *
 * A text logo renders instantly, is selectable, is accessible, and
 * scales without a second asset. An image logo here would be a
 * request that blocks the first paint for no gain.
 *
 * **4. The header is two tiers, and the tiers have different jobs.**
 *
 * The **upper** bar is the brand and the tools: the logo, the search
 * field, the account and the cart. The **lower** strip — `CategoryNav`
 * — is the catalogue's own axes, as a horizontal menu.
 *
 * A header that does both jobs in one row is a *utility bar*. Two tiers
 * is what makes it read as a storefront: the upper bar is calm and
 * branded, the lower bar does the navigating.
 *
 * **5. There is one strip above the header, and it is the marquee.**
 *
 * The header used to carry a static utility strip of its own — a dark
 * band with a delivery promise and three links. It is gone.
 *
 * Two strips above the header were the same kind of thing fighting for
 * the same job, and the static one was the worse of the pair: it could
 * not be changed without a deploy, so the shop advertised a delivery
 * threshold it could no longer honour. The marquee, which sits above
 * the header and which the admin writes, is the shop's one strip.
 *
 * **6. The main bar is sticky, and so is the strip under it.**
 *
 * The bar holds the four things a shopper needs at *any* point on a
 * long page — the logo (the way home), the search field (the way to
 * find a thing), and the account and cart icons (the way to check out).
 * A page that takes the search field away halfway down is a page the
 * shopper has to scroll back up to leave.
 *
 * So the bar is `sticky top-0`, and the category strip beneath it is
 * offset to sit **directly under** the bar rather than under the
 * viewport's top edge. Two sticky elements that both claim `top-0`
 * overlap — the second one paints over the first — so the strip's
 * offset is the bar's height. The two travel together as one header.
 *
 * The background is `bg-surface`, not a literal `bg-white`. `surface`
 * is `#ffffff` in the light theme and `#1c1917` in the dark one, so the
 * sticky bar keeps the theme it is in; a hard-coded white bar would
 * become a bright stripe across a black page.
 */

/**
 * The logo.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={[
        "flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-white shadow-[var(--shadow-brand)]">
        <SparkleIcon width={17} height={17} />
      </span>
      <span className="font-serif text-xl font-semibold tracking-tight text-foreground">
        Euro Glam<span className="text-brand-600">BD</span>
      </span>
    </Link>
  );
}

/**
 * The header.
 */
export function SiteHeader() {
  return (
    <>
      {/*
        The main bar.

        It is **sticky**, so the logo, the search field and the account
        and cart icons stay reachable on a long page. The category strip
        below it is offset by the bar's height, so the two travel
        together as one header rather than overlapping.

        `z-50` puts the bar above the page content and above the
        category strip's own `z-40` wrapper — the strip's dropdown
        panel is `fixed z-[70]`, so it still rises above the bar.

        ── The utility strip that used to be here ─────────────────────────
        There used to be a dark strip above this bar carrying "Cash on
        delivery nationwide — free delivery over ৳2,000" and three links.
        It is gone, and the shop has one announcement strip now — the
        marquee, which is **above** the header and which the admin
        writes.

        Two strips above the header was one too many: they were the
        same kind of thing (a fixed line of the shop's own words, in
        the shop's darkest fill, above the search bar) fighting for the
        same job. And the old strip could not be changed without a
        deploy, which meant the shop was advertising "free delivery
        over ৳2,000" long after the threshold moved — while the
        marquee, the strip that *can* be changed, sat above it saying
        something else.

        So the promises the strip used to carry are the marquee's job
        now, and the shop's chrome has one strip rather than two.
      */}
      <header className="sticky top-0 z-50 border-b border-border/70 bg-surface shadow-sm">
        <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          {/* ── Mobile: search button ───────────────────────────────────── */}
          <Link
            href="/products"
            aria-label="Search products"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 lg:hidden"
          >
            <SearchIcon />
          </Link>

          <Logo className="shrink-0" />

          {/* ── Desktop: the search field ──────────────────────────────── */}
          <form
            action="/products"
            className="ml-6 hidden flex-1 lg:block"
            role="search"
          >
            <label htmlFor="site-search" className="sr-only">
              Search products
            </label>
            <div className="relative max-w-2xl">
              <SearchIcon
                width={18}
                height={18}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-foreground-muted"
              />
              <input
                id="site-search"
                name="search"
                type="search"
                placeholder="Search CeraVe, La Roche-Posay, sunscreens…"
                className={[
                  "h-11 w-full rounded-full border border-border bg-surface-muted pl-11 pr-4",
                  "text-sm text-foreground placeholder:text-foreground-muted",
                  "transition-colors duration-200",
                  "focus:border-brand-300 focus:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-200",
                ].join(" ")}
              />
            </div>
          </form>

          <div className="ml-auto flex items-center gap-1 lg:ml-4 lg:gap-2">
            {/*
              The account menu. It carries the profile links and the
              **sign out** control, so signing out is reachable from every
              page rather than only from the account page.
            */}
            <AccountMenu />

            <CartButton />
          </div>
        </div>
      </header>
    </>
  );
}
