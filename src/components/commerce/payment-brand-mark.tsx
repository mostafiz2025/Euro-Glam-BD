/**
 * The brand marks.
 *
 * ── Why the marks are drawn rather than downloaded ────────────────────────
 *
 * There are **no logo assets** in this repository, and the house forbids
 * pulling in an icon library — `src/components/ui/icons.tsx` says why:
 * bundle size, and no `node_modules` dependency in the client bundle.
 *
 * So the marks are **drawn**, in three kinds:
 *
 *   ┌──────────────────┬──────────────────────────────────────────────┐
 *   │ Card networks    │ A typographic wordmark pill — "VISA",         │
 *   │                  │ "Mastercard", "AMEX".                        │
 *   ├──────────────────┼──────────────────────────────────────────────┤
 *   │ Mobile banking   │ A 44×44 rounded tile carrying the provider's │
 *   │ and banks        │ short mark, tinted per provider.             │
 *   ├──────────────────┼──────────────────────────────────────────────┤
 *   │ Mastercard       │ Two overlapping circles — the one mark whose  │
 *   │                  │ geometry genuinely *is* the identity.        │
 *   └──────────────────┴──────────────────────────────────────────────┘
 *
 * A card network's identity *is* its name, so a wordmark is a faithful
 * rendering of it — an "M" tile identifies nothing, and would tell an
 * Amex customer that their card is a Mastercard.
 *
 * The provider tiles are a different case: a tile is what a logo grid
 * *looks like*, and the provider's full name is always present as text
 * beside the tile. So nothing is identified by the mark alone.
 *
 * ── The honesty rule ──────────────────────────────────────────────────────
 *
 * These are **derived marks**, not the providers' real logos, and the
 * window says so — the header carries a `Sandbox` chip. A customer must
 * never think they are paying a real bKash.
 *
 * Every colour comes from the theme tokens. A raw palette class here
 * would not follow the dark theme.
 */

import type { CardBrand } from "@/lib/format/card";

/**
 * The props for a brand mark.
 */
export type PaymentBrandMarkProps = {
  /**
   * The card network to draw.
   *
   * When omitted, the component draws a **provider tile** instead — the
   * rounded square with a short mark.
   */
  readonly brand?: CardBrand;
  /** The short mark for a provider tile — "bK", "IB". */
  readonly shortLabel?: string;
  /**
   * The tint for a provider tile.
   *
   * One of the theme's semantic tints. Not a raw palette value.
   */
  readonly tint?: "brand" | "success" | "warning" | "info" | "neutral";
  /**
   * Whether the mark sits on a **dark** ground.
   *
   * A card network's wordmark is drawn on a white chip with dark ink —
   * that is how a card network's identity actually looks, and it is
   * what makes the mark recognisable. But `bg-surface` follows the
   * theme, and on the **dark footer** that chip would be a dark
   * rectangle with dark text: an invisible mark.
   *
   * So the footer's marks are forced onto a light chip. `onDark`
   * swaps the theme-dependent surface and ink for a fixed light pair,
   * which is correct in both themes because a payment badge must read
   * the same way on every ground it appears on.
   */
  readonly onDark?: boolean;
  /** Extra classes for the mark. */
  readonly className?: string;
};

/**
 * The wordmark for each card network.
 *
 * `unknown` has no wordmark — a card from a network this shop has not
 * heard of is a perfectly ordinary thing to type, and inventing a
 * wordmark for it would be a guess. It is drawn as a neutral tile
 * instead.
 */
const CARD_WORDMARKS: Record<Exclude<CardBrand, "unknown">, string> = {
  visa: "VISA",
  mastercard: "Mastercard",
  amex: "AMEX",
  discover: "DISCOVER",
};

/**
 * The tint classes for a provider tile.
 *
 * Each is a *soft* background with a *strong* foreground, so the tile
 * reads as a chip rather than as a button, and the text on it keeps its
 * contrast in both themes.
 *
 * The semantic colours — `success`, `warning`, `info` — are **single
 * tokens** in the theme, not ramps, so they carry no `-100`/`-800`
 * steps. They are used here with an alpha modifier for the background
 * and at full strength for the foreground, which is the only way to get
 * a soft chip out of a single-colour token.
 */
const TINT_CLASSES = {
  brand: "bg-brand-100 text-brand-800",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  info: "bg-info/15 text-info",
  neutral: "bg-surface-muted text-foreground-muted",
} as const;

/**
 * The brand mark.
 */
export function PaymentBrandMark({
  brand,
  shortLabel,
  tint = "neutral",
  onDark = false,
  className,
}: PaymentBrandMarkProps) {
  /**
   * The card-network wordmark.
   *
   * The wordmark is a `<span>` with `aria-hidden`, because the network's
   * name is always rendered as text beside it — the mark is decoration
   * and the name is the content.
   */
  if (brand) {
    /**
     * The chip's own surface and ink.
     *
     * On a light ground the chip follows the theme, so it is a raised
     * surface in the light theme and a raised surface in the dark one.
     * On a **dark** ground the chip is forced to a fixed light pair —
     * a white chip with dark ink — because that is how a card
     * network's identity actually looks, and because the theme's dark
     * surface would render the wordmark invisible.
     */
    const chip = onDark
      ? "bg-white text-neutral-900 ring-white/25"
      : "bg-surface text-foreground ring-border";

    if (brand === "mastercard") {
      return (
        <span
          aria-hidden="true"
          className={[
            "flex h-8 w-12 items-center justify-center rounded-md",
            "ring-1",
            chip,
            className ?? "",
          ].join(" ")}
        >
          {/*
            The two overlapping circles.

            The one mark whose geometry genuinely *is* the identity, and
            it is trivially drawable — so it is drawn rather than
            approximated with a letter.

            The two colours are the one deliberate exception to the
            theme-token rule. A card network's identity colours are
            *part of the identity*, and the theme's rose — which is the
            shop's own brand colour — would make this mark look like
            bKash's. So the network's own two hues are used here, and
            nowhere else.
          */}
          <span className="relative block h-4 w-7">
            <span className="absolute left-0 top-0 block h-4 w-4 rounded-full bg-red-500/90" />
            <span className="absolute left-3 top-0 block h-4 w-4 rounded-full bg-amber-400/90" />
          </span>
        </span>
      );
    }

    if (brand === "unknown") {
      // An unknown network. No wordmark, no guess — a neutral chip.
      return (
        <span
          aria-hidden="true"
          className={[
            "flex h-8 w-12 items-center justify-center rounded-md",
            "text-[10px] font-bold uppercase tracking-wide",
            "ring-1",
            onDark
              ? "bg-white/10 text-white/70 ring-white/20"
              : "bg-surface-muted text-foreground-muted ring-border",
            className ?? "",
          ].join(" ")}
        >
          Card
        </span>
      );
    }

    const wordmark = CARD_WORDMARKS[brand];

    return (
      <span
        aria-hidden="true"
        className={[
          "flex h-8 items-center justify-center rounded-md px-2.5",
          "text-[11px] font-bold uppercase tracking-wide",
          "ring-1",
          chip,
          className ?? "",
        ].join(" ")}
      >
        {wordmark}
      </span>
    );
  }

  /**
   * The provider tile.
   */
  return (
    <span
      aria-hidden="true"
      className={[
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
        "text-xs font-bold tracking-wide",
        TINT_CLASSES[tint],
        className ?? "",
      ].join(" ")}
    >
      {shortLabel}
    </span>
  );
}

/**
 * The tint a provider's tile is drawn in.
 *
 * A lookup rather than a prop threaded through, so the same provider is
 * always the same colour wherever it appears — bKash is rose everywhere
 * or it is inconsistent everywhere.
 */
export function railTint(railId: string): PaymentBrandMarkProps["tint"] {
  switch (railId) {
    case "BKASH":
      return "brand";
    case "NAGAD":
      return "info";
    case "ROCKET":
      return "warning";
    case "UPAY":
      return "success";
    case "TAP":
      return "neutral";
    default:
      return "neutral";
  }
}
