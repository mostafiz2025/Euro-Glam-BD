import { describe, expect, it } from "vitest";

import { toHeroSlide, toHeroSlides } from "@/lib/format/hero-banners";
import type { HeroBannerSummary } from "@/lib/format/types";

/**
 * Turning database banners into hero slides.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The admin service stores a **record** — the columns as they are
 * persisted. The carousel renders a **slide** — the shape the slider
 * expects, with the copy's fields renamed from `ctaLabel`/`ctaHref` to
 * `cta: { label, href }`.
 *
 * The mapping is where a bug would be invisible: a mis-mapped field
 * would not throw, and the storefront would simply show a banner with
 * the wrong link on it, or with no link at all. So the mapping is
 * asserted field by field rather than by a snapshot.
 */

/**
 * A complete banner record.
 */
function banner(overrides: Partial<HeroBannerSummary> = {}): HeroBannerSummary {
  return {
    id: "banner-1",
    eyebrow: "La Roche-Posay",
    title: "Derm-science for skin that reacts",
    body: "The French pharmacy range, authorised and stocked locally.",
    ctaLabel: "Shop La Roche-Posay",
    ctaHref: "/products?search=La%20Roche-Posay",
    secondaryCtaLabel: "Explore sunscreens",
    secondaryCtaHref: "/products?category=sunscreens",
    trust: ["Dermatologist tested"],
    image: null,
    gradient:
      "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
    glow: "bg-brand-400/45",
    ...overrides,
  };
}

describe("toHeroSlide", () => {
  it("maps the copy across", () => {
    const slide = toHeroSlide(banner());

    expect(slide.id).toBe("banner-1");
    expect(slide.eyebrow).toBe("La Roche-Posay");
    expect(slide.title).toBe("Derm-science for skin that reacts");
    expect(slide.body).toBe(
      "The French pharmacy range, authorised and stocked locally.",
    );
  });

  it("maps the two calls to action into their nested shape", () => {
    const slide = toHeroSlide(banner());

    expect(slide.cta).toEqual({
      href: "/products?search=La%20Roche-Posay",
      label: "Shop La Roche-Posay",
    });

    expect(slide.secondaryCta).toEqual({
      href: "/products?category=sunscreens",
      label: "Explore sunscreens",
    });
  });

  it("maps the trust points across", () => {
    expect(toHeroSlide(banner()).trust).toEqual(["Dermatologist tested"]);
  });

  it("maps the gradient and the glow across", () => {
    const slide = toHeroSlide(banner());

    expect(slide.gradient).toBe(
      "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
    );
    expect(slide.glow).toBe("bg-brand-400/45");
  });

  it("carries the artwork key across, so the slider can resolve it", () => {
    const slide = toHeroSlide(
      banner({ image: "hero/2026/11/abcdef0123456789.png" }),
    );

    expect(slide.image).toBe("hero/2026/11/abcdef0123456789.png");
  });

  it("carries a banner with no artwork across as null", () => {
    // The slider falls back to the gradient wash when the artwork is
    // absent, so the absence has to survive the mapping rather than
    // becoming `undefined`.
    expect(toHeroSlide(banner()).image).toBeNull();
  });

  it("carries no product mockup", () => {
    /*
     * The hero is a **poster**: the words, a gradient wash and an
     * optional photograph behind them. There is no second column of
     * product cards, and no field on a slide that could ask for one.
     *
     * The assertion is on the *shape*, not on a value: a slide has no
     * `media` and no `mediaSource`, so there is no way for a banner to
     * smuggle a product plate back into the panel.
     */
    const slide = toHeroSlide(banner());

    expect(slide).not.toHaveProperty("media");
    expect(slide).not.toHaveProperty("mediaSource");
  });

  it("carries nothing but the copy and the ground", () => {
    /*
     * A slide's whole vocabulary is the words and the surfaces they sit
     * on. Anything else on the panel is clutter competing with the
     * headline, so the set of keys is pinned exactly.
     */
    const slide = toHeroSlide(banner());

    expect(Object.keys(slide).sort()).toEqual([
      "body",
      "cta",
      "eyebrow",
      "glow",
      "gradient",
      "id",
      "image",
      "secondaryCta",
      "title",
      "trust",
    ]);
  });
});

describe("toHeroSlides", () => {
  it("maps a list of banners", () => {
    const slides = toHeroSlides([
      banner({ id: "banner-1" }),
      banner({ id: "banner-2", title: "Second banner" }),
    ]);

    expect(slides).toHaveLength(2);
    expect(slides[0].id).toBe("banner-1");
    expect(slides[1].title).toBe("Second banner");
  });

  it("returns an empty list for no banners", () => {
    // An empty list is a legitimate answer — it means the shop has no
    // banners — and the caller falls back to the static slides.
    expect(toHeroSlides([])).toEqual([]);
  });
});
