import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * The button.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **A button that navigates is a link, and a link that acts is a
 * button.** They are not interchangeable, and the difference is not
 * cosmetic — it is how a screen reader, a keyboard user and a
 * right-click menu all decide what the element means.
 *
 *   • `Button` renders a `<button>`. It runs an action: add to cart,
 *     submit, open a sheet.
 *   • `ButtonLink` renders an `<a>`. It navigates: "Shop now", a product
 *     card, a category tile.
 *
 * So this file exports both, and the variant logic is shared rather
 * than duplicated — the two must look identical, and a copy-pasted
 * class list is a class list that will drift.
 */

/**
 * The visual variants.
 */
export type ButtonVariant =
  /** The rose fill. One per screen — the primary action. */
  | "primary"
  /** A rose tint. Secondary emphasis. */
  | "secondary"
  /** An outline. Tertiary. */
  | "outline"
  /** No chrome. For inline actions. */
  | "ghost"
  /** A warm dark fill. Used for "Buy Now" beside the rose CTA. */
  | "dark"
  /**
   * The hero's primary action.
   *
   * A **deep** rose, not the ordinary `brand-600`. The hero panel is a
   * light poster in both themes — its gradients are pale washes and its
   * artwork sits behind a white scrim — so the ordinary rose would be a
   * pale rose in the dark theme, and a pale rose on a pale ground is
   * not an accent. This one does not re-point, for the same reason the
   * hero's ink does not.
   */
  | "hero"
  /**
   * The hero's secondary action.
   *
   * An outline on the same deep rose, on a translucent white ground so
   * the artwork still shows through it.
   */
  | "heroOutline";

/**
 * The size scale.
 *
 * `card` is the product card's action button. It is a **separate entry**
 * rather than a modifier of `sm` because it has a different job: it
 * shares a single horizontal line with the price, so its padding and
 * its label both have to yield on the narrowest breakpoint while the
 * label stays readable. Folding that into `sm` would mean every other
 * `sm` button on the site inherited the card's constraints.
 */
export type ButtonSize = "sm" | "card" | "md" | "lg";

/**
 * The class list for a variant and size.
 *
 * Every variant defines a `focus-visible` ring explicitly, because the
 * global `:focus-visible` outline is a fallback and a branded control
 * should have a branded ring.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white shadow-brand hover:bg-brand-700 active:bg-brand-800 focus-visible:ring-brand-600",
  secondary:
    "bg-brand-100 text-brand-800 hover:bg-brand-200 active:bg-brand-300 focus-visible:ring-brand-500",
  outline:
    "border border-border bg-surface text-foreground hover:border-brand-300 hover:bg-brand-50 focus-visible:ring-brand-500",
  ghost:
    "text-foreground-muted hover:bg-surface-muted hover:text-foreground focus-visible:ring-neutral-500",
  dark:
    "bg-neutral-900 text-white hover:bg-neutral-800 active:bg-neutral-950 focus-visible:ring-neutral-900",
  /*
    The hero's two actions.

    They use the hero's own accent rather than the theme's brand rose,
    because the hero panel is a light poster in both themes and the
    ordinary rose re-points to a pale tint in the dark one.

    The primary is a solid deep rose with white type — the highest
    contrast pair available on a pale ground, and the one that reads
    first at a glance.

    The secondary is an outline of the same rose over a translucent
    white fill. It is deliberately *not* a `surface` fill: the panel
    behind it is a photograph in some slides, and an opaque card would
    punch a hole in the picture. The translucency keeps the artwork
    continuous and still gives the label a ground to sit on.
  */
  hero:
    "bg-hero-accent text-white shadow-brand hover:bg-hero-accent-strong active:bg-hero-accent-strong focus-visible:ring-hero-accent",
  heroOutline:
    "border border-hero-accent/40 bg-white/70 text-hero-accent backdrop-blur-sm hover:border-hero-accent hover:bg-white/90 hover:text-hero-accent-strong focus-visible:ring-hero-accent",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-sm rounded-full gap-1.5",
  /*
    The card's action button.

    The label is "Add to Cart" in full — a shopper should never have to
    guess what the control does — but on a two-column phone grid the
    card is barely wider than the button's own text. So the padding and
    the type step down on the narrowest breakpoint and step back up
    from `sm`, where the grid is three columns wide and there is room.

    The step-up is written as a **second utility in the same class
    string** rather than as an override appended by a caller. Two
    competing `px-*` utilities are ordered by Tailwind's internal
    scale, not by the order they appear in the class attribute, so a
    caller "override" of the same property silently loses.
  */
  card: "h-9 gap-1.5 rounded-full px-2.5 text-[0.6875rem] sm:px-3 sm:text-[0.8125rem]",
  md: "h-11 px-5 text-sm rounded-full gap-2",
  lg: "h-13 px-7 text-base rounded-full gap-2",
};

/**
 * The shared class builder.
 */
function buttonClass(
  variant: ButtonVariant,
  size: ButtonSize,
  className: string | undefined,
  fullWidth: boolean,
): string {
  return [
    "inline-flex items-center justify-center font-medium",
    /*
      `whitespace-nowrap` is not optional.

      A button that wraps its label onto two lines changes **height**,
      and a button that changes height inside a fixed-height row pushes
      the row's other content out of alignment. On the product card the
      button shares a line with the price, and the whole point of that
      row is that every button in the grid sits on the same baseline. A
      wrapped label breaks it.
    */
    "whitespace-nowrap",
    "transition-colors duration-200 ease-[var(--ease-out-soft)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? "w-full" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A button that runs an action.
 */
export type ButtonProps = Omit<
  ComponentProps<"button">,
  "className" | "children"
> & {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className, fullWidth)}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * A link that looks like a button.
 */
export type ButtonLinkProps = {
  readonly href: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
} & Omit<
  ComponentProps<typeof Link>,
  "href" | "className" | "children" | "style"
>;

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      href={href}
      className={buttonClass(variant, size, className, fullWidth)}
      {...rest}
    >
      {children}
    </Link>
  );
}

/**
 * An icon-only button.
 *
 * The `label` is **required**, and it becomes the accessible name. An
 * icon button with no label is a button a screen reader announces as
 * "button" — which tells the user nothing.
 */
export type IconButtonProps = Omit<
  ComponentProps<"button">,
  "className" | "children"
> & {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
};

export function IconButton({
  label,
  className,
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={[
        "inline-flex h-10 w-10 items-center justify-center rounded-full",
        "text-foreground-muted transition-colors duration-200",
        "hover:bg-brand-50 hover:text-brand-700",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
