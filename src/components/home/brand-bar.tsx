import Image from "next/image";
import Link from "next/link";

import { imageUrl } from "@/lib/format/image";
import type { BrandSummary } from "@/lib/format/types";

/**
 * The featured brands grid.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. It is a grid of *nameplates*, not circles.**
 *
 * This used to be a bar of 56–64px circular marks, each with the brand
 * name underneath in 11px grey. At that size the mark is unreadable —
 * you cannot tell CeraVe from Vichy from La Roche-Posay, because the
 * difference between them *is* the wordmark. A trust signal nobody can
 * read is not a trust signal.
 *
 * So the brands are now **rectangular nameplates**: a wide, horizontal
 * card holding the logo at a size where the wordmark is legible, with
 * the brand's name set beside it. A circle forces a logo to be small
 * and centred, because a circle is a bad frame for a rectangle; a
 * wide card lets the mark sit at its natural proportion and leaves
 * room for the name to be **set as type** rather than as a caption.
 *
 * The card is **wide and short** — a nameplate, not a poster. Its
 * proportion is what makes it read as a *label on a shelf* rather
 * than as a product tile: the logo sits in a fixed square well on the
 * left, and the name runs on the right in the page's own serif.
 *
 * **2. The logo is `object-contain`, not `object-cover`.**
 *
 * A logo is a rectangle. Cropping one to fill its frame is how a logo
 * gets mangled — the wordmark gets its ends cut off, and a logo that
 * reads as broken is worse than no logo at all.
 *
 * The logos the shop uploads are wide (1024×538) and carry the mark on
 * a pale, near-white card of their own, so they are *contained* inside
 * the well rather than cropped to it.
 *
 * **3. The padding belongs to the well, not to the image.**
 *
 * `object-contain` fits the *whole* image inside the box, which is
 * correct — but a logo file usually carries its own transparent
 * margin, so a full-bleed `object-contain` renders the visible mark
 * at perhaps 70% of the box.
 *
 * So the **well** is padded, and the image is scaled to fit what is
 * left. The padding is uniform on all four sides, which keeps a wide
 * wordmark optically centred rather than hugging an edge.
 *
 * The image itself carries only a hair of padding. Padding the well
 * *and* the image stacks two insets and quietly shrinks the mark by
 * roughly a quarter — which is the opposite of what a section whose
 * whole job is legibility wants.
 *
 * **4. The border is a hairline, and it is the only chrome.**
 *
 * The card is separated from the page by a **one-pixel ring** in the
 * faintest ink the theme allows, and by nothing else — no shadow, no
 * raised surface, no fill darker than the page.
 *
 * A boutique nameplate is *printed*, not *mounted*. The moment the
 * brand grid gets the same shadowed white panel the product grid has,
 * the section stops being "the houses we stock" and becomes "a fourth
 * grid of tiles", and the page loses its structure. The rule says
 * "this is a distinct object"; it does not shout.
 *
 * The card gains its **shadow** on hover, and only then — which is
 * what makes the hover read as *picking it up* rather than as the
 * card suddenly being mis-styled.
 *
 * **5. The name is set as type, not as a caption.**
 *
 * It is in the page's **serif**, at the same weight and colour as the
 * category grid's titles, and set small, wide and uppercase — the
 * convention a European pharmacy label uses. So the card reads as an
 * editorial *nameplate* — a house's name and its mark — rather than as
 * a picture with a caption bolted on.
 *
 * **6. The card carries the brand's *size*, not just its name.**
 *
 * Beneath the name is the **real count of sellable products** — the
 * same "42 products" signal the category grid gives. A nameplate with
 * a logo and no count tells a shopper the shop carries the brand; it
 * does not tell them whether there is one product of it or twenty. The
 * count is what makes the card informative rather than decorative.
 *
 * When the admin has written a **description**, that replaces the
 * count — an admin who wrote a line meant it to be read — and it is
 * clamped to one line so a long description cannot make one card
 * taller than its neighbours and break the row.
 *
 * **7. Each card links to a real search.**
 *
 * The link is `/products?search=<brand>` — a query the catalogue API
 * already handles. So the card leads to a genuine, filtered,
 * paginated result set rather than a client-side filter that would
 * only ever see the products on the current page.
 *
 * **8. The rail scrolls on a phone, and it is keyboard-scrollable.**
 *
 * The scrollbar is hidden with `no-scrollbar`, but the element is still
 * focusable and still scrolls with the arrow keys. Hiding a scrollbar
 * must never remove the ability to scroll — that is a WCAG 2.1.1
 * failure, and it is the single most common mistake in mobile
 * carousels.
 */

/**
 * The featured brands grid.
 */
export function BrandBar({
  brands,
}: {
  /**
   * The brands to show, in display order.
   */
  readonly brands: readonly BrandSummary[];
}) {
  if (brands.length === 0) {
    return null;
  }

  return (
    <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 no-scrollbar sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-3 xl:grid-cols-3 xl:gap-5">
      {brands.map((brand) => (
        <Link
          key={brand.id}
          href={`/products?search=${encodeURIComponent(brand.name)}`}
          className={[
            "group flex w-[260px] shrink-0 snap-start items-center gap-4",
            "rounded-[var(--radius-card)] border border-border/80 bg-surface p-3",
            "transition-all duration-500 ease-[var(--ease-out-soft)]",
            "hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[var(--shadow-card)]",
            "sm:w-full sm:shrink",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          ].join(" ")}
        >
          {/*
            The logo well.

            A fixed **square** well holding the mark, on the left of
            the name.

            The well is square because a logo file is wide and a
            square well is the smallest frame that contains it
            honestly — a wide well would give the mark a lot of empty
            air on either side, and a short one would crop it.

            The well carries **no border of its own**. The card's
            hairline is the only boundary on the plate; a second ring
            inside it would draw a box around the mark and make the
            card look like two objects rather than one.
          */}
          <span
            className={[
              "relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden",
              "rounded-[calc(var(--radius-card)*0.66)] bg-surface-sunken p-2",
              "transition-colors duration-500 ease-[var(--ease-out-soft)]",
              "group-hover:bg-brand-50",
            ].join(" ")}
          >
            {brand.logo ? (
              <Image
                src={imageUrl(brand.logo)}
                alt={`${brand.name} logo`}
                fill
                sizes="64px"
                className="object-contain p-1 transition-transform duration-500 ease-[var(--ease-out-soft)] group-hover:scale-105"
              />
            ) : (
              /*
                The monogram fallback.

                The monogram is the **fallback**, not a removed feature:
                a brand with no logo still renders as a nameplate rather
                than as an empty square. It is set in the serif face at
                the size a monogram wants to be read at.
              */
              <span className="font-serif text-2xl font-bold leading-none text-brand-600 transition-colors duration-300 group-hover:text-brand-700">
                {brand.monogram}
              </span>
            )}
          </span>

          {/*
            The name, and the count.

            The name is **set as type** — the page's serif, at the
            weight the category grid's titles use — because the card is
            a nameplate and the name is the point of it. It is not a
            caption under a picture; it is the thing being displayed,
            with the logo as its mark.

            It is **uppercase and tracked**, because that is the
            convention a European pharmacy label uses: a house's name
            set small, wide and formal. The card here is only the
            house, so the name carries the whole weight.

            The **count** sits beneath it, and it is the *real* count of
            sellable products — the same "42 products" signal the
            category grid gives. A nameplate with a logo and no count
            tells a shopper the shop carries the brand; it does not tell
            them whether there is one product of it or twenty. The count
            is what makes the card informative rather than decorative.

            The description, when the admin has written one, replaces
            the count — an admin who wrote a line meant it to be read.
            It is clamped to one line so one long description cannot
            make one card taller than its neighbours and break the row.
          */}
          <span className="flex min-w-0 flex-1 flex-col justify-center">
            <span className="truncate font-serif text-sm font-bold uppercase tracking-[0.14em] text-foreground transition-colors duration-300 group-hover:text-brand-700">
              {brand.name}
            </span>

            <span className="mt-1.5 block truncate text-[11px] leading-relaxed text-foreground-muted">
              {brand.description ??
                `${brand.productCount} ${brand.productCount === 1 ? "product" : "products"}`}
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}
