"use client";

import Image from "next/image";
import { useState } from "react";

import { firstImageUrl } from "@/lib/format/image";

/**
 * The product image, with a placeholder fallback.
 *
 * ── Why the fallback matters more than it looks ─────────────────────────
 *
 * The seeded catalogue has **no images at all** — `Product.images` is
 * `[]` for every seeded row, because image upload is a separate admin
 * action. So a component that assumes `images[0]` exists crashes on the
 * very first product in the database.
 *
 * Rather than pretend the images exist, this component renders a
 * typographic placeholder: the product's initials on a soft stone
 * canvas, with the category name. It looks deliberate rather than
 * broken, and it is what a shopper sees for a product whose photo has
 * not been uploaded yet.
 *
 * The alternative — a grey box with a broken-image icon — reads as a
 * bug. This reads as a catalogue entry.
 *
 * ── Why the fallback is neutral rather than rose ──────────────────────────
 *
 * A shopper who has *not* decided to buy has not earned the brand
 * gradient. The rose placeholder is a statement; on a grid of twenty
 * cards it becomes wallpaper, and every card ends up the same shade of
 * pink whether or not it has a photograph. So the fallback is
 * **neutral** — a soft stone canvas with a hairline ring and a muted
 * monogram — and it reads as "photography pending" rather than "this
 * product is pink".
 *
 * ── Why this is a client component ───────────────────────────────────────
 *
 * A product can have an image **key** and still fail to render it: the
 * file was deleted from storage, the key points at a legacy path that no
 * longer resolves, or the optimiser times out on a first request for a
 * large file. In every one of those cases `next/image` has a URL but no
 * picture — and the browser's broken-image state paints the **alt text**
 * across the card, which reads as a bug to the shopper.
 *
 * The only way to catch that is the image element's own `onError`, and
 * that is a DOM event, so it needs the client. The server-rendered
 * markup is unchanged: the same `<img>` is sent, and the fallback only
 * replaces it if the image genuinely fails in the browser.
 */

/**
 * The props for the product image.
 */
export type ProductImageProps = {
  /** The storage keys for the product's images. */
  readonly images: readonly string[];
  /** The product name — used for the alt text and the placeholder. */
  readonly name: string;
  /** The category name — shown in the placeholder. */
  readonly categoryName?: string;
  /** The class applied to the outer element. */
  readonly className?: string;
  /** The `sizes` attribute for the Next.js image optimiser. */
  readonly sizes?: string;
  /** The `priority` flag. Set on above-the-fold images only. */
  readonly priority?: boolean;
};

/**
 * Derives the initials for the placeholder.
 *
 * Up to two initials, taken from the meaningful words of the name. The
 * brand name is usually the first word ("The Ordinary", "CeraVe"), so
 * the first two words give "Th" for "The Ordinary" — not ideal, but
 * the placeholder is a fallback, not a logo.
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
 * The neutral placeholder.
 *
 * `bg-stone-50` is the canvas: a warm off-white that sits a step below
 * the card surface, so the frame reads as an image *area* that has not
 * been filled in yet — not as a hole punched in the page. The inset ring
 * gives the box an edge without a hard border, which is what separates
 * "no photo" from "a blank photo".
 *
 * It is `absolute inset-0` so that it occupies exactly the same box as
 * the `next/image` it replaces. Without that, the placeholder collapses
 * to the height of its own text and leaves the rest of the frame showing
 * whatever is behind it.
 */
function ImagePlaceholder({
  name,
  categoryName,
}: {
  readonly name: string;
  readonly categoryName?: string;
}) {
  return (
    <div
      className={[
        "absolute inset-0 flex items-center justify-center overflow-hidden",
        "bg-stone-50 ring-1 ring-inset ring-stone-200/70",
      ].join(" ")}
      role="img"
      aria-label={`${name} — no product photograph available`}
    >
      <div className="px-4 text-center">
        <div className="font-serif text-2xl leading-none text-stone-400 sm:text-3xl">
          {initialsFor(name)}
        </div>
        {categoryName ? (
          <div className="mt-2 truncate text-[10px] font-medium uppercase tracking-[0.18em] text-stone-400">
            {categoryName}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ProductImage({
  images,
  name,
  categoryName,
  className,
  sizes = "(min-width: 1280px) 20vw, (min-width: 768px) 33vw, 50vw",
  priority = false,
}: ProductImageProps) {
  const url = firstImageUrl(images);

  /**
   * Whether the image has failed to load.
   *
   * `false` is "not known yet"; `true` is "it broke". A broken image is
   * replaced by the same neutral placeholder a missing one gets, so the
   * two failure modes are visually identical — which is right, because
   * to a shopper they *are* the same failure: there is no photograph.
   */
  const [hasFailed, setHasFailed] = useState(false);

  const showPlaceholder = url === null || hasFailed;

  /*
    The wrapper owns the positioning.

    `next/image` with `fill` is `position: absolute; inset: 0`, so it
    fills the *nearest positioned ancestor*. Without a `relative` here,
    that ancestor is whatever happens to be further up the tree — which
    is how a cart line's thumbnail ends up sized to a page-level
    container, or how the placeholder ends up in the wrong box.

    Rendering the `relative` frame here means the component is
    self-contained: it fills whatever box it is given, and it never
    depends on the caller's markup.

    The wrapper does **not** clip (`overflow-hidden`), because a
    caller's hover-zoom transform has to be able to bleed past the
    image's own edges — that is the whole point of a zoom. The *caller's*
    frame is what clips the rounded corners.
  */
  return (
    <div className={["relative h-full w-full", className ?? ""].join(" ")}>
      {showPlaceholder ? (
        <ImagePlaceholder name={name} categoryName={categoryName} />
      ) : (
        <Image
          src={url as string}
          alt={name}
          fill
          sizes={sizes}
          priority={priority}
          onError={() => {
            setHasFailed(true);
          }}
          className="object-cover"
        />
      )}
    </div>
  );
}
