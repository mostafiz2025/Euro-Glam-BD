import Image from "next/image";
import Link from "next/link";

import { CategoryIcon } from "@/components/ui/category-icon";
import { ChevronRightIcon } from "@/components/ui/icons";
import { imageUrl } from "@/lib/format/image";
import type { CategorySummary } from "@/lib/format/types";

/**
 * The "Top Categories" grid.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The grid is driven by the database, not by a static list.**
 *
 * The categories come from the `Category` table, so a category the admin
 * adds appears here without a code change. The *icon* comes from a
 * static table, and a category with no icon entry still renders — with
 * the fallback icon. The icon table decorates the catalogue; it never
 * gates it.
 *
 * **2. An uploaded image replaces the icon; it never replaces the tile.**
 *
 * The admin can upload a card image for a category, and when there is
 * one the tile shows it. When there is not, the SVG icon keyed by slug
 * stands in — because the icon table is the **fallback**, and a
 * category the admin has not yet decorated still has to render as
 * something rather than an empty circle.
 *
 * So the icon is never removed; it is only outranked.
 *
 * **3. The count is shown, and it is the real count.**
 *
 * "42 products" tells a customer whether the category is worth
 * entering. A wrong count is worse than no count, so it comes from the
 * database's own `_count`.
 *
 * **4. A mobile scroller, a desktop grid.**
 *
 * On a phone, a four-column grid of tiles is 80px wide — too small to
 * tap. So the phone layout is a horizontal scroller of larger tiles,
 * and the desktop layout is a grid. Two layouts, one data source.
 *
 * **5. The card is image-on-top, title-below.**
 *
 * This is the layout the whole page uses for products and concerns, and
 * it is the layout a shopper reads fastest: a picture of the thing, then
 * the name of the thing. The title sits **below** the image on the
 * card's own surface — never on top of the photograph.
 *
 * That single decision removes an entire class of problem. A label
 * *over* an image has to fight the photograph for legibility, and every
 * defence against that — a scrim, a blur, a local overlay, a drop
 * shadow — is a layer that makes the picture worse. Text on an image is
 * only ever legible by luck, and the luck runs out the moment an admin
 * uploads a bright product shot.
 *
 * The photograph is therefore left alone. It is shown at full strength,
 * with no tint and no scrim over it, because there is nothing on top of
 * it to protect.
 *
 * The one exception is the **count badge**, which sits on the image —
 * and it carries its own translucent surface, so it is legible over any
 * photograph without a scrim across the whole frame.
 *
 * **6. The image is a landscape 4:3 crop.**
 *
 * A category photo is a *scene* — a shelf, a texture, a flat-lay — and
 * a scene wants to fill its frame. `object-cover` is therefore right,
 * and deliberately the opposite of the brand logo's `object-contain`: a
 * logo wants to be contained, because cropping a wordmark mangles it; a
 * photograph wants to be cropped, because cropping a scene just chooses
 * which part of it you see.
 *
 * Landscape also cuts the frame's height by 44% against a portrait 3:4
 * at the same column width — the difference between a compact card and
 * one that dominates the viewport.
 *
 * **7. The tile is soft and minimalist — no card chrome.**
 *
 * This is the rule that separates a boutique storefront from a
 * marketplace.
 *
 * A marketplace tile is a **panel**: a white rectangle with a border
 * and a drop shadow, floating on the page. Every tile is the same
 * shape, the same weight and the same brightness, so the eye reads a
 * wall of interchangeable boxes — and the *photograph* inside each one
 * becomes the only thing distinguishing them.
 *
 * A boutique storefront tile is **the photograph**. The frame is
 * defined by the picture's own edge and a soft shadow beneath it; the
 * title and the count live on the page's canvas, in the page's own
 * type. Nothing is boxed. The result is quieter, and it makes the
 * photography — which is the product — the loudest thing in the tile.
 *
 * So the count badge is small and translucent rather than a solid
 * pill, the title is set in the page's muted ink rather than a heavy
 * black, and the arrow only appears on hover.
 *
 * **8. The hover moves the picture, not the card.**
 *
 * The image scales on hover; the title stays still. A card that scales
 * as a whole makes its own text blurry, which is the classic mistake.
 * The card does lift — a translate, not a scale — so the whole thing
 * feels alive without anything becoming illegible.
 */

/**
 * The props for the category grid.
 */
export type CategoryGridProps = {
  readonly categories: readonly CategorySummary[];
};

export function CategoryGrid({ categories }: CategoryGridProps) {
  if (categories.length === 0) {
    return null;
  }

  return (
    <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 no-scrollbar sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-4">
      {categories.map((category) => (
        <Link
          key={category.id}
          href={`/products?category=${category.slug}`}
          className={[
            "group relative flex w-[168px] shrink-0 snap-start flex-col",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          ].join(" ")}
        >
          {/*
            The image frame.

            A **landscape 4:3** crop, because a category photo is a
            *scene* — a shelf, a texture, a flat-lay — and a scene wants
            to fill its frame. `object-cover` is right for that; a logo
            would want `object-contain`, but this is a photograph.

            The frame carries the radius and the shadow, and the image
            inside it scales on hover. The zoom is on the **image**, not
            the card, so the title stays still while the picture moves —
            a card that scales as a whole makes the text blurry.
          */}
          <span className="relative block aspect-[4/3] w-full overflow-hidden rounded-[var(--radius-card)] bg-stone-50 shadow-[var(--shadow-card)] transition-shadow duration-500 ease-[var(--ease-out-soft)] group-hover:shadow-[var(--shadow-lift)]">
            {category.image ? (
              <Image
                src={imageUrl(category.image)}
                alt=""
                fill
                sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 168px"
                className="object-cover transition-transform duration-700 ease-[var(--ease-out-soft)] group-hover:scale-105"
              />
            ) : (
              /*
                The icon fallback.

                The SVG icon is the **fallback**, not a removed feature —
                a category the admin has not yet decorated still renders
                as something rather than an empty frame. It sits on the
                same stone canvas the product cards use, so the two
                read as one family.
              */
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-stone-50 ring-1 ring-inset ring-stone-200/70"
              >
                <CategoryIcon
                  slug={category.slug}
                  width={34}
                  height={34}
                  className="text-stone-400 transition-colors duration-500 group-hover:text-brand-500"
                />
              </span>
            )}

            {/*
              The count, on the image.

              "42 products" tells a shopper whether the category is worth
              entering, and on the image it reads as a badge rather than
              as body copy. A wrong count is worse than no count, so it
              comes from the database's own `_count`.

              It carries its own translucent surface, so it is legible
              over any photograph without a scrim across the whole
              frame.
            */}
            <span className="pointer-events-none absolute bottom-2.5 left-3 inline-flex items-center rounded-full bg-surface/85 px-2 py-0.5 text-[10px] font-semibold text-foreground-muted shadow-sm backdrop-blur">
              {category.productCount}{" "}
              {category.productCount === 1 ? "product" : "products"}
            </span>
          </span>

          {/* ── The title, below the image ─────────────────────────────── */}
          <span className="flex items-center justify-between gap-2 pt-3.5">
            <span className="min-w-0">
              <span className="block truncate font-serif text-sm font-bold text-foreground transition-colors duration-300 group-hover:text-brand-700">
                {category.name}
              </span>
              <span className="mt-0.5 block text-[11px] text-foreground-muted">
                Shop the range
              </span>
            </span>

            {/*
              The arrow.

              It slides in on hover, which is the standard "this is a
              link" cue — and it is `aria-hidden`, because the link's
              accessible name is the category name and an arrow adds
              nothing to it.
            */}
            <span
              aria-hidden="true"
              className="shrink-0 text-brand-600 opacity-0 transition-all duration-300 ease-[var(--ease-out-soft)] group-hover:translate-x-0.5 group-hover:opacity-100"
            >
              <ChevronRightIcon width={16} height={16} />
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}
