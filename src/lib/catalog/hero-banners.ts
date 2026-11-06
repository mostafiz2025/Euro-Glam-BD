import { db } from "@/lib/db";

/**
 * The public hero banners.
 *
 * ── Why the storefront half lives in its own module ───────────────────────
 *
 * The admin half — create, edit, delete — is in
 * `src/lib/admin/hero-banners.ts`, and it is allowed to do things the
 * storefront is not: switch a banner off, delete one, write an audit
 * entry. The storefront half has exactly one job — **show the banners
 * that are on** — and it has to do it without any of the admin
 * machinery.
 *
 * So the two are separate modules. A read path that reaches for the
 * admin service would drag the audit writer into the page render for
 * no reason, and would give the storefront a way to see banners that
 * are switched off.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. Only active banners are returned.**
 *
 * A switched-off banner is not a deleted one. It stays in the table so
 * the audit trail has something to describe, and it stays out of the
 * carousel so no customer sees it.
 *
 * **2. The order is the admin's order.**
 *
 * `sortOrder` first, then creation time. The admin arranges the
 * carousel by setting that number, and this is where the arrangement is
 * honoured.
 *
 * **3. The cap is a real one.**
 *
 * The carousel is a *carousel*. Forty banners is forty slides the
 * shopper has to sit through — the autoplay timer means they watch all
 * of them — so the list is capped at a number that can actually be
 * watched. The newest banners win the cap, because a campaign that has
 * just been created is the one the shop most wants seen.
 */
import type { HeroBannerSummary } from "@/lib/format/types";

/**
 * The maximum number of banners the carousel will show.
 *
 * Five. A shopper who lands on the page watches the carousel at seven
 * seconds a slide; five slides is about half a minute of carousel before
 * the first product appears below it, which is the most a storefront can
 * ask for and still be a storefront.
 */
export const MAX_HERO_BANNERS = 5;

/**
 * The Prisma select for a public hero banner.
 */
const PUBLIC_HERO_BANNER_SELECT = {
  id: true,
  eyebrow: true,
  title: true,
  body: true,
  ctaLabel: true,
  ctaHref: true,
  secondaryCtaLabel: true,
  secondaryCtaHref: true,
  trust: true,
  image: true,
  gradient: true,
  glow: true,
  sortOrder: true,
} as const;

/**
 * Lists the banners the storefront should show.
 *
 * Never throws — the caller catches, but a helper that returns an empty
 * list is the honest answer to "there are no banners", and the caller
 * falls back to the static slides either way.
 */
export async function listPublicHeroBanners(): Promise<
  HeroBannerSummary[]
> {
  const banners = await db.heroBanner.findMany({
    where: { isActive: true },
    select: PUBLIC_HERO_BANNER_SELECT,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: MAX_HERO_BANNERS,
  });

  return banners;
}
