/**
 * The hero's slides.
 *
 * ── Why this file is separate from `hero-slider.tsx` ─────────────────────
 *
 * The slider is a `"use client"` component, and a server component may
 * only import **components** from a client module — not plain data. If
 * the slide definitions lived in the slider, the home page could not
 * read them in order to resolve each slide's artwork.
 *
 * So the definitions live here, in a module with no directive, and
 * both sides import them: the server to build the slides the page
 * actually renders, and the client slider to fall back to them when it
 * is rendered without the admin's banners.
 *
 * ── The media rule ───────────────────────────────────────────────────────
 *
 * A slide's artwork is **never a hard-coded path**. Every image on this
 * site comes from the storage adapter by key, and the keys live in the
 * database — the uploads directory is not committed, so a literal
 * `/uploads/hero/...` in source would resolve on the shop's machine and
 * 404 everywhere else.
 *
 * So the admin's banner carries the artwork's **key**, and the server
 * resolves it to a URL through the storage adapter. A banner with no
 * artwork falls back to the gradient wash alone, which is a complete
 * design in its own right.
 *
 * ── Why there is no product mockup here ──────────────────────────────────
 *
 * The hero used to carry a second column: a raised plate holding the
 * shop's product photography, sometimes one bottle and sometimes a row
 * of three.
 *
 * It was removed. A hero is a **poster**, not a shelf — and a poster
 * with three product thumbnails beside the headline is neither. Every
 * extra object on the panel competes with the one thing the panel is
 * for, which is the sentence the shop is saying.
 *
 * The consequence is visible in this file: a slide is now **copy and a
 * ground**. The eyebrow, the headline, the supporting line, the two
 * calls to action, the trust points, a gradient wash and an optional
 * photograph. There is nothing else, and there is nothing to resolve.
 */

/**
 * One slide.
 */
export type HeroSlide = {
  readonly id: string;
  /** The brand or campaign name — the eyebrow. */
  readonly eyebrow: string;
  /** The headline. */
  readonly title: string;
  /** The supporting line. */
  readonly body: string;
  /** The primary call to action. */
  readonly cta: { readonly href: string; readonly label: string };
  /** The secondary call to action. */
  readonly secondaryCta: { readonly href: string; readonly label: string };
  /** The trust points shown on this slide. */
  readonly trust: readonly string[];
  /**
   * The gradient wash for this slide.
   *
   * Each slide leans a different way, so the slider feels like a
   * sequence of distinct promotions rather than one slide repeated.
   */
  readonly gradient: string;
  /** The accent colour for the slide's decorative glow. */
  readonly glow: string;
  /**
   * The slide's background artwork — a **storage key**, or `null`.
   *
   * Absent on the static slides, which have no artwork of their own, and
   * present on the slides the admin creates in the panel.
   *
   * The artwork is the **background**, never the subject: the copy is
   * laid over it behind a scrim, so the headline stays readable whatever
   * the picture is. A slide with no artwork falls back to the gradient
   * wash alone, which is a complete design in its own right.
   */
  readonly image?: string | null;
};

/**
 * The slides.
 *
 * These are the shop's real editorial campaigns. Every one of them
 * points at a real, filtered catalogue view — a slide that goes nowhere
 * is a lie.
 */
export const HERO_SLIDES: readonly HeroSlide[] = [
  {
    id: "laroche-posay",
    eyebrow: "La Roche-Posay",
    title: "Derm-science for skin that reacts",
    body: "Anthelios UVMune 400, Effaclar and Cicaplast — the French pharmacy range, authorised and stocked locally. Prescription-strength actives without a prescription.",
    cta: { href: "/products?search=La%20Roche-Posay", label: "Shop La Roche-Posay" },
    secondaryCta: { href: "/products?category=sunscreens", label: "Explore sunscreens" },
    trust: ["Dermatologist tested", "Authenticity guaranteed"],
    gradient:
      "bg-[linear-gradient(135deg,#fff1f5_0%,#ffe4ed_38%,#ffffff_78%)]",
    glow: "bg-brand-300/50",
  },
  {
    id: "cerave",
    eyebrow: "CeraVe",
    title: "Ceramides that your barrier recognises",
    body: "Three essential ceramides and hyaluronic acid in every formula. The cleanser and the moisturiser were designed to work together — so use them together.",
    cta: { href: "/products?search=CeraVe", label: "Shop CeraVe" },
    secondaryCta: { href: "/products?category=cleansers", label: "Find a cleanser" },
    trust: ["Developed with dermatologists", "Fragrance free"],
    gradient:
      "bg-[linear-gradient(135deg,#eff6ff_0%,#e0e7ff_40%,#ffffff_80%)]",
    glow: "bg-indigo-300/40",
  },
  {
    id: "ordinary",
    eyebrow: "The Ordinary",
    title: "One active. One price. No theatre.",
    body: "Niacinamide 10%, Salicylic Acid 2%, Ascorbyl Glucoside 12% — the formulations the whole industry copies, sold without the markup.",
    cta: { href: "/products?search=The%20Ordinary", label: "Shop The Ordinary" },
    secondaryCta: { href: "/products?category=serums", label: "Browse all serums" },
    trust: ["Single-ingredient focus", "Ingredient-led formulas"],
    gradient:
      "bg-[linear-gradient(135deg,#f7f5f0_0%,#eceae4_45%,#ffffff_82%)]",
    glow: "bg-stone-300/50",
  },
  {
    id: "advisor",
    eyebrow: "AI Skin Advisor",
    title: "Your routine, built for your skin",
    body: "A photo, four questions, and a routine that accounts for 35°C and 80% humidity — with ingredient conflicts checked before you check out.",
    cta: { href: "/advisor", label: "Try the AI Skin Advisor" },
    secondaryCta: { href: "/products", label: "Shop all products" },
    trust: ["Climate-aware guidance", "Conflict checking"],
    gradient:
      "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
    glow: "bg-brand-400/45",
  },
];
