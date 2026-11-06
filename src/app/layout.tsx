import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Euro Glam BD — Authentic European Skincare & Makeup",
    template: "%s · Euro Glam BD",
  },
  description:
    "Authentic European skincare, makeup and baby care for Bangladesh, with an AI skin advisor, ingredient conflict checking, and cash on delivery.",
  keywords: [
    "skincare Bangladesh",
    "European skincare",
    "makeup BD",
    "baby care",
    "cash on delivery",
    "AI skin advisor",
  ],
  openGraph: {
    title: "Euro Glam BD — Authentic European Skincare & Makeup",
    description:
      "Authentic European skincare, makeup and baby care for Bangladesh. Cash on delivery nationwide.",
    type: "website",
    locale: "en_BD",
  },
};

export const viewport: Viewport = {
  themeColor: "#db2777",
  width: "device-width",
  initialScale: 1,
  // The maximum scale is deliberately NOT set. Pinching to zoom is an
  // accessibility feature, and restricting it fails WCAG 1.4.4.
};

/**
 * The no-flash theme script.
 *
 * This runs **synchronously, before the first paint**, and is the only
 * thing that sets the theme class on `<html>`.
 *
 * ── Why it is an inline script and not React state ───────────────────────
 *
 * If React owned the theme, the server would have to render the class
 * — but the server does not know the visitor's theme, because the
 * preference lives in the browser. So React would render `class=""`
 * and the client would render `class="dark"`, and React would report a
 * **hydration mismatch**. Worse, the browser would paint the light
 * theme first and then correct it: a white flash on every page load
 * for every dark-mode visitor.
 *
 * The script avoids both by owning the class outright. React's
 * `<html>` `className` therefore contains **only** the font variables
 * and the layout classes — never the theme — so there is nothing to
 * mismatch.
 *
 * ── Why `localStorage` and not a cookie ──────────────────────────────────
 *
 * A cookie would mean reading `cookies()` in the root layout, which
 * makes every route request-time and fails `next build` (decision #46).
 * The theme is a presentation preference, not session state, so it
 * belongs in the browser's storage.
 */
const THEME_SCRIPT = `(function(){try{
var s=localStorage.getItem("egb-theme");
var t=(s==="light"||s==="dark")?s:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
document.documentElement.classList.toggle("dark",t==="dark");
document.documentElement.style.colorScheme=t;
}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  /**
   * The root layout renders **nothing but the document shell**.
   *
   * ── Why the shop's chrome is not here ─────────────────────────────────────
   *
   * The storefront's header, announcement bar, category strip, cart
   * drawer, footer and bottom nav all used to be mounted here. That
   * made them the inheritance of **every** route in the app — including
   * `/admin/*`, which is why the admin dashboard was rendered inside
   * the storefront and why the shop's sticky header (`z-50`) painted
   * over the admin rail (`z-40`).
   *
   * They now live in `src/app/(storefront)/layout.tsx`, which is a
   * **route group**: transparent to the URL, but a real boundary for
   * the layout tree. The storefront pages inherit the shop's chrome;
   * the admin pages inherit the admin shell and nothing else.
   *
   * Two applications, two shells, two layout trees — and no page that
   * renders both.
   *
   * ── Why the root layout does not read the session ────────────────────────
   *
   * It is tempting: the cart drawer needs to know whether the visitor
   * is signed in, and the layout is where the session would naturally
   * be read. But `cookies()` in the root layout makes **every** route
   * in the app request-time, and `next build` then tries to prerender
   * them all — with a `cookies()` call that rejects during the
   * prerender, which fails the build.
   *
   * The session is instead detected by the cart provider, on the
   * client, from the cart API's own answer: a `401 UNAUTHENTICATED`
   * means signed out, and a cart means signed in. That keeps the
   * storefront prerenderable and keeps the drawer correct.
   */
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/*
          The theme script must be the **first** thing in the head, so
          it sets the class before the browser paints anything. React
          renders it as a plain script element — it is not a component
          and it never re-renders.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
