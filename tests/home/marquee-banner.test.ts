import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The announcement marquee.
 *
 * ── Why these tests read the source rather than the rendered page ────────
 *
 * The rendered page is the real proof, but it needs a running server and
 * a database row switched on. The properties being protected, though,
 * are properties of the *shape* of the marquee — what it is allowed to
 * contain, and how it is allowed to move — and the shape is written in
 * the source.
 *
 * So these tests read the source tree. They are fast, they need no
 * database, and they fail the moment someone breaks the loop or moves
 * the motion into JavaScript.
 */

/**
 * The file's **code**, with its comments removed.
 *
 * A comment that *mentions* a class name is not the class being used.
 * The component's docblock discusses `flex-1` and the keyframe at
 * length, so the assertions below look at the code and not at the file.
 */
function readCode(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const HOME_DIR = path.join(process.cwd(), "src", "components", "home");
const LAYOUT_DIR = path.join(process.cwd(), "src", "components", "layout");
const MARQUEE = path.join(HOME_DIR, "marquee-banner.tsx");
const SECTION = path.join(LAYOUT_DIR, "marquee-banner-section.tsx");
const SHELL = path.join(LAYOUT_DIR, "app-shell.tsx");
const GLOBALS = path.join(process.cwd(), "src", "app", "globals.css");

describe("the marquee's markup", () => {
  const code = readCode(MARQUEE);

  it("renders nothing when there is nothing to say", () => {
    /*
     * The switch is the admin's, but the text is theirs too. A marquee
     * that is on but empty is a strip of coloured nothing at the top of
     * every page, and it looks like something broke.
     */
    expect(code).toContain('if (trimmed === "") return null;');
  });

  it("holds two copies of the message", () => {
    /*
     * Two copies are the whole trick. The animation moves the track by
     * exactly one copy's width, so the second copy arrives precisely
     * where the first started and the loop is seamless.
     */
    expect(code.match(/<MarqueeCopy/g)).toHaveLength(2);
  });

  it("makes the two copies equal, so the seam is exact", () => {
    /*
     * `flex-1` is what makes the copies **equal** rather than merely
     * identical: the track gives them the same width, and the `-50%`
     * translation lands precisely on the seam.
     */
    expect(code).toContain("flex flex-1 items-center whitespace-nowrap");
  });

  it("never lets the track be narrower than the frame", () => {
    /*
     * Without `min-w-[max(100%,max-content)]`, a short message would
     * leave a gap on the right of the strip — the track would be 120
     * pixels wide inside a 1200-pixel window.
     */
    expect(code).toContain("min-w-[max(100%,max-content)]");
  });

  it("keeps the copy on one line", () => {
    expect(code).toContain("whitespace-nowrap");
  });

  it("hides the duplicate copy from assistive technology", () => {
    /*
     * A screen reader would otherwise read the message twice. The first
     * copy carries the announcement once; the second is skipped.
     */
    expect(code).toContain(
      'aria-hidden={hidden ? "true" : undefined}',
    );
  });

  it("links the message only when there is somewhere to go", () => {
    /*
     * A link that goes nowhere is worse than no link — it looks
     * clickable and does nothing.
     */
    expect(code).toContain("{href ? (");
    expect(code).toContain("<span>{text}</span>");
  });
});

describe("the marquee's motion", () => {
  const code = readCode(MARQUEE);

  it("animates in CSS, not in JavaScript", () => {
    /*
     * A JavaScript loop would put a timer on every page of the store,
     * would keep running while the tab is hidden, and would fight the
     * browser's own compositing for no benefit.
     */
    expect(code).toContain("animate-[marquee-scroll_");
    expect(code).not.toContain("requestAnimationFrame");
    expect(code).not.toContain("setInterval");
    expect(code).not.toContain("useEffect");
  });

  it("moves the track with a transform", () => {
    // `transform` is the one property the compositor can animate without
    // touching layout.
    const css = fs.readFileSync(GLOBALS, "utf8");

    const from = css.indexOf("@keyframes marquee-scroll");
    expect(from).not.toBe(-1);

    const block = css.slice(from, css.indexOf("}", css.indexOf("to {", from)));

    expect(block).toContain("transform: translateX");
    expect(block).not.toContain("left:");
    expect(block).not.toContain("margin-left:");
  });

  it("moves the track by exactly one copy", () => {
    // Two equal copies, moved by half the track — which is one copy.
    const css = fs.readFileSync(GLOBALS, "utf8");

    expect(css).toContain("transform: translateX(-50%);");
  });

  it("stops the motion for anyone who asked for less motion", () => {
    /*
     * A marquee that scrolls forever is exactly the kind of motion the
     * reduced-motion setting exists to stop.
     */
    expect(code).toContain("motion-safe:animate-[marquee-scroll_");
  });

  it("pauses the motion when the announcement's link is focused", () => {
    /*
     * A keyboard user who has tabbed to the announcement must not be
     * chasing a moving target.
     *
     * And the `group` marker has to be on the **outer frame** — a
     * `group-focus-within` variant only matches a descendant of the
     * element carrying the marker, so a marker on the wrong side of the
     * animated element compiles cleanly and silently does nothing.
     */
    expect(code).toContain(
      "motion-safe:group-focus-within:[animation-play-state:paused]",
    );

    const groupIndex = code.indexOf('className="group relative overflow-hidden');
    const animationIndex = code.indexOf("animate-[marquee-scroll_");

    expect(groupIndex).toBeGreaterThan(-1);
    expect(animationIndex).toBeGreaterThan(-1);

    // The marker comes **before** the animated element in the source,
    // which is what puts it on an ancestor of it.
    expect(groupIndex).toBeLessThan(animationIndex);
  });

  it("scales the duration with the length of the message", () => {
    /*
     * The animation translates by a percentage, so a fixed duration
     * would make a long message move faster than a short one — and a
     * long message moving quickly is unreadable.
     */
    expect(code).toContain(
      '"--marquee-duration": trimmed.length <= 60 ? "30s" : "48s",',
    );
  });
});

describe("the marquee's edges", () => {
  const code = readCode(MARQUEE);

  it("fades each end, so the strip reads as continuous", () => {
    /*
     * The fade is what makes the strip read as continuous beyond the
     * frame rather than as a line of text with two hard edges. It also
     * hides the seam at the moment the loop restarts.
     */
    expect(code).toContain("linear-gradient(to right, ${background}, transparent)");
    expect(code).toContain("linear-gradient(to left, ${background}, transparent)");
  });

  it("fades to the bar's own ground, not to a fixed token", () => {
    /*
     * The bar's ground is the admin's now, so a fade built from a fixed
     * design-system token would leave a band of the wrong colour on a
     * bar the admin has repainted — the most visible possible way for
     * the colour feature to look broken.
     */
    expect(code).not.toContain("from-neutral-900");
    expect(code).not.toContain("bg-gradient-to-r");
  });

  it("does not let the fade intercept a click on the message", () => {
    expect(code).toContain("pointer-events-none");
  });
});

describe("the marquee's ground", () => {
  const code = readCode(MARQUEE);

  it("paints the ground and the type inline, from the admin's values", () => {
    /*
     * A colour that came from the database cannot be a Tailwind class —
     * a class is a fixed name compiled at build time, and the shop may
     * want a colour this codebase has never seen. So the two colours
     * arrive as inline `style` properties.
     */
    expect(code).toContain("style={{ backgroundColor: background, color: foreground }}");
  });

  it("falls back to the shop's darkest fill, in both themes", () => {
    /*
     * `#1c1917` is the **fill** step of the neutral ramp — the part that
     * deliberately does not re-point in the dark theme. A bar that
     * changed colour when the customer flipped to dark mode would be a
     * bar that is not the same bar any more.
     *
     * So a bar left at its default is the same warm near-black in both
     * themes, and the type on it is legible in both.
     */
    expect(code).toContain(
      'normalizeHexColor(backgroundColor ?? "") ?? DEFAULT_MARQUEE_BG',
    );
    expect(code).toContain(
      'normalizeHexColor(textColor ?? "") ?? DEFAULT_MARQUEE_TEXT',
    );
  });

  it("refuses a value that is not a colour", () => {
    /*
     * The value is untrusted input on its way into a `style` attribute,
     * so it is normalised before it is used — and a refused value falls
     * back to the default rather than leaving the bar unpainted.
     */
    expect(code).toContain("normalizeHexColor");
    expect(code).not.toContain("style={{ backgroundColor: backgroundColor");
  });

  it("does not use a theme-tinted background", () => {
    // The marquee is the same warm near-black in both themes.
    expect(code).not.toContain("bg-surface");
    expect(code).not.toContain("bg-brand-");
  });

  it("paints everything that sits on the ground with the ground", () => {
    /*
     * The separator is the type colour at a third of its strength, and
     * the focus ring's offset is the ground — so a rose bar with white
     * type does not end up with a white separator at full strength.
     */
    expect(code).toContain("style={{ color: textColor, opacity: 0.35 }}");
    expect(code).toContain('"--marquee-offset": backgroundColor');
  });

  it("meets the header with the page's own hairline", () => {
    expect(code).toContain("border-b border-border/70");
  });

  it("pads the frame, not the copies", () => {
    /*
     * The two copies must stay **equal in width**. Padding on one of
     * them and not the other would make them differ, and the `-50%`
     * translation would no longer land on the seam.
     */
    expect(code).toContain("py-2");
    expect(code).not.toContain("px-2 flex flex-1");
  });
});

describe("the marquee's section", () => {
  const code = readCode(SECTION);

  it("renders the marquee only when the switch is on", () => {
    expect(code).toContain("if (!settings.isMarqueeEnabled) return null;");
  });

  it("reads the settings at request time, not at build time", () => {
    /*
     * An announcement switched on after the last build would not appear
     * on a prerendered page, and one switched **off** would keep
     * appearing until the next build.
     */
    expect(code).toContain("await connection();");
  });

  it("streams behind a Suspense boundary", () => {
    expect(code).toContain("<Suspense fallback={null}>");
  });

  it("fails to an absent banner rather than to an empty one", () => {
    /*
     * The marquee's height is not knowable in advance, so reserving a
     * strip that then turns out to be empty would be the very thing the
     * empty bar is supposed to avoid.
     */
    expect(code).toContain("fallback={null}");
  });
});

describe("the storefront's shell", () => {
  const code = readCode(SHELL);

  it("mounts the marquee above the header", () => {
    /*
     * It is the shop's **first sentence**, and the header is the shop's
     * name. The name is permanent; the sentence is this week.
     */
    const marqueeIndex = code.indexOf("<MarqueeBannerSection />");
    const headerIndex = code.indexOf("<SiteHeader />");

    expect(marqueeIndex).toBeGreaterThan(-1);
    expect(headerIndex).toBeGreaterThan(-1);
    expect(marqueeIndex).toBeLessThan(headerIndex);
  });
});
