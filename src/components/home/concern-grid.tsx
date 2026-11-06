import Image from "next/image";
import Link from "next/link";

import { imageUrl } from "@/lib/format/image";
import type { ConcernSummary } from "@/lib/format/types";

/**
 * The "Shop By Skin Concern" card grid.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The concerns come from the database.**
 *
 * They used to be a static array. The admin manages them now, so a
 * concern the admin adds has to appear here without a code change — and
 * the static array is retired rather than kept in parallel, because two
 * lists drift and the drifted one is the one the storefront shows.
 *
 * **2. The card is image-on-top, title-below.**
 *
 * This is the layout the whole page already uses for products, and it
 * is the layout a shopper reads fastest: a picture of the thing, then
 * the name of the thing. The title sits **below** the image on the
 * card's own surface — never on top of the photograph.
 *
 * That single decision is what removes an entire class of problem. The
 * earlier version put the label *over* the image and had to fight the
 * photograph for legibility: a dark scrim, a gradient, a blur, a local
 * scrim, white text, drop shadows — six layers of defence, all of them
 * there because the text was in the wrong place. Text on an image is
 * only ever legible by luck, and the luck runs out the moment an admin
 * uploads a bright product shot.
 *
 * So the photograph is left alone. It is shown at full strength, with
 * no tint and no scrim, because there is nothing on top of it to
 * protect.
 *
 * **3. The card is sized to belong to the page, not to dominate it.**
 *
 * The card deliberately matches the **product grid's** geometry —
 * `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, the same column
 * count, the same gutters, the same `gap-y` rhythm. The concern grid
 * is one of the discovery sections on the home page, sitting above
 * best sellers and new arrivals; if it is bigger than the product
 * grid below it, the page reads as though the discovery sections are
 * more important than the catalogue, which is the wrong hierarchy for
 * a shop.
 *
 * The image frame is **landscape `4/3`**, not portrait. A concern image
 * is a *feature* image — a scene, a treatment, a texture — and
 * landscape is how feature images are composed. It also cuts the
 * frame's height by 44% against a portrait `3/4` at the same column
 * width, which is the difference between a compact card and one that
 * dominates the viewport.
 *
 * **4. The image is an enhancement, not a requirement.**
 *
 * A concern with no uploaded image renders the same card shape with a
 * soft brand-gradient placeholder and the concern's initials. The
 * placeholder is deliberately the same aspect ratio and the same
 * radius as a real image, so the grid stays perfectly aligned whether
 * or not the admin has decorated every concern. A card that collapses
 * to a different shape would break the row.
 *
 * **5. The ingredient tags are gone from the card.**
 *
 * The lead tag (`BHA`) and its related family were floating over the
 * image as translucent pills. They were clutter: an ingredient code is
 * a *filter* concept, not a category concept, and a shopper scanning
 * "Acne" and "Dryness" does not scan "BHA".
 *
 * **6. The card carries content, not a repeated call to action.**
 *
 * The card once ended with a "Shop this concern" line on every tile.
 * Across eight cards that is eight identical sentences — visual noise
 * that adds no information, because the whole tile is already the
 * link. The product card and the category grid both spend their
 * second line on *content* (a brand, a product count); the concern
 * card spends its second line on the description the admin wrote,
 * which is the same job.
 *
 * **7. The card is one link, and the whole card is the target.**
 *
 * There is no button inside the concern card, so unlike the product
 * card there is nothing to nest. The image and the title are therefore
 * both part of a single link, and the title carries the accessible
 * name.
 *
 * **8. The card links to the concern, not to an ingredient.**
 *
 * The link is `?concern=<slug>` — the concern's own slug, and the
 * filter the catalogue performs on `Product.concernSlugs`.
 *
 * It used to be `?ingredient=<tag>`, which was a **filter over
 * ingredients** rather than a statement about the product. That was a
 * real mismatch: a card labelled "Acne" that filtered on BHA would
 * list every product that merely *contains* salicylic acid, including
 * ones the shop markets for congestion or texture. A shopper who
 * clicked "Acne" was asking "which of these are for acne?", and the
 * old link could not answer it.
 *
 * Now the answer is the shop's own answer, because the concern on the
 * product is set by an admin on the product form.
 */

/**
 * Derives the initials for the placeholder.
 *
 * Up to two initials, taken from the meaningful words of the name — the
 * same rule the product image placeholder uses, so the two placeholders
 * look like siblings.
 */
function initialsFor(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);

  if (words.length === 0) return "•";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/**
 * The "Shop By Concern" card grid.
 */
export function ConcernGrid({
  concerns,
}: {
  /**
   * The concerns to show.
   */
  readonly concerns: readonly ConcernSummary[];
}) {
  if (concerns.length === 0) {
    return null;
  }

  return (
    <div className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 no-scrollbar sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:px-0 lg:grid-cols-4">
      {concerns.map((concern) => (
        <Link
          key={concern.id}
          href={`/products?concern=${encodeURIComponent(concern.slug)}`}
          className={[
            "group flex w-[168px] shrink-0 snap-start flex-col",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          ].join(" ")}
        >
          {/*
            The image frame.

            A **landscape 4:3** ratio, matching the compactness of the
            product grid. The frame owns the radius and the shadow; the
            image inside is plain `object-cover` with no tint, because
            nothing is layered on top of it.

            `object-cover` is the right fit here, and deliberately the
            opposite of the brand logo's `object-contain`: a concern
            image is a *scene*, and a scene wants to fill its frame.
            A logo wants to be contained, because cropping a wordmark
            mangles it; a photograph wants to be cropped, because
            cropping a scene just chooses which part of it you see.
          */}
          <span
            className={[
              "relative block aspect-[4/3] w-full overflow-hidden",
              "rounded-[var(--radius-card)] bg-stone-50",
              "shadow-[var(--shadow-card)]",
              "transition-shadow duration-300 group-hover:shadow-[var(--shadow-lift)]",
            ].join(" ")}
          >
            {concern.image ? (
              <Image
                src={imageUrl(concern.image)}
                alt=""
                fill
                sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 168px"
                className="object-cover transition-transform duration-500 ease-[var(--ease-out-soft)] group-hover:scale-105"
              />
            ) : (
              /*
                The neutral placeholder.

                The same stone canvas the product card's fallback uses, so
                the two discovery rows and the catalogue rows read as one
                family. A concern with no photograph is *pending
                decoration* — it should not be the loudest card in the
                grid just because it has no picture.
              */
              <span
                aria-hidden="true"
                className="absolute inset-0 flex items-center justify-center bg-stone-50 ring-1 ring-inset ring-stone-200/70"
              >
                {/*
                  The initials, and nothing else.

                  The concern's ingredient tag used to sit under them —
                  which put the ingredient axis back on a card whose whole
                  point is that it is not an ingredient card. The title
                  below the frame already names the concern, so the tag
                  was saying the same thing a third time, in a language
                  the shopper was not browsing by.
                */}
                <span className="px-3 text-center font-serif text-2xl leading-none text-stone-400">
                  {initialsFor(concern.name)}
                </span>
              </span>
            )}
          </span>

          {/*
            The body — the title, on the card's own surface.

            No scrim, no gradient, no drop shadow, and no pills: the
            text is on the page's background, where it has always been
            perfectly legible. This is the whole point of moving it
            below the image.

            The spacing is tight — `pt-3` and a `text-sm` title —
            because the card is now one of several in a dense row, and
            a loose title would read as a heading rather than as a card
            label.
          */}
          <span className="flex flex-1 flex-col pt-3">
            <span className="block truncate font-serif text-sm font-bold leading-snug text-foreground transition-colors group-hover:text-brand-700">
              {concern.name}
            </span>

            {concern.description ? (
              <span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-foreground-muted">
                {concern.description}
              </span>
            ) : null}
          </span>
        </Link>
      ))}
    </div>
  );
}
