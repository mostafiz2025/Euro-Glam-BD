import type { ReactNode } from "react";

/**
 * The section heading.
 *
 * Every section on the home page and the listing page uses this, so the
 * vertical rhythm is identical throughout. The optional trailing slot
 * is where a "View all" link goes — the two always sit on the same
 * baseline, which is why the link is a slot rather than something the
 * heading builds itself.
 *
 * ── The typographic rule ─────────────────────────────────────────────────
 *
 * The title is set in the **serif** face, at a size that reads as a
 * *heading* rather than as a label. A sans-serif bold title at 18px is
 * the same size as the product names beneath it, and a shopper scanning
 * the page cannot tell where one section ends and the next begins. The
 * serif, plus the tracking, plus the extra weight, makes the section
 * titles read as a different level of the hierarchy from the content
 * they introduce.
 *
 * The eyebrow — the small uppercase label above the title — is what
 * gives the page its editorial spine. It tells the shopper what *kind*
 * of section they are in before they read what is in it.
 */
export type SectionHeadingProps = {
  readonly title: string;
  readonly subtitle?: string;
  /** A small uppercase label above the title. */
  readonly eyebrow?: string;
  /** A link or button on the trailing edge. */
  readonly action?: ReactNode;
  readonly className?: string;
};

export function SectionHeading({
  title,
  subtitle,
  eyebrow,
  action,
  className,
}: SectionHeadingProps) {
  return (
    <div
      className={[
        "flex items-end justify-between gap-4",
        /*
          The hairline.

          A section boundary on a boutique storefront is drawn, not
          implied. A shopper scrolling a long page needs a *moment* at
          which one zone ends and the next begins — otherwise the page
          reads as one long undifferentiated list.

          The rule sits at the very top of the heading block, above the
          eyebrow, in the faintest ink the theme allows. It is invisible
          if you are not looking for it and structural if you are.

          The padding below the rule is **tight** — 16px, and 20px on a
          tablet. This is the space between the rule and the first
          word of the section, and it is deliberately small: the rule
          already says "a new section starts here", so a large gap
          after it would say it a second time, more slowly. Tight here
          and generous *above* the rule is what makes the page read as
          continuous rather than as a stack of air-separated blocks.
        */
        "relative border-t border-foreground/[0.07] pt-4 sm:pt-5",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-brand-600">
            {eyebrow}
          </p>
        ) : null}

        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {title}
        </h2>

        {subtitle ? (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-foreground-muted">
            {subtitle}
          </p>
        ) : null}
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
