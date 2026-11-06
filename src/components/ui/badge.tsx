import type { ReactNode } from "react";

/**
 * The badge.
 *
 * A small status pill — "New", "Best Seller", "Out of stock", "Save 15%".
 * The variants are deliberately few, and each one has exactly one
 * meaning, so a badge in the wild always reads the same way.
 */

/**
 * The badge variants.
 */
export type BadgeVariant =
  /** A solid rose fill. For the strongest signal. */
  | "brand"
  /** A soft rose tint. For "New" and similar. */
  | "soft"
  /** A warm dark fill. For "Best Seller". */
  | "dark"
  /** A neutral outline. For "Out of stock". */
  | "outline"
  /** A green fill. For "In stock". */
  | "success"
  /** A red fill. For stock warnings. */
  | "danger";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  brand: "bg-brand-600 text-white",
  soft: "bg-brand-100 text-brand-800",
  dark: "bg-neutral-900 text-white",
  outline: "border border-border bg-surface text-foreground-muted",
  success: "bg-emerald-100 text-emerald-800",
  danger: "bg-red-100 text-red-700",
};

export type BadgeProps = {
  readonly variant?: BadgeVariant;
  readonly className?: string;
  readonly children: ReactNode;
};

export function Badge({ variant = "soft", className, children }: BadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2.5 py-1",
        "text-[11px] font-semibold uppercase tracking-wide",
        VARIANT_CLASSES[variant],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
