import Link from "next/link";

import { AddToCartButton } from "@/components/commerce/add-to-cart-button";
import { Badge } from "@/components/ui/badge";
import { HeartIcon } from "@/components/ui/icons";
import { DiscountBadge, Price } from "@/components/ui/price";
import { ProductImage } from "@/components/ui/product-image";
import { Rating } from "@/components/ui/rating";
import { displayBrand } from "@/lib/format/brand";
import type { ProductSummary } from "@/lib/format/types";

/**
 * The product card.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The whole card is not one giant link.**
 *
 * The instinct with a card layout is to wrap everything in an `<a>`. It
 * breaks the moment the card contains a button — and a nested button
 * inside a link is invalid HTML that behaves unpredictably across
 * browsers and screen readers.
 *
 * So the layout is: the image and the title are links, and the add
 * button is a sibling. The title link carries the accessible name, so
 * the card reads "La Roche-Posay Effaclar Purifying Foaming Gel, add to
 * cart" — two clear targets rather than one ambiguous one.
 *
 * **2. The price comes from the API.**
 *
 * `effectivePricePaisa` is rendered as-is. The card never re-derives the
 * discount rule, because the server is the one that charges the card.
 *
 * **3. Out of stock is visible before the button is pressed.**
 *
 * The badge says "Out of stock" and the button is disabled. A customer
 * who discovers it after tapping has been told something the shop
 * already knew.
 *
 * **4. The brand is a separate line from the name.**
 *
 * The product's name is the *whole* string the admin typed — "CeraVe
 * Hydrating Facial Cleanser" — and it carries the brand prefix inside
 * it. Repeating that prefix above the title would read as "CeraVe
 * CeraVe Hydrating Facial Cleanser", so the card shows the brand on its
 * own line and leaves the name alone.
 *
 * The brand comes from the API's stored `brand` field, falling back to
 * the derivation from the name for rows written before the column
 * existed. A product with no brand renders no line at all — an empty
 * line would read as a mistake.
 *
 * **5. The price and the add button share one row.**
 *
 * The card used to stack them: the price on a line of its own, the
 * button on the line below, full width. That is a *listing page* card —
 * it is optimised for the single product, and it wastes vertical space
 * that a grid of twenty cannot afford.
 *
 * On a grid, the shopper is comparing. The comparison is the price, and
 * the action is "add". So the two sit **side by side on one line**:
 * the price on the left, the button on the right, both on the same
 * baseline. The price is allowed to shrink before it wraps — a long
 * struck-through original price must never push the button onto a
 * second line, because a card whose button moves between its two
 * states is a card whose grid rows jump.
 *
 * The button is `flex-shrink-0` and the price is the only thing that
 * gives way, which is the correct priority: the button is the target,
 * the price is the information.
 *
 * The button says **"Add to Cart"** — the full label, with a shopping
 * bag beside it. The card used to shorten it to a bare "Add" to protect
 * this row's alignment, and that was the wrong trade: a shopper
 * reading "Add" has to work out *what* is being added, and the price
 * row does not actually need the sacrifice. The button's own size
 * scale is responsive — its type and its padding step down on a
 * two-column phone grid and back up from `sm` — so the full label fits
 * and the row still holds. See `add-to-cart-button.tsx`.
 *
 * **6. The card is a flat surface, not a floating panel.**
 *
 * The image sits in a rounded frame; the body below it sits on the
 * page's own canvas. A card that wrapped *both* in a white panel with a
 * shadow reads as a widget. A boutique storefront reads as a shop
 * window: each product is an object on a clean surface, and the type
 * beneath it is part of the page, not a card of its own.
 */

/**
 * The props for the product card.
 */
export type ProductCardProps = {
  readonly product: ProductSummary;
  /** The rating average, when the caller has it. */
  readonly rating?: { average: number; count: number };
  /** The size of the image area. */
  readonly imageAspect?: "square" | "portrait";
  /** Whether to show the add-to-cart button. */
  readonly showAddToCart?: boolean;
};

export function ProductCard({
  product,
  rating,
  imageAspect = "square",
  showAddToCart = true,
}: ProductCardProps) {
  const isOutOfStock = !product.inStock;
  const isLowStock = product.inStock && product.stockQuantity <= 5;

  /**
   * The brand, from the stored column — with the derivation from the
   * name as the fallback for rows written before the column existed.
   */
  const brand = displayBrand(product.brand, product.name);

  return (
    <article className="group relative flex flex-col">
      {/*
        The image frame.

        The frame owns the radius, the border and the shadow; the image
        inside is plain. `bg-stone-50` is the frame's own canvas, so a
        product with no photograph shows the neutral fallback rather
        than a broken white box.

        ── The border ────────────────────────────────────────────────────
        *
        * A hairline ring is drawn *outside* the shadow, not instead of
        * it. The two do different jobs: the shadow lifts the card off
        * the canvas, and the ring draws the card's **edge**. Without
        * the edge, a card whose photograph is the same white as the
        * page has no defined boundary — the shadow alone is too soft
        * to draw a crisp edge, and the card dissolves into the
        * background.
        *
        * The ring is `inset` and extremely faint. An inset ring draws
        * *inside* the frame, so it never enlarges the card or shifts
        * the layout — a 1px ring that grew the card would push every
        * card in the grid 2px out of alignment with its neighbour.
        *
        * ── The shadow ───────────────────────────────────────────────────
        *
        * `--shadow-card` at rest and `--shadow-lift` on hover. Both are
        * layered (a tight contact shadow plus a wide ambient one), so
        * the card reads as the *same object at two heights* rather than
        * as two different objects. The transition is deliberately slow
        * (600ms) and uses the soft easing, because a shadow that snaps
        * to its new depth reads as a jump rather than a lift.
      */}
      <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-stone-50 shadow-[var(--shadow-card)] ring-1 ring-inset ring-black/[0.04] transition-[box-shadow,transform] duration-500 ease-[var(--ease-out-soft)] group-hover:-translate-y-1 group-hover:shadow-[var(--shadow-lift)] group-hover:ring-black/[0.06]">
        <Link
          href={`/products/${product.id}`}
          className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          tabIndex={-1}
          aria-hidden="true"
        >
          <div
            className={[
              "relative w-full overflow-hidden",
              imageAspect === "square" ? "aspect-square" : "aspect-[3/4]",
            ].join(" ")}
          >
            {/*
              The zoom.

              The image scales on hover, and the *card* lifts. The
              division of labour matters: a card that scales as a
              whole takes its own text with it, and text that is scaled
              by a transform is re-rasterised — which is exactly how
              product names end up looking soft on a card that "zooms".

              So the image scales, and the card lifts. The title stays
              perfectly crisp, and the movement is still there.
            */}
            <ProductImage
              images={product.images}
              name={product.name}
              categoryName={product.category.name}
              className={[
                "transition-transform duration-500 ease-[var(--ease-out-soft)]",
                "group-hover:scale-105",
              ].join(" ")}
              sizes="(min-width: 1280px) 20vw, (min-width: 768px) 30vw, 45vw"
            />
          </div>
        </Link>

        {/* ── The badge stack ─────────────────────────────────────────── */}
        <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-1.5">
          {product.discountPricePaisa !== null &&
          product.discountPricePaisa < product.pricePaisa ? (
            <DiscountBadge
              pricePaisa={product.pricePaisa}
              discountPricePaisa={product.discountPricePaisa}
              discountPercentage={product.discountPercentage}
              className="bg-brand-600/95 shadow-[var(--shadow-brand)] backdrop-blur-sm"
            />
          ) : null}

          {isOutOfStock ? (
            <Badge variant="outline" className="bg-surface/90 backdrop-blur-sm">
              Out of stock
            </Badge>
          ) : product.isNewArrival ? (
            <Badge variant="soft" className="backdrop-blur-sm">
              New
            </Badge>
          ) : product.isBestSeller ? (
            <Badge variant="dark" className="backdrop-blur-sm">
              Best Seller
            </Badge>
          ) : null}
        </div>

        {/*
          The wishlist button.

          It is **hidden until the card is hovered** on a pointer
          device, and always visible on a touch device.

          The reason is that a heart on every card in a grid of twenty
          is twenty hearts competing with the product photograph, and
          the shopper is looking at the *product*. But a control that
          only exists on hover is a control a touch user can never
          reach — so on a coarse pointer it is always visible.

          `opacity-0` rather than `hidden` keeps its box reserved, so
          revealing it does not shift the badges beside it.
        */}
        <button
          type="button"
          aria-label={`Save ${product.name} to your wishlist`}
          className={[
            "absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full",
            "bg-surface/90 text-foreground-muted shadow-sm backdrop-blur",
            "transition-all duration-300 ease-[var(--ease-out-soft)]",
            "opacity-0 focus-visible:opacity-100 hover:text-brand-600",
            "group-hover:opacity-100",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            // Always visible where there is no hover to reveal it.
            "[@media(hover:none)]:opacity-100",
          ].join(" ")}
        >
          <HeartIcon width={16} height={16} />
        </button>
      </div>

      {/* ── The body ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col pt-4">
        {brand ? (
          /*
            The brand line.

            Uppercase and widely tracked, because it is a *label* — the
            maker of the product, not part of the product's name. It is
            also the smallest type on the card by a deliberate margin:
            the eye should land on the photograph, then the name, and
            only then notice who made it.
          */
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground-muted/80">
            {brand}
          </p>
        ) : null}

        {/*
          The name.

          `font-medium` at `text-[0.9375rem]` — a hair above the
          surrounding UI text, so the product name reads as the card's
          subject rather than as a label hanging off it. The title link
          carries the accessible name for the whole card; the visible
          name stays plain and calm.
        */}
        <h3 className="mt-1.5 text-[0.9375rem] font-medium leading-snug text-foreground">
          <Link
            href={`/products/${product.id}`}
            className="line-clamp-2 transition-colors duration-300 hover:text-brand-700 focus-visible:outline-none focus-visible:text-brand-700"
          >
            {product.name}
          </Link>
        </h3>

        {rating && rating.count > 0 ? (
          <div className="mt-2">
            <Rating average={rating.average} count={rating.count} />
          </div>
        ) : null}

        {isLowStock ? (
          <p className="mt-2 text-[11px] font-medium text-amber-600">
            Only {product.stockQuantity} left
          </p>
        ) : null}

        {/*
          The price and the button, **on one line**.

          The price is the flexible element (`min-w-0` + `truncate`) and
          the button is fixed (`shrink-0`), so a long struck-through
          original price shrinks the price rather than displacing the
          button onto a second row. The row's own `mt-auto` pushes it
          to the bottom of the card, so every button in a grid sits on
          the same baseline however long the product name is.

          The row is also `whitespace-nowrap` on the price, and the
          price itself is asked to hold one line: a card whose button
          moves between its two states is a card whose grid rows jump,
          and a discounted price that wraps onto two lines is exactly
          that.

          ── On the button's label ────────────────────────────────────────
          *
          * The button says **"Add to Cart"**, not "Add". That is the
          * clearest statement of the action, and the icon beside it
          * makes it unmistakable at a glance. The label used to be
          * shortened to a bare "Add" to protect this row's alignment —
          * and the fix is not a shorter word but a **responsive** one:
          * the button's own size scale steps its type and its padding
          * down on a two-column phone grid and back up from `sm`, where
          * the grid is three columns wide and there is room.
          *
          * So the label is full almost everywhere, the row never wraps,
          * and the shopper is never left guessing.
        */}
        <div className="mt-auto flex items-center justify-between gap-2 pt-4">
          <div className="min-w-0 flex-1">
            <Price
              pricePaisa={product.pricePaisa}
              discountPricePaisa={product.discountPricePaisa}
              size="card"
              nowrap
              className="whitespace-nowrap"
            />
          </div>

          {showAddToCart ? (
            <div className="shrink-0">
              <AddToCartButton
                productId={product.id}
                productName={product.name}
                stockQuantity={product.stockQuantity}
                size="card"
              />
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
