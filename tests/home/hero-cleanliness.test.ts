import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HERO_SLIDES } from "@/components/home/hero-slides";

/**
 * The hero's cleanliness.
 *
 * ── The bug this test exists to prevent ───────────────────────────────────
 *
 * The hero panel used to be split in two: the copy on the left, and on
 * the right a raised white plate holding the shop's product
 * photography — one bottle for a brand slide, a **row of three
 * thumbnails** for the advisor slide, each in its own box with its own
 * shadow.
 *
 * The complaint was that the right-hand side of the hero was cluttered.
 * It was: the second column was not decoration, it was a *catalogue* —
 * three product tiles with names and prices, sitting in the most
 * valuable eight hundred pixels on the page, competing with the
 * headline. A shopper glancing at the panel could not tell whether they
 * were reading an advertisement or looking at a shelf.
 *
 * The fix was to remove the column. A hero is a **poster**, and a poster
 * has one subject: the words.
 *
 * ── Why these tests read the source rather than the rendered page ────────
 *
 * The rendered page is the real proof, but it needs a running server.
 * The property being protected, though, is a property of the *shape* of
 * the hero — what it is allowed to contain — and the shape is written
 * in the source.
 *
 * So these tests read the source tree. They are fast, they need no
 * database, and they fail the moment someone puts a product plate
 * back — which is exactly the edit that would reintroduce the clutter.
 */

/**
 * The file's **code**, with its comments removed.
 *
 * A comment that *mentions* a class name is not the class being used.
 * The old code discussed the product plate at length, so the assertions
 * below look at the code and not at the file.
 */
function readCode(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const HOME_DIR = path.join(process.cwd(), "src", "components", "home");
const SLIDER = path.join(HOME_DIR, "hero-slider.tsx");
const SLIDES = path.join(HOME_DIR, "hero-slides.ts");

/**
 * The code of one region of a file.
 *
 * `start` and `end` are **code** markers, not prose — the comments are
 * stripped before the slice is taken, so a marker that only appears in a
 * comment would never match.
 */
function readRegion(source: string, start: string, end: string): string {
  const from = source.indexOf(start);

  if (from === -1) return "";

  const to = source.indexOf(end, from);

  return source.slice(from, to === -1 ? undefined : to);
}

/**
 * The body of one CSS block, from its selector to its closing brace.
 *
 * A plain slice to the end of the file would be wrong here: the dark
 * theme's block is followed by the `@theme inline` block, which
 * legitimately mentions the hero's tokens — it is the *block* that must
 * not re-point them, not the whole rest of the stylesheet.
 */
function readCssBlock(css: string, selector: string): string {
  const from = css.indexOf(selector);

  if (from === -1) return "";

  const to = css.indexOf("\n}", from);

  return css.slice(from, to === -1 ? undefined : to);
}

describe("the hero slider's markup", () => {
  const code = readCode(SLIDER);

  it("renders no product plate", () => {
    /*
     * The old right-hand column. `HeroMockup` was the plate, and
     * `MockupTile` was one product thumbnail in it.
     */
    expect(code).not.toContain("HeroMockup");
    expect(code).not.toContain("MockupTile");
    expect(code).not.toContain("MockupLabel");
  });

  it("renders no product image tile at all", () => {
    // A thumbnail box is a rounded frame holding one product's
    // photograph. The hero has none.
    expect(code).not.toContain("aspect-square");
    expect(code).not.toContain("object-contain");
  });

  it("does not split the panel into two columns", () => {
    /*
     * The split was a two-column grid: the copy on the left, the
     * product plate on the right. Without a second column there is
     * nothing to split — the copy sits on one wide measure and the rest
     * of the panel is the ground it sits on.
     */
    expect(code).not.toContain("lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]");
    expect(code).not.toContain("grid-cols-3");
  });

  it("keeps the copy in one column, on a readable measure", () => {
    // The headline is still on its own measure, and the supporting
    // line is still short enough to be read rather than scanned.
    expect(code).toContain("max-w-[15ch]");
    expect(code).toContain("max-w-xl");
  });

  it("renders the two calls to action", () => {
    expect(code).toContain("slide.cta.href");
    expect(code).toContain("slide.cta.label");
    expect(code).toContain("slide.secondaryCta.href");
    expect(code).toContain("slide.secondaryCta.label");
  });

  it("renders the headline, the supporting line and the trust points", () => {
    expect(code).toContain("{slide.title}");
    expect(code).toContain("{slide.body}");
    expect(code).toContain("{slide.eyebrow}");
    expect(code).toContain("slide.trust.map");
  });
});

describe("the hero's contrast treatment", () => {
  const code = readCode(SLIDER);

  it("veils the artwork so the copy stays legible over it", () => {
    /*
     * The artwork is arbitrary — an admin's photograph, a campaign's
     * key visual — and the copy has to stay readable over *any* of
     * them. The scrim is what makes the artwork usable at all.
     *
     * Two layers: a flat veil that knocks the picture back to a
     * texture, and a directional wash that takes the ground the rest of
     * the way to white on the left, where the copy sits.
     */
    expect(code).toContain("bg-white/60");
    expect(code).toContain(
      "bg-gradient-to-r from-white via-white/85 to-white/25",
    );
  });

  it("does not let the scrim intercept a click on a call to action", () => {
    expect(code).toContain("pointer-events-none");
  });

  it("sets the copy in the hero's own ink, not the theme's foreground", () => {
    /*
     * The hero panel is a light poster in **both** themes — its
     * gradients are pale washes and its artwork sits behind a white
     * scrim. So `text-foreground` would be near-white in the dark
     * theme, and near-white type on a near-white ground is
     * unreadable.
     *
     * The hero carries its own ink for exactly this reason.
     *
     * The assertion is on the **copy block** alone. The carousel's
     * controls sit *below* the panel, on the ordinary page canvas,
     * where `text-foreground-muted` is exactly right — the canvas is
     * dark in the dark theme and the controls have to invert with it.
     * So the hero's ink rule applies to the panel, not to the page.
     */
    const copy = readRegion(code, "relative max-w-2xl", "aria-label={`Go to slide");

    expect(copy).toContain("text-hero-ink");
    expect(copy).toContain("text-hero-ink-muted");
    expect(copy).not.toContain("text-foreground");
  });

  it("keeps the calls to action on the hero's own accent", () => {
    expect(code).toContain('variant="hero"');
    expect(code).toContain('variant="heroOutline"');
  });
});

describe("the hero's tokens", () => {
  const css = fs.readFileSync(
    path.join(process.cwd(), "src", "app", "globals.css"),
    "utf8",
  );

  it("defines the hero's ink", () => {
    expect(css).toContain("--hero-ink:");
    expect(css).toContain("--hero-ink-muted:");
  });

  it("exposes the hero's ink as a Tailwind colour", () => {
    expect(css).toContain("--color-hero-ink: var(--hero-ink);");
    expect(css).toContain(
      "--color-hero-ink-muted: var(--hero-ink-muted);",
    );
  });

  it("does not re-point the hero's ink in the dark theme", () => {
    /*
     * The rule that makes the hero readable in the dark theme is that
     * its ink **does not change**. The dark block re-points the neutral
     * and brand ramps; if it re-pointed the hero's ink too, the hero
     * would go light-on-light and become unreadable.
     *
     * The assertion is on the **dark block alone** — the hero's tokens
     * are declared in `:root`, and the dark block must not mention them.
     *
     * The block is read up to its own closing brace, not to the end of
     * the file: the `@theme inline` block that follows it legitimately
     * names the hero's tokens, because that is where they are exposed
     * to Tailwind.
     */
    const darkBlock = readCssBlock(css, ".dark {");

    expect(darkBlock).not.toContain("--hero-ink");
    expect(darkBlock).not.toContain("--hero-accent");
  });
});

describe("the hero's slide shape", () => {
  it("carries the copy and the ground, and nothing else", () => {
    /*
     * A slide's vocabulary is pinned exactly. A new field is a new
     * thing on the panel — and the panel has exactly one subject.
     */
    for (const slide of HERO_SLIDES) {
      expect(Object.keys(slide).sort()).toEqual([
        "body",
        "cta",
        "eyebrow",
        "glow",
        "gradient",
        "id",
        "secondaryCta",
        "title",
        "trust",
      ]);
    }
  });

  it("declares no media source, so a product plate cannot be asked for", () => {
    const slides = fs.readFileSync(SLIDES, "utf8");

    expect(slides).not.toContain("mediaSource");
    expect(slides).not.toContain("HeroMedia");
    expect(slides).not.toContain("HeroMediaProduct");
  });
});
