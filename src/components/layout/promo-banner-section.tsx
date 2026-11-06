import { connection } from "next/server";
import { Suspense } from "react";

import { PromoBanner } from "@/components/layout/promo-banner";
import { fetchActiveCoupons } from "@/lib/format/server-data";

/**
 * The promotional announcement bar, with its data.
 *
 * ── Why this wrapper exists ──────────────────────────────────────────────
 *
 * The coupons live in the database, and a banner that has to ask the
 * database for its contents cannot be part of the static shell. So the
 * data is fetched **on the server** and handed down as plain props.
 *
 * This is the same split `CategoryNavSection` uses, and it exists for the
 * same two reasons:
 *
 *   1. **The Prisma engine stays out of the browser bundle.** The
 *      component that renders the banner is a pure server component; the
 *      client never touches the database.
 *
 *   2. **The page does not wait for the banner.** The fetch is streamed
 *      behind a `<Suspense>` boundary, so the rest of the storefront
 *      ships while the coupon query is still running.
 *
 * The fallback reserves the bar's height so the page does not jump when
 * the real banner replaces it.
 */

/**
 * The bar, with the active coupons loaded.
 *
 * ── Why `connection()` is called here ─────────────────────────────────────
 *
 * The coupon query reads the **clock** — it asks which campaigns have
 * not expired yet. Next.js cannot bake "now" into a prerendered page:
 * the timestamp would be frozen at build time, and a code that had
 * expired by the time the customer arrived would still be advertised.
 *
 * So the read is marked **request-bound** with `connection()`. That
 * excludes this component from the prerender, and it streams in from
 * the `<Suspense>` boundary below — once per request, with the clock
 * that matters.
 *
 * The boundary must stay **around** this component rather than inside
 * it: `connection()` opts the whole subtree out of the prerender, and
 * the shell around it — the header, the footer, the rest of the page —
 * stays prerendered and ships instantly.
 */
async function PromoBannerContent() {
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts the prerender.
  await connection();

  const { coupons, now } = await fetchActiveCoupons();

  return <PromoBanner coupons={coupons} now={now} />;
}

/**
 * The placeholder shown while the coupons load.
 *
 * It reserves the bar's height with a neutral placeholder, so the page
 * does not change size when the real bar arrives. It carries no text,
 * because a placeholder that says "loading" reads as a message the shop
 * wrote — and a shop that has no coupons should show no bar at all.
 *
 * The height matches the real bar's on **every** screen size. A
 * placeholder that was hidden on a phone and shown on a desktop would
 * mean the bar pushed the page down as it arrived on one screen and not
 * the other, and the page would jump under the customer's finger.
 */
function PromoBannerFallback() {
  return (
    <div
      aria-hidden="true"
      className="h-9 border-b border-border/60 bg-brand-50/60"
    />
  );
}

/**
 * The announcement bar section.
 *
 * It renders **nothing at all** when there are no active coupons. A shop
 * with no campaigns should show no banner — an empty bar is just a strip
 * of coloured nothing that pushes the page down.
 */
export function PromoBannerSection() {
  return (
    <Suspense fallback={<PromoBannerFallback />}>
      <PromoBannerContent />
    </Suspense>
  );
}
