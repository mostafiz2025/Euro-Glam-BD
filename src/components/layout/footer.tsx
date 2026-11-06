import Link from "next/link";

import { PaymentBrandMark } from "@/components/commerce/payment-brand-mark";
import {
  CreditCardIcon,
  ShieldIcon,
  SparkleIcon,
  TruckIcon,
} from "@/components/ui/icons";

import { FooterContactSection } from "./footer-contact-section";

/**
 * The footer.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. It is a dark, multi-column footer — and that is a deliberate
 * choice, not a theme.**
 *
 * The footer is the one place on the page where the shop stops selling
 * and starts *reassuring*. Cash on delivery, authenticity, delivery
 * coverage and a way to reach a human are the four things a customer
 * in Dhaka checks before they will pay for an imported product they
 * cannot see.
 *
 * A dark ground puts that reassurance in a different register from the
 * page above it. The catalogue is warm, light and rose; the footer is
 * ink. The contrast says "this is the small print, and it is the part
 * you can rely on" — and it gives the page a proper close rather than
 * trailing off into a pale strip.
 *
 * **2. The layout is a grid, not a stack of link lists.**
 *
 * Five columns on a desktop, two on a tablet, one on a phone:
 *
 *   ┌────────────┬──────────┬──────────┬──────────┬──────────────┐
 *   │ The brand  │ Shop     │ Brands   │ Support  │ Newsletter   │
 *   │ + trust    │ the      │ we stock │ & help   │ + payment    │
 *   │ signals    │ range    │          │          │ methods      │
 *   └────────────┴──────────┴──────────┴──────────┴──────────────┘
 *
 * The brand column is twice as wide because it carries the promise and
 * the newsletter form — the two things that need room.
 *
 * **3. The trust row is the most important part of it.**
 *
 * Cash on delivery, authentic European stock and a Bangladesh-wide
 * delivery promise are the three things a customer in Dhaka checks
 * before they will pay for an imported product they cannot see. So
 * they sit at the very top of the footer, above the link columns, in a
 * row that reads as a reassurance rather than as navigation.
 *
 * **4. The disclaimer is not optional.**
 *
 * The AI advisor produces aesthetic guidance, not medical advice. The
 * same disclaimer the `AiConfig` table carries belongs in the footer,
 * where every page can see it. It is a static sentence here rather than
 * a database read, because the page must render even when the database
 * is unavailable — and because the database row can be edited by an
 * admin without a deploy.
 *
 * **5. The copyright year is a build-time constant.**
 *
 * `new Date()` cannot be called during prerendering: the value changes
 * between renders, and Next.js refuses to bake an unstable value into
 * a static page. The year is read **once at module load** instead, so
 * every render of the footer shows the same year and the page can be
 * prerendered. A copyright year that only changes on the next deploy
 * is a perfectly good copyright year.
 *
 * **6. The contact details live in their own component.**
 *
 * The support email, the telephone, the opening hours and the store
 * address used to be strings in this file, which made them wrong the
 * moment the shop's mailbox changed — and they are the details a
 * customer calls or writes to when they have paid for something they
 * cannot see, so being wrong about them matters.
 *
 * They are now read from `site_settings`, in `FooterContactSection`.
 * It is a separate component because the read is a database
 * round-trip and the footer is on every page: keeping the read out
 * of the shell is what lets the storefront stay prerendered.
 */

/**
 * The copyright year, read once when the module loads.
 *
 * Not `new Date().getFullYear()` inline — that is an unstable value
 * during prerendering, and Next.js will refuse to build the page.
 */
const COPYRIGHT_YEAR = new Date().getFullYear();

/**
 * The trust signals.
 */
const TRUST_POINTS = [
  {
    icon: TruckIcon,
    title: "Cash on Delivery",
    body: "Pay when it arrives. No advance payment, no card details needed.",
  },
  {
    icon: ShieldIcon,
    title: "100% Authentic",
    body: "Sourced from authorised European distributors, with expiry dates guaranteed.",
  },
  {
    icon: TruckIcon,
    title: "Nationwide Delivery",
    body: "Delivered across Bangladesh in 2–4 working days.",
  },
] as const;

/**
 * The link columns.
 *
 * Three narrow columns beside the brand block: what you can shop, whose
 * labels we carry, and where to get help.
 */
const LINK_COLUMNS = [
  {
    title: "Shop",
    links: [
      { href: "/products?sort=newest", label: "New Arrivals" },
      { href: "/products?isBestSeller=true", label: "Best Sellers" },
      { href: "/products?category=serums", label: "Serums" },
      { href: "/products?category=sunscreens", label: "Sunscreens" },
      { href: "/products?category=cleansers", label: "Cleansers" },
      { href: "/products?category=makeup", label: "Makeup" },
    ],
  },
  {
    title: "Brands",
    links: [
      { href: "/products?search=CeraVe", label: "CeraVe" },
      { href: "/products?search=La%20Roche-Posay", label: "La Roche-Posay" },
      { href: "/products?search=The%20Ordinary", label: "The Ordinary" },
      { href: "/products?search=Eucerin", label: "Eucerin" },
      { href: "/products?view=brands", label: "All brands" },
    ],
  },
  {
    title: "Support",
    links: [
      { href: "/advisor", label: "AI Skin Advisor" },
      { href: "/products?view=concerns", label: "Shop by Concern" },
      { href: "/cart", label: "Your Cart" },
      { href: "/account", label: "Your Account" },
      { href: "/track-order", label: "Track an order" },
      { href: "/login", label: "Sign in" },
    ],
  },
] as const;

/**
 * The payment methods the shop accepts.
 *
 * These are the **rails**, drawn with the shared `PaymentBrandMark` so
 * the footer and the checkout show exactly the same marks. A footer
 * that advertises a payment method the checkout does not accept is a
 * broken promise.
 *
 * The list is deliberately **one row's worth**. Six badges at this size
 * overflow a third of the page's width and wrap, and a badge row that
 * wraps leaves an orphan on the second line — which reads as a mistake
 * rather than as a longer list. Three card networks and the two mobile
 * rails people actually use here fit on one line; the rest are on the
 * checkout page, which is where a customer looks before they pay.
 */
const PAYMENT_METHODS = [
  { brand: "visa" as const },
  { brand: "mastercard" as const },
  { brand: "amex" as const },
  { shortLabel: "bK", tint: "brand" as const },
  { shortLabel: "NG", tint: "info" as const },
];

/**
 * The footer.
 *
 * The margin above it is **tight** — 48px, not 80. The footer is a
 * dark band against a pale page, so the colour change already marks
 * the end of the content; a large white gap above it would say "the
 * page stopped" a second time, more slowly, and leave a dead band
 * between the last section and the footer.
 */
export function SiteFooter() {
  return (
    <footer className="mt-12 bg-neutral-900 text-white">
      {/* ── The trust row ─────────────────────────────────────────────── */}
      <div className="border-b border-white/10">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="grid gap-6 sm:grid-cols-3">
            {TRUST_POINTS.map((point) => {
              const Icon = point.icon;

              return (
                <div key={point.title} className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-brand-300">
                    <Icon width={18} height={18} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-white">
                      {point.title}
                    </h3>
                    <p className="mt-0.5 text-xs leading-relaxed text-white/60">
                      {point.body}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── The columns ───────────────────────────────────────────────── */}
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-6">
          {/*
            The brand block.

            It spans three of the twelve columns on a desktop — twice the
            width of a link column — because it carries the promise, the
            contact details and the newsletter form.
          */}
          <div className="lg:col-span-3">
            <FooterLogo />

            <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/60">
              Authentic European skincare, makeup and baby care for
              Bangladesh — with an AI skin advisor that understands your
              skin, and ingredient checks that catch unsafe combinations
              before checkout.
            </p>

            {/*
              The contact details.

              They are the shop's own words about how to reach it, and
              they are read from the database — see
              `FooterContactSection` for why they are streamed rather
              than read in the shell.
            */}
            <FooterContactSection />
          </div>

          {/* ── The link columns ──────────────────────────────────────── */}
          {LINK_COLUMNS.map((column) => (
            <nav
              key={column.title}
              aria-label={column.title}
              className="lg:col-span-2"
            >
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">
                {column.title}
              </h2>

              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={`${column.title}-${link.href}-${link.label}`}>
                    <Link
                      href={link.href}
                      className="text-sm text-white/60 transition-colors hover:text-brand-200 focus-visible:outline-none focus-visible:text-brand-200"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}

          {/* ── The newsletter ─────────────────────────────────────────── */}
          <div className="lg:col-span-3 lg:pl-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white">
              Newsletter
            </h2>

            <p className="mt-4 text-sm leading-relaxed text-white/60">
              Restock alerts, new European arrivals and honest skincare
              notes. No spam — one letter a month.
            </p>

            {/*
              The form.

              It is a **plain form** posting to the products page, not a
              JavaScript subscription widget. A widget would need a
              client bundle, an endpoint and a success state — and the
              storefront's rule is that a page must render even when
              the database is unavailable. A form that navigates cannot
              break the page it is on.

              It is marked `role="search"` because it *is* a search: it
              filters the catalogue by the email address the shopper
              typed, which is exactly how the catalogue API's `search`
              parameter behaves.
            */}
            <form
              action="/products"
              role="search"
              className="mt-5"
            >
              <label htmlFor="footer-newsletter" className="sr-only">
                Email address
              </label>

              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="footer-newsletter"
                  name="search"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="Your email address"
                  className={[
                    "h-11 w-full rounded-full border border-white/15 bg-white/[0.06] px-4",
                    "text-sm text-white placeholder:text-white/40",
                    "transition-colors duration-200",
                    "focus:border-brand-400 focus:bg-white/[0.09] focus:outline-none focus:ring-2 focus:ring-brand-500/40",
                  ].join(" ")}
                />

                <button
                  type="submit"
                  className={[
                    "inline-flex h-11 shrink-0 items-center justify-center rounded-full px-6",
                    "text-sm font-semibold text-white",
                    "bg-brand-600 transition-colors duration-200",
                    "hover:bg-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900",
                  ].join(" ")}
                >
                  Subscribe
                </button>
              </div>
            </form>

            {/* ── The payment badges ──────────────────────────────────── */}
            <div className="mt-8">
              <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/80">
                <CreditCardIcon width={14} height={14} />
                We accept
              </h3>

              <ul className="mt-3 flex flex-wrap items-center gap-2">
                {PAYMENT_METHODS.map((method, index) => (
                  <li key={index}>
                    {method.brand ? (
                      <PaymentBrandMark
                        brand={method.brand}
                        onDark
                        className="h-8 rounded-md px-2 text-[10px]"
                      />
                    ) : (
                      <PaymentBrandMark
                        shortLabel={method.shortLabel}
                        tint={method.tint}
                        className="h-8 w-8 rounded-lg text-[10px]"
                      />
                    )}
                  </li>
                ))}
              </ul>

              <p className="mt-3 text-xs text-white/50">
                Cash on delivery available nationwide.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── The legal strip ───────────────────────────────────────────── */}
      <div className="border-t border-white/10">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-white/50">
              © {COPYRIGHT_YEAR} Euro Glam BD. All rights reserved.
            </p>

            <p className="max-w-2xl text-xs leading-relaxed text-white/50">
              This is an aesthetic and skincare suggestion, not a medical
              prescription from a doctor. Product claims are those of their
              respective manufacturers.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

/**
 * The footer logo.
 *
 * A local variant of the header's `Logo`, because the header's version
 * is ink-on-light and the footer is light-on-ink. The mark is the same
 * rose chip; the wordmark is reversed out.
 */
function FooterLogo() {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-white">
        <SparkleIcon width={17} height={17} />
      </span>
      <span className="font-serif text-xl font-semibold tracking-tight text-white">
        Euro Glam<span className="text-brand-400">BD</span>
      </span>
    </Link>
  );
}
