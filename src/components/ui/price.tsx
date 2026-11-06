import { discountPercent, formatPaisa, formatPaisaBare } from "@/lib/format/money";

/**
 * The price display.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **The component never computes a price. It renders the one it is
 * given.**
 *
 * The API returns `effectivePricePaisa` — the price the customer
 * actually pays — and this component renders exactly that. It does not
 * re-derive the discount rule, because a second implementation of the
 * discount rule is a second chance to disagree with the server, and the
 * server is the one that charges the card.
 *
 * The one thing it *does* compute is the discount percentage, and only
 * as a **fallback** when the API's mirror column is missing. That
 * fallback is clearly marked in `discountPercent`.
 */

/**
 * The props for the price display.
 */
export type PriceProps = {
  /** The list price, in poisha. */
  readonly pricePaisa: number;
  /** The discounted price, in poisha. Null when not discounted. */
  readonly discountPricePaisa: number | null;
  /** The size of the price. */
  readonly size?: "sm" | "card" | "md" | "lg";
  /** Whether to show the struck-through original price. */
  readonly showOriginal?: boolean;
  /**
   * Whether the price must hold a **single line**.
   *
   * The product card's price shares a row with the add-to-cart button,
   * and that row's alignment is what keeps a grid of cards reading as a
   * grid. So the card asks for a one-line price, and the *original*
   * price is the element that gives way — it truncates while the price
   * the customer actually pays stays whole.
   *
   * This is a **prop** rather than a class for a reason. Tailwind
   * resolves two same-property utilities by its own internal order, not
   * by the order they appear in the class string — and `flex-wrap` is
   * emitted *after* `flex-nowrap`, so passing `flex-nowrap` through
   * `className` while the component also applies `flex-wrap` silently
   * does nothing. A boolean makes the intent explicit and removes the
   * conflict at the source.
   */
  readonly nowrap?: boolean;
  readonly className?: string;
};

/**
 * The size scale for the price.
 *
 * `card` is the product card's price, and it is **responsive**: a
 * smaller step on a two-column phone grid, stepping up once the grid
 * widens. It is a separate entry rather than a modifier of `sm` because
 * the card's price shares a single line with the add-to-cart button,
 * and the two have to be sized *together* — a price and a button that
 * each pick their own scale will collide on the narrowest grid.
 */
const SIZE_CLASSES = {
  sm: { price: "text-sm font-semibold", original: "text-xs" },
  card: {
    price: "text-sm font-semibold sm:text-base",
    original: "text-[0.625rem] sm:text-xs",
  },
  md: { price: "text-base font-semibold", original: "text-xs" },
  lg: { price: "text-2xl font-bold", original: "text-sm" },
} as const;

export function Price({
  pricePaisa,
  discountPricePaisa,
  size = "md",
  showOriginal = true,
  nowrap = false,
  className,
}: PriceProps) {
  const isDiscounted =
    discountPricePaisa !== null && discountPricePaisa < pricePaisa;

  const effective = isDiscounted ? discountPricePaisa : pricePaisa;

  const sizes = SIZE_CLASSES[size];

  return (
    <span
      className={[
        "inline-flex items-baseline gap-x-2 gap-y-0.5",
        /*
          The default is to wrap, so a long original price falls to a
          second line rather than overflowing a narrow column. A caller
          that needs the price to hold one line — the product card's
          price-and-button row — sets `nowrap`, and the *original* price
          is then the element that gives way.
        */
        nowrap ? "flex-nowrap" : "flex-wrap",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        className={`${sizes.price} text-foreground tabular-nums ${
          nowrap ? "shrink-0" : ""
        }`}
      >
        {formatPaisa(effective)}
      </span>

      {isDiscounted && showOriginal ? (
        <span
          className={`${sizes.original} text-foreground-muted line-through tabular-nums ${
            nowrap ? "truncate" : ""
          }`}
        >
          {formatPaisaBare(pricePaisa)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The discount badge.
 *
 * Rendered only when there is a real discount. A badge reading "0% off"
 * is worse than no badge.
 */
export function DiscountBadge({
  pricePaisa,
  discountPricePaisa,
  discountPercentage,
  className,
}: {
  readonly pricePaisa: number;
  readonly discountPricePaisa: number | null;
  readonly discountPercentage?: number | null;
  readonly className?: string;
}) {
  if (discountPricePaisa === null || discountPricePaisa >= pricePaisa) {
    return null;
  }

  const percent = discountPercent(
    pricePaisa,
    discountPricePaisa,
    discountPercentage,
  );

  if (percent === null || percent <= 0) {
    return null;
  }

  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1",
        "text-[10px] font-bold uppercase tracking-wide text-white",
        "shadow-sm ring-1 ring-inset ring-white/20",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {percent}% off
    </span>
  );
}
