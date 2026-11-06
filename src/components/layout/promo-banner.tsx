import Link from "next/link";

import { SparkleIcon } from "@/components/ui/icons";
import type { PublicCoupon } from "@/lib/format/types";

/**
 * The promotional announcement bar.
 *
 * ── What this banner is for ───────────────────────────────────────────────
 *
 * The admin desk creates campaigns; this bar is where they become
 * **visible**. A coupon that exists in the database but that no customer
 * can find is a coupon that earns nothing.
 *
 * So the bar does one job: it shows the codes that are live right now,
 * and it makes each of them **one click away from being applied**. The
 * customer lands on the cart with the code already in the field — they
 * press apply, and the discount is on.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. It renders nothing when there is nothing to say.**
 *
 * A shop with no active campaigns shows no bar at all. An empty bar is a
 * strip of coloured nothing that pushes the page down, and it looks like
 * something broke.
 *
 * **2. It shows the codes, not the arithmetic.**
 *
 * The label — "20% off", "৳200 off" — is computed by the server from the
 * coupon's own terms. The banner never re-derives it, because the
 * checkout is the one that charges the customer, and the two must not
 * disagree about what a code is worth.
 *
 * **3. The expiry is shown, because a code with a deadline should say so.**
 *
 * A customer who sees "expires in 3 days" can act on it. A customer who
 * sees only "20% off" has no idea whether to hurry.
 */
export type PromoBannerProps = {
  readonly coupons: readonly PublicCoupon[];
  /**
   * The current time, as a Unix timestamp in milliseconds.
   *
   * Passed in rather than read here, because `Date.now()` cannot be
   * called during a prerender — Next.js refuses to bake a build-time
   * timestamp into a static page, and a countdown frozen at build time
   * would tell a customer that an expired code still has four days left.
   *
   * The caller reads the clock at **request time** and hands it down.
   */
  readonly now: number;
};

/**
 * The number of days until a code expires, or `null` when it has already
 * expired.
 *
 * The date is parsed here rather than passed in because the banner is
 * rendered on the server, and the server's clock is the clock the
 * customer will be charged against.
 *
 * The "now" is passed in rather than read here, because `Date.now()`
 * cannot be called during a prerender — Next.js refuses to bake a
 * build-time timestamp into a static page, and a countdown frozen at
 * build time is worse than no countdown at all. The caller reads the
 * clock at request time and hands it down.
 */
function daysUntil(isoTimestamp: string, now: number): number | null {
  const expiry = new Date(isoTimestamp).getTime();

  if (Number.isNaN(expiry)) return null;

  const remaining = expiry - now;

  if (remaining <= 0) return null;

  return Math.ceil(remaining / (24 * 60 * 60 * 1000));
}

/**
 * How the expiry reads to the customer.
 */
function expiryLabel(isoTimestamp: string, now: number): string | null {
  const days = daysUntil(isoTimestamp, now);

  if (days === null) return null;
  if (days === 1) return "Ends tomorrow";
  if (days <= 7) return `Ends in ${days} days`;

  return `Ends in ${days} days`;
}

export function PromoBanner({ coupons, now }: PromoBannerProps) {
  /*
   * Only the codes that are still good are shown.
   *
   * The service already filters on `isActive` and `expiresAt`, but a
   * coupon that expires between the query and the render would otherwise
   * be advertised for a moment after it stopped working. Filtering again
   * here costs nothing and closes that window.
   */
  const live = coupons.filter(
    (coupon) => daysUntil(coupon.expiresAt, now) !== null,
  );

  if (live.length === 0) return null;

  return (
    <div className="border-b border-brand-200/70 bg-brand-50/80 dark:border-brand-800/60 dark:bg-brand-950/60">
      <div className="mx-auto flex max-w-7xl items-center gap-3 overflow-hidden px-4 py-2 sm:px-6 lg:px-8">
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-700 dark:text-brand-300 sm:inline-flex">
          <SparkleIcon width={14} height={14} />
          Offers
        </span>

        {/*
         * The codes scroll horizontally on a phone and sit on one line on
         * a desktop. `overflow-x-auto` rather than `hidden`, because a
         * clipped code is a code nobody can read.
         */}
        <ul className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {live.map((coupon) => {
            const expiry = expiryLabel(coupon.expiresAt, now);

            return (
              <li key={coupon.code} className="shrink-0">
                <Link
                  href={`/cart?coupon=${encodeURIComponent(coupon.code)}`}
                  className="inline-flex items-center gap-2 rounded-full border border-brand-300/80 bg-surface px-3 py-1 text-xs text-foreground transition-colors hover:border-brand-500 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:border-brand-800 dark:hover:bg-brand-900/60"
                >
                  {/*
                   * The code is the point of the banner, so it is
                   * presented as a **token** — the thing the customer
                   * copies — rather than as a word in a sentence.
                   */}
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                    {coupon.code}
                  </span>

                  <span className="text-foreground-muted">{coupon.label}</span>

                  {expiry ? (
                    <span className="text-[10px] font-medium text-foreground-muted">
                      {expiry}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
