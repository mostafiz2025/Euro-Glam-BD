"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import { ButtonLink } from "@/components/ui/button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ShieldIcon,
  SparkleIcon,
  TruckIcon,
} from "@/components/ui/icons";
import { imageUrl } from "@/lib/format/image";

import { HERO_SLIDES, type HeroSlide } from "./hero-slides";

/**
 * The hero slider.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. It is a real slider, and it is honest about being one.**
 *
 * The slides are the shop's **brand showcases** — CeraVe, La
 * Roche-Posay, The Ordinary — because on a multi-brand storefront the
 * brand *is* the organising idea. A shopper who trusts La Roche-Posay
 * for their eczema does not want to be shown a generic serum; they
 * want to be shown more La Roche-Posay.
 *
 * The control is a row of **dots**, not a set of arrows alone, because
 * a dot tells the shopper how many slides there are and where they are.
 * Arrows with no dots are a carousel that looks like it has one panel.
 *
 * **2. It never auto-advances without the shopper's consent.**
 *
 * There is a pause button, and the slider stops on hover, on focus
 * within, and whenever the tab is hidden. An auto-advancing carousel
 * that moves while a shopper is trying to read it is not a carousel —
 * it is a race. WCAG 2.2.2 requires a mechanism to pause automatic
 * movement, and the pause button is that mechanism.
 *
 * **3. The slides are readable without JavaScript.**
 *
 * Every slide's content is rendered in the DOM; the inactive ones are
 * hidden with `aria-hidden` and pointer suppression rather than being
 * unmounted. A shopper with JavaScript disabled sees the first slide,
 * and a screen reader announces the current slide's text. The slider is
 * an enhancement, never a gate.
 *
 * **4. The autoplay timer is a ref, not a state value.**
 *
 * A timer that lived in state would re-render the whole slider once a
 * second, and every re-render would restart the transition. The deadline
 * is stored in a ref and checked on an interval, so the slide changes
 * once, on a boundary, rather than continuously.
 *
 * **5. The layout is a single wide panel — not a card in a grid.**
 *
 * A hero that is one of several equal panels reads as a section, not as
 * the top of the page. The slider is full-bleed within the page's max
 * width, and it carries the promotional banner's proportions.
 *
 * **6. The transition is a cross-fade with a settle, not a dissolve.**
 *
 * The slides do not simply fade between one another. The outgoing slide
 * fades *and drifts up*, and the incoming slide fades *and drifts down
 * into place* — a small vertical offset on each side of the fade.
 *
 * The reason is perceptual. A pure opacity cross-fade is the hardest
 * transition to read: for the middle of the transition, both slides
 * are half-visible and overlaid, so the copy is briefly doubled and
 * illegible. The drift gives the two slides *different positions* at
 * every moment of the transition, so the eye can always tell which
 * one it is looking at, and it separates the type rather than smearing
 * it.
 *
 * The drift is deliberately small — 1.5rem — and it is paired with a
 * slow, soft easing. A large offset would read as a scroll; a small
 * one reads as a settle.
 *
 * **7. The type is set on a deliberate scale.**
 *
 * The headline is the largest type on the page by a wide margin, and
 * the tracking is tightened as it grows. This is the one place where
 * the serif is allowed to be loud: it is the shop's opening line, and
 * a hero with a modest headline reads as a banner rather than as a
 * hero.
 *
 * The supporting copy is held to a narrow measure (`max-w-xl`) and set
 * at a generous leading, because a paragraph of text in a hero is read
 * as a caption — not scanned. The restraint in the *body* is what lets
 * the headline be as large as it is.
 *
 * **8. There is nothing on the panel but the words.**
 *
 * The panel used to be split in two: the copy on the left, and on the
 * right a raised white plate holding the shop's product photography —
 * one bottle for a brand slide, a row of three thumbnails for the
 * advisor slide.
 *
 * It was removed, and the reason is worth stating because it is the
 * whole point of the change: **a hero is a poster, and a poster has
 * one subject.** The second column was not decoration — it was a
 * *catalogue*. Three product tiles with their names and prices, in the
 * most valuable eight hundred pixels on the page, competing with the
 * sentence the shop is trying to say. A shopper who glanced at the
 * panel could not tell whether they were reading an advertisement or
 * looking at a shelf.
 *
 * So the panel is now **copy and a ground**: the eyebrow, the headline,
 * the supporting line, the two calls to action, the trust points, a
 * gradient wash, and an optional photograph behind it all. The
 * photograph is the ground — it is what makes the panel a poster
 * rather than a coloured rectangle — and the words are the only
 * subject.
 *
 * **9. The panel is a poster in **both** themes, so it has its own ink.**
 *
 * The gradients are pale washes and the artwork sits behind a white
 * scrim, so the ground under the copy is light — in the dark theme as
 * much as in the light one. That makes the ordinary foreground tokens
 * wrong here: `text-foreground` becomes near-white in the dark theme,
 * and near-white type on a near-white ground is unreadable.
 *
 * So the hero carries `--hero-ink`, `--hero-ink-muted` and
 * `--hero-accent`, and — like `--neutral-800` and `--neutral-900` —
 * they deliberately do **not** re-point in the dark theme. A poster is
 * printed once; it does not invert.
 *
 * **10. The scrim is a veil, not a gradient.**
 *
 * The artwork is arbitrary — an admin's photograph, a campaign's key
 * visual — and the copy has to stay legible over *any* of them. The
 * scrim is therefore two layers: a **flat white veil** across the whole
 * panel, which knocks the artwork back to a texture, and a
 * **directional wash** on the left, where the copy sits, which takes
 * the ground the rest of the way to white.
 *
 * The result is that the photograph reads as atmosphere rather than as
 * a picture competing with the headline — which is the only job a
 * background image can do when the words on top of it are the message.
 */

/**
 * How long a slide is shown, in milliseconds.
 */
const AUTOPLAY_MS = 7000;

/**
 * The hero slider.
 *
 * The slides are passed in already resolved — the server has attached
 * each one's artwork. When the slider is rendered without them (a test,
 * a story), it falls back to the static definitions.
 */
export function HeroSlider({
  slides,
}: {
  readonly slides?: readonly HeroSlide[];
}) {
  const resolved = slides && slides.length > 0 ? slides : HERO_SLIDES;

  const [index, setIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  /**
   * The autoplay deadline.
   *
   * A ref, not state: a value in state would re-render the whole slider
   * on every tick, and each re-render would restart the slide's
   * transition. The deadline is read on an interval and the slide
   * changes once, on a boundary.
   */
  const deadlineRef = useRef<number>(0);

  const count = resolved.length;

  const goTo = useCallback(
    (next: number) => {
      if (count === 0) return;

      const wrapped = ((next % count) + count) % count;

      setIndex(wrapped);
      deadlineRef.current = Date.now() + AUTOPLAY_MS;
    },
    [count],
  );

  const previous = useCallback(() => goTo(index - 1), [goTo, index]);
  const next = useCallback(() => goTo(index + 1), [goTo, index]);

  /**
   * The autoplay tick.
   *
   * `visibilitychange` is watched as well as the interval, because a
   * browser tab in the background throttles timers to once a minute —
   * which would mean the slide changes while the shopper is not
   * looking, and the deadline would be long past by the time they
   * returned.
   */
  useEffect(() => {
    if (isPaused || count <= 1) return;

    deadlineRef.current = Date.now() + AUTOPLAY_MS;

    const interval = window.setInterval(() => {
      if (Date.now() >= deadlineRef.current) {
        setIndex((current) => (current + 1) % count);
        deadlineRef.current = Date.now() + AUTOPLAY_MS;
      }
    }, 1000);

    function handleVisibility() {
      if (document.hidden) return;

      // The tab was hidden, so the deadline passed without the shopper
      // seeing it. Reset it rather than jumping the slide.
      deadlineRef.current = Date.now() + AUTOPLAY_MS;
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isPaused, count]);

  if (count === 0) {
    return null;
  }

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Featured brands and campaigns"
      className="relative overflow-hidden bg-surface"
      onMouseEnter={() => {
        setIsPaused(true);
      }}
      onMouseLeave={() => {
        setIsPaused(false);
      }}
      onFocusCapture={() => {
        setIsPaused(true);
      }}
      onBlurCapture={() => {
        setIsPaused(false);
      }}
    >
      {/*
        The ambient wash behind the hero.

        It is a very soft, very large rose gradient that sits *behind*
        the panel and bleeds past its edges. It is what stops the hero
        from reading as a rectangle pasted onto a flat page: the panel
        appears to be sitting in a pool of light rather than on top of
        a colour field.

        `blur-3xl` on a large shape is far cheaper than it looks — it is
        one composited layer, not a filter over the whole page.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-[32rem] bg-[radial-gradient(60%_80%_at_50%_0%,var(--brand-50)_0%,transparent_70%)]"
      />

      <div className="relative mx-auto max-w-7xl px-4 pt-8 sm:px-6 sm:pt-12 lg:px-8">
        {/*
          The slides.

          Every slide is in the DOM; only the current one is visible. The
          inactive ones are hidden from assistive technology and from the
          pointer, so a screen reader reads one slide and a click lands
          on one slide.
        */}
        <div className="relative overflow-hidden rounded-[1.75rem] shadow-[var(--shadow-hero)] ring-1 ring-inset ring-black/[0.04]">
          {resolved.map((slide, slideIndex) => {
            const isCurrent = slideIndex === index;

            return (
              <div
                key={slide.id}
                id={`hero-slide-${slide.id}`}
                role="group"
                aria-roledescription="slide"
                aria-label={`${slideIndex + 1} of ${count}: ${slide.eyebrow}`}
                aria-hidden={!isCurrent}
                className={[
                  "absolute inset-0",
                  "transition-[opacity,transform] duration-[900ms] ease-[var(--ease-carousel)]",
                  isCurrent
                    ? "relative z-10 translate-y-0 opacity-100"
                    : "pointer-events-none z-0 -translate-y-6 opacity-0",
                ].join(" ")}
              >
                <div
                  className={[
                    "relative flex min-h-[28rem] flex-col justify-center overflow-hidden px-6 py-16 sm:min-h-[30rem] sm:px-12 lg:min-h-[33rem] lg:px-20 lg:py-20",
                    slide.gradient,
                  ].join(" ")}
                >
                  {/*
                    The banner's background artwork.

                    It is the **background**, never the subject: the copy
                    is laid over it, behind the scrim, and the headline
                    stays readable whatever the picture is. A slide with
                    no artwork falls back to the gradient wash alone,
                    which is a complete design in its own right — so the
                    artwork is an enhancement, not a requirement.
                  */}
                  {slide.image ? (
                    <Image
                      src={imageUrl(slide.image)}
                      alt=""
                      fill
                      priority={slideIndex === 0}
                      sizes="(min-width: 1280px) 1280px, 100vw"
                      className="object-cover"
                    />
                  ) : null}

                  {/*
                    The scrim.

                    Two layers, and the order matters.

                    The **veil** is a flat white wash across the whole
                    panel. It is what turns the artwork into a texture:
                    the photograph is still there, still gives the panel
                    its depth and its sense of light, but it can no
                    longer compete with the words on top of it.

                    The **directional wash** then takes the ground the
                    rest of the way to white on the left, where the copy
                    sits, and fades out towards the right.

                    Both are **white**, not `surface`. The hero's
                    gradients are all light washes — that is the whole
                    visual language of the panel — so a `surface` scrim
                    would turn dark in the dark theme and put dark type
                    on a light gradient.

                    They are `pointer-events-none`, so they never
                    intercept a click on the calls to action.
                  */}
                  {slide.image ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 bg-white/60"
                      />

                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white via-white/85 to-white/25"
                      />
                    </>
                  ) : null}

                  {/*
                    The decorative glows. They are `aria-hidden` because
                    they carry no information.

                    The second one — the cool white bloom in the lower
                    left — is what stops the panel reading as flat. It
                    puts a highlight in the corner the copy is not
                    sitting in, which is what gives the gradient a
                    sense of depth rather than being a printed wash.
                  */}
                  <div
                    aria-hidden="true"
                    className={[
                      "pointer-events-none absolute -right-16 -top-20 h-80 w-80 rounded-full blur-3xl",
                      slide.glow,
                    ].join(" ")}
                  />
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -bottom-28 -left-20 h-80 w-80 rounded-full bg-white/70 blur-3xl"
                  />

                  {/*
                    The hairline at the top of the panel.

                    It is the "light catching the edge of a shelf" line.
                    Almost invisible on a white background, and it is
                    what makes the panel read as a physical object with a
                    top surface rather than as a colour block.
                  */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent"
                  />

                  {/*
                    The copy.

                    One column, left-aligned, with a measure that keeps
                    the headline on two or three lines rather than
                    letting it run the width of the panel. There is no
                    second column: the panel's whole right-hand side is
                    the ground the copy sits on, and a wide, empty half
                    is what makes a poster look like a poster.

                    The measure is `max-w-2xl` rather than `max-w-xl`,
                    because the supporting line is a sentence rather
                    than a caption and it is allowed a little more room
                    than the headline.
                  */}
                  <div className="relative max-w-2xl">
                    <span className="inline-flex items-center gap-2 rounded-full bg-white/80 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-hero-accent shadow-sm ring-1 ring-inset ring-black/[0.06] backdrop-blur">
                      <SparkleIcon width={12} height={12} />
                      {slide.eyebrow}
                    </span>

                    {/*
                      The headline.

                      The tracking tightens as the size grows
                      (`tracking-tight` at the small sizes,
                      `tracking-[-0.03em]` at the largest), because a
                      large serif set at normal tracking reads as
                      *loose* — the letters float apart and the word
                      stops reading as a single shape. Tightening it
                      restores the solidity that makes a big display
                      line feel expensive rather than airy.

                      The measure tightens with it (`max-w-[15ch]`), so
                      the headline breaks into two or three lines
                      rather than running the full width of the column
                      — a display line set edge to edge reads as a
                      paragraph set large, not as a headline.
                    */}
                    <h2 className="mt-7 max-w-[15ch] font-serif text-[2.125rem] font-bold leading-[1.05] tracking-tight text-hero-ink sm:text-5xl sm:tracking-[-0.02em] lg:text-[3.5rem] lg:leading-[1.02] lg:tracking-[-0.03em]">
                      {slide.title}
                    </h2>

                    {/*
                      The supporting copy.

                      A narrow measure and a generous leading. This is
                      read, not scanned, so the line length is short
                      and the leading is open — the opposite of the
                      dense setting the product grid uses.
                    */}
                    <p className="mt-6 max-w-xl text-[15px] leading-[1.75] text-hero-ink-muted sm:text-base sm:leading-[1.7]">
                      {slide.body}
                    </p>

                    <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                      <ButtonLink
                        href={slide.cta.href}
                        size="lg"
                        variant="hero"
                        className="w-full sm:w-auto"
                      >
                        {slide.cta.label}
                      </ButtonLink>

                      <ButtonLink
                        href={slide.secondaryCta.href}
                        size="lg"
                        variant="heroOutline"
                        className="w-full sm:w-auto"
                      >
                        {slide.secondaryCta.label}
                      </ButtonLink>
                    </div>

                    {/* ── The trust row ───────────────────────────────────── */}
                    <ul className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-hero-ink/10 pt-6">
                      {slide.trust.map((item) => (
                        <li
                          key={item}
                          className="flex items-center gap-1.5 text-xs font-medium text-hero-ink-muted"
                        >
                          <ShieldIcon
                            width={14}
                            height={14}
                            className="text-hero-accent"
                          />
                          {item}
                        </li>
                      ))}

                      <li className="flex items-center gap-1.5 text-xs font-medium text-hero-ink-muted">
                        <TruckIcon
                          width={14}
                          height={14}
                          className="text-hero-accent"
                        />
                        Cash on delivery
                      </li>
                    </ul>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── The controls ─────────────────────────────────────────────── */}
        {/*
          The row that holds the dots and the arrows.

          Its padding is **tight** — 16px above and below, not 24. The
          arrows are a control for the carousel, not a section of their
          own, so they sit close to the panel they control and close to
          the content that follows. Generous padding here would open a
          band of empty space between the hero and the first section
          that belongs to neither.
        */}
        <div className="flex items-center justify-between gap-4 py-4">
          {/*
            The dots.

            A dot tells the shopper how many slides there are and which
            one they are on — information the arrows alone cannot give.

            The active dot is a **pill** rather than a circle, and it
            is wider than it is tall so it reads as a segment of a
            progress track. That is the convention every premium
            storefront uses, and it is genuinely more legible than a
            row of identical circles: the shape change carries the
            "you are here" signal even at a glance, without the
            shopper needing to count the dots.
          */}
          <div className="flex items-center gap-2">
            {resolved.map((slide, slideIndex) => {
              const isCurrent = slideIndex === index;

              return (
                <button
                  key={slide.id}
                  type="button"
                  onClick={() => {
                    goTo(slideIndex);
                  }}
                  aria-label={`Go to slide ${slideIndex + 1}: ${slide.eyebrow}`}
                  aria-current={isCurrent ? "true" : undefined}
                  className={[
                    "h-1.5 rounded-full transition-all duration-500 ease-[var(--ease-out-soft)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                    isCurrent
                      ? "w-9 bg-brand-600"
                      : "w-1.5 bg-border hover:w-3 hover:bg-brand-300",
                  ].join(" ")}
                />
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            {/*
              The pause button.

              WCAG 2.2.2 requires a mechanism to pause automatic
              movement, and it has to be available to the shopper rather
              than hidden behind a hover state.
            */}
            <button
              type="button"
              onClick={() => {
                setIsPaused((value) => !value);
              }}
              aria-label={isPaused ? "Resume the carousel" : "Pause the carousel"}
              className="inline-flex h-9 items-center rounded-full border border-border/80 px-4 text-[11px] font-medium tracking-wide text-foreground-muted transition-all duration-300 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {isPaused ? "Play" : "Pause"}
            </button>

            {/*
              The arrows.

              They are **filled** on hover rather than merely tinted.
              A tint is the lightest possible signal; a fill is a
              definite one. The fill is the brand rose, which ties the
              arrows to the primary call-to-action in the slide — the
              controls and the CTA are the same kind of control, and
              they should look like it.
            */}
            <button
              type="button"
              onClick={previous}
              aria-label="Previous slide"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/80 text-foreground-muted transition-all duration-300 hover:border-brand-600 hover:bg-brand-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ChevronLeftIcon width={16} height={16} />
            </button>

            <button
              type="button"
              onClick={next}
              aria-label="Next slide"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/80 text-foreground-muted transition-all duration-300 hover:border-brand-600 hover:bg-brand-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <ChevronRightIcon width={16} height={16} />
            </button>
          </div>
        </div>

        {/*
          The live region.

          It announces the current slide's brand when the slide changes,
          so a screen-reader user knows the carousel moved without having
          to go looking. It is `aria-live="polite"` so it does not
          interrupt.
        */}
        <p aria-live="polite" className="sr-only">
          Slide {index + 1} of {count}: {resolved[index]?.eyebrow}
        </p>
      </div>
    </section>
  );
}
