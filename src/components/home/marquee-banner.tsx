import type { CSSProperties } from "react";
import Link from "next/link";

import {
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
  normalizeHexColor,
} from "@/lib/format/colors";

/**
 * The announcement marquee.
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 * A single line of the shop's own words, scrolling slowly across the
 * top of the storefront.
 *
 * It is the shop's **first sentence**. Everything else on the page —
 * the hero, the products, the footer — is answering a question the
 * shopper has not asked yet; this is the one line the shop gets to say
 * unprompted, so it says the thing that matters this week: a delivery
 * promise, a campaign, a new range.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. It renders nothing when there is nothing to say.**
 *
 * The switch is the admin's, but the text is theirs too, and a marquee
 * that is on but empty is a strip of coloured nothing at the top of
 * every page. It looks like something broke. So the component checks
 * the text itself rather than trusting the switch to have been set in
 * step with it.
 *
 * **2. The animation is CSS, not JavaScript.**
 *
 * The scroll is a `transform` on a single element, driven by a
 * keyframe. A JavaScript loop would put a timer on every page of the
 * store, would keep running while the tab is hidden, and would fight
 * the browser's own compositing for no benefit. `transform` is the one
 * property the compositor can animate without touching layout, so the
 * scroll stays smooth on a cheap phone.
 *
 * **3. The content is duplicated, and that is the whole trick.**
 *
 * The track holds **two** identical copies of the message, and the
 * animation translates it by exactly **one** copy's width. When the
 * first copy has scrolled fully out of view, the second is exactly
 * where the first started — so the loop is seamless and the strip
 * never shows a gap.
 *
 * The two copies are made **equal** rather than merely identical: each
 * one is a `flex-1` item of the track, so they always take the same
 * width however long the message is. Equal copies are what makes the
 * `-50%` translation land precisely on the seam.
 *
 * **4. The track is never narrower than the frame.**
 *
 * `min-width: max(100%, max-content)` — the track is at least as wide
 * as the window it scrolls through, and at least as wide as its own
 * content. Without it, a short message would leave a gap on the right
 * of the strip: the track would be 120 pixels wide inside a 1200-pixel
 * window, and the window would show mostly nothing.
 *
 * **5. The duplicate copy is hidden from assistive technology.**
 *
 * A screen reader would otherwise read the message twice. The second
 * copy is `aria-hidden`; the first carries the announcement once, and
 * its link is focusable — so the announcement is reachable by keyboard
 * and by a screen reader, exactly once.
 *
 * **6. The motion stops for anyone who asked it to, and pauses for
 * anyone using it.**
 *
 * `motion-safe:` switches the animation off entirely for visitors who
 * have asked their system for less motion — a marquee that scrolls
 * forever is exactly the kind of motion that setting exists to stop,
 * and it is also the kind that triggers nausea for some people.
 *
 * And the scroll **pauses when the link inside it is focused**, so a
 * keyboard user who has tabbed to the announcement is not chasing a
 * moving target.
 *
 * The pause is a `group-focus-within` variant, and that variant only
 * matches a **descendant** of the element carrying the `group` marker.
 * So the marker sits on the outer frame — which is the animated
 * element's ancestor — rather than on the copies themselves. A `group`
 * marker on the wrong side of the animated element compiles cleanly and
 * silently does nothing, which is the worst way for this to fail.
 *
 * **7. The link is optional, and it is the shop's own.**
 *
 * When there is a destination, the message is a link; when there is
 * not, it is plain text. The destination is a **path within the
 * storefront** — the same closed rule the hero banner's calls to action
 * follow — so an announcement can never point at another host.
 *
 * **8. It is a server component.**
 *
 * It needs no state, no effects and no event handlers. The animation
 * is declarative CSS, so there is nothing for a client bundle to do.
 *
 * **9. The ground is the shop's, and the admin paints it.**
 *
 * The bar used to be `bg-neutral-900` with white type, chosen here in
 * the component and unchangeable. Now the admin chooses both, and they
 * arrive as **two hex triplets**.
 *
 * They are applied **inline**, as `style` properties, because a colour
 * that came from the database cannot be a Tailwind class — a class is
 * a fixed name compiled at build time, and the shop may want a colour
 * this codebase has never seen.
 *
 * Which means the values are **untrusted input** on their way into a
 * `style` attribute, so they are normalised before they are used. A
 * value that is not a hex triplet falls back to the default rather
 * than being written out: the bar is always painted, and it is always
 * painted in something that is a colour.
 *
 * The default is the shop's darkest fill (`#1c1917`), which is the
 * **fill** step of the neutral ramp — the part that deliberately does
 * not re-point in the dark theme, for the same reason the brand's fill
 * does not. So a bar left at its default is the same warm near-black
 * in both themes, and the type on it is legible in both.
 *
 * **10. Everything that sits on the ground follows the ground.**
 *
 * The edge fades, the separator and the focus ring's offset are all
 * painted against the bar's background. When the ground changes, they
 * must change with it — a fade that fades to the design system's ink
 * would leave a visible band of the wrong colour on a rose bar.
 *
 * So the fades are painted with the ground colour itself, at
 * decreasing opacity, rather than with a Tailwind gradient built from
 * a fixed token. The separator is the type colour at a third of its
 * strength, and the focus ring's offset is the ground, so the ring
 * sits *in* the bar rather than around it.
 */

/**
 * The separator between the repeated phrases.
 *
 * A middot rather than a bullet, a pipe or an emoji: it is quiet, it
 * is typographically European, and it does not fight the message for
 * attention the way a coloured icon does.
 */
const SEPARATOR = "·";

export type MarqueeBannerProps = {
  /** The marquee's copy — the words that scroll. */
  readonly text: string;
  /**
   * Where the marquee links to, or `null` when it does not.
   *
   * A path within the storefront, or nothing.
   */
  readonly href?: string | null;
  /**
   * The bar's ground.
   *
   * A hex triplet. Anything that is not one falls back to the shop's
   * darkest fill.
   */
  readonly backgroundColor?: string;
  /**
   * The bar's type colour.
   *
   * A hex triplet. Anything that is not one falls back to white.
   */
  readonly textColor?: string;
};

/**
 * One copy of the message.
 *
 * `flex-1` is what makes the two copies **equal**: the track gives
 * them the same width, and the animation moves the track by exactly
 * half of itself — which is exactly one copy.
 */
function MarqueeCopy({
  text,
  href,
  hidden,
  textColor,
  backgroundColor,
}: {
  readonly text: string;
  readonly href: string | null;
  /** True for the duplicate copy, which assistive technology skips. */
  readonly hidden: boolean;
  readonly textColor: string;
  readonly backgroundColor: string;
}) {
  return (
    <div
      aria-hidden={hidden ? "true" : undefined}
      className="flex flex-1 items-center whitespace-nowrap"
    >
      {/*
        The message is a link when there is somewhere to go, and plain
        text when there is not. A link that goes nowhere is worse than
        no link — it looks clickable and does nothing.
      */}
      {href ? (
        <Link
          href={href}
          className="focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--marquee-offset)]"
          style={{ "--marquee-offset": backgroundColor } as CSSProperties}
        >
          {text}
        </Link>
      ) : (
        <span>{text}</span>
      )}

      {/*
        The separator, in the type colour at a third of its strength.

        It is painted from the **type** colour rather than from a fixed
        white, because the bar's type may no longer be white — a rose
        bar with white type and a white separator would put the
        separator at full strength while the message was softened by
        the ground.
      */}
      <span
        className="px-6"
        aria-hidden="true"
        style={{ color: textColor, opacity: 0.35 }}
      >
        {SEPARATOR}
      </span>
    </div>
  );
}

export function MarqueeBanner({
  text,
  href,
  backgroundColor,
  textColor,
}: MarqueeBannerProps) {
  const trimmed = text.trim();

  /*
   * The rule that governs this component: **it renders nothing when
   * there is nothing to say.**
   *
   * The switch is the admin's, but the text is theirs too, and a
   * marquee with no text is a strip of coloured nothing. So the
   * component checks the text itself rather than trusting the switch
   * to have been set in step with it.
   */
  if (trimmed === "") return null;

  /*
   * The colours.
   *
   * They come from the database, so they are **untrusted** on their way
   * into a `style` attribute. `normalizeHexColor` accepts a hex
   * triplet and refuses everything else, so nothing that is not a
   * colour can reach the page — and a refused value falls back to the
   * default rather than leaving the bar unpainted.
   */
  const background =
    normalizeHexColor(backgroundColor ?? "") ?? DEFAULT_MARQUEE_BG;

  const foreground =
    normalizeHexColor(textColor ?? "") ?? DEFAULT_MARQUEE_TEXT;

  return (
    <div
      className="group relative overflow-hidden border-b border-border/70 py-2"
      style={{ backgroundColor: background, color: foreground }}
    >
      {/*
        The track.

        `w-max` sizes the track to its own content — the two copies —
        and `min-w-[max(100%,max-content)]` guarantees it is never
        narrower than the window it scrolls through. The copies are
        `flex-1`, so they are always equal, and the `-50%` keyframe
        therefore always lands exactly on the seam.

        The vertical padding is on the **frame**, not on the copies, so
        the two copies stay equal in width — padding on one of them and
        not the other would make them differ, and the seam would not
        land.
      */}
      <div
        className={[
          "flex w-max min-w-[max(100%,max-content)] items-center",
          // The scroll. `motion-safe` stops it entirely for anyone who
          // has asked their system for less motion.
          "motion-safe:animate-[marquee-scroll_var(--marquee-duration)_linear_infinite]",
          // And it pauses when the announcement's own link is focused,
          // so a keyboard user is not chasing a moving target. The
          // `group` marker is on the frame above, because that is what
          // makes this variant match.
          "motion-safe:group-focus-within:[animation-play-state:paused]",
        ].join(" ")}
        style={
          {
            /*
             * The speed.
             *
             * The duration is a CSS variable rather than a fixed value
             * because the animation translates by a *percentage*, so the
             * same duration would make a long message move faster than
             * a short one — and a long message moving quickly is
             * unreadable, which defeats the point.
             *
             * So the duration scales with the length of the message, in
             * steps. A short announcement crosses quickly; a long one
             * takes its time. The steps are coarse on purpose: the
             * readability only depends on which band the message falls
             * into, and a continuous scale would put a number in the
             * markup that looks arbitrary.
             */
            "--marquee-duration": trimmed.length <= 60 ? "30s" : "48s",
          } as CSSProperties
        }
      >
        <MarqueeCopy
          text={trimmed}
          href={href ?? null}
          hidden={false}
          textColor={foreground}
          backgroundColor={background}
        />
        <MarqueeCopy
          text={trimmed}
          href={href ?? null}
          hidden={true}
          textColor={foreground}
          backgroundColor={background}
        />
      </div>

      {/*
        The edges.

        The fade at each end is what makes the strip read as *continuous
        beyond the frame* rather than as a line of text with two hard
        edges. It also hides the seam between the two copies at the
        moment the loop restarts, because the copy that is entering is
        under the fade rather than visibly snapping into place.

        The fade is painted with the bar's **own** ground colour, at
        decreasing opacity. A gradient built from a fixed token would
        leave a band of the wrong colour on a bar the admin has
        repainted — the most visible possible way for the colour
        feature to look broken.
      */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-10 sm:w-16"
        style={{
          backgroundImage: `linear-gradient(to right, ${background}, transparent)`,
        }}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-10 sm:w-16"
        style={{
          backgroundImage: `linear-gradient(to left, ${background}, transparent)`,
        }}
      />
    </div>
  );
}
