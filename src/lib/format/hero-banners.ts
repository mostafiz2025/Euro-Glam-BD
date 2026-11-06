import type { HeroSlide } from "@/components/home/hero-slides";
import type { HeroBannerSummary } from "@/lib/format/types";

/**
 * Turning database banners into hero slides.
 *
 * ── Why the mapping lives here and not in the service ─────────────────────
 *
 * The service returns the *record* — the columns as they are stored. The
 * slider needs a *slide* — the shape the carousel renders, with the
 * copy's fields renamed from `ctaLabel`/`ctaHref` to `cta: { label, href }`.
 *
 * The mapping is a **presentation** concern, and it lives on the
 * presentation side of the line. Putting it in the service would mean
 * the database read knew about the slider's vocabulary, and the admin
 * service — which renders a completely different shape for the admin
 * panel — would have to know about it too.
 *
 * ── Why the static slides are still the fallback ─────────────────────────
 *
 * The home page never shows an empty hero. If the shop has no banners,
 * or the banner query fails, the page shows the four campaigns that
 * ship with the code. So the storefront is never worse than it was
 * before the admin panel existed — it is only ever better.
 *
 * ── Why a slide is only ever copy and a ground ────────────────────────────
 *
 * The mapping is deliberately thin. A slide carries the words, the two
 * calls to action, the trust points, a gradient wash, an accent glow and
 * an optional photograph — and nothing else.
 *
 * It used to carry more. A banner could name a **brand** or a
 * **category**, and the server would resolve those against the
 * catalogue and put the products in a plate beside the copy. That plate
 * is gone: a hero is a poster, and a poster with three product
 * thumbnails beside the headline is a shelf, not a poster.
 *
 * So the mapping no longer resolves anything, and a banner's `image`
 * is the only visual it brings with it.
 */

/**
 * Turns one database banner into a hero slide.
 */
export function toHeroSlide(banner: HeroBannerSummary): HeroSlide {
  return {
    id: banner.id,
    eyebrow: banner.eyebrow,
    title: banner.title,
    body: banner.body,
    cta: { href: banner.ctaHref, label: banner.ctaLabel },
    secondaryCta: {
      href: banner.secondaryCtaHref,
      label: banner.secondaryCtaLabel,
    },
    trust: banner.trust,
    gradient: banner.gradient,
    glow: banner.glow,
    image: banner.image,
  };
}

/**
 * Turns the database banners into hero slides.
 *
 * An empty list is a legitimate answer — it means the shop has no
 * banners yet — and the caller falls back to the static slides.
 */
export function toHeroSlides(
  banners: readonly HeroBannerSummary[],
): HeroSlide[] {
  return banners.map(toHeroSlide);
}
