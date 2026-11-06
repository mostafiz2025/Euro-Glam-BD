"use client";

import { MinusIcon, PlusIcon } from "@/components/ui/icons";

/**
 * The quantity selector.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The quantity never exceeds the stock.**
 *
 * The maximum is `min(10, stockQuantity)`. Ten is the API's per-line
 * limit; the stock is what the shop actually has. A selector that lets
 * a customer pick 50 units of a product with 3 in stock produces an
 * error at the cart instead of at the point of choice.
 *
 * **2. The buttons are real buttons with real labels.**
 *
 * The minus and plus are icon-only, so each carries an `aria-label`
 * that says what it does *and* to what: "Increase the quantity to 3",
 * not "increase". A screen-reader user should know what the button
 * will do before pressing it.
 *
 * **3. The number is a live region.**
 *
 * `aria-live="polite"` on the value means the change is announced when
 * it happens, rather than the user having to go looking for it.
 *
 * **4. A disabled button is explained.**
 *
 * When the quantity is at the maximum, the plus button is disabled —
 * and the reason is in the label, so it is discoverable before the
 * press.
 */

/**
 * The props for the quantity selector.
 */
export type QuantitySelectorProps = {
  readonly value: number;
  readonly onChange: (value: number) => void;
  /** The stock on hand. Zero disables the whole control. */
  readonly stockQuantity: number;
  /** The maximum the customer may select. */
  readonly max?: number;
  readonly className?: string;
};

/**
 * The absolute cap on a single line.
 *
 * Matches the API's per-line quantity limit. Ten tubes of a cleanser is
 * a personal habit; ten is also the ceiling the cart will accept, and
 * the selector should not offer a quantity the cart will refuse.
 */
const ABSOLUTE_MAX = 10;

export function QuantitySelector({
  value,
  onChange,
  stockQuantity,
  max,
  className,
}: QuantitySelectorProps) {
  const effectiveMax = Math.min(max ?? ABSOLUTE_MAX, stockQuantity, ABSOLUTE_MAX);

  const canDecrease = value > 1;
  const canIncrease = value < effectiveMax;

  return (
    <div
      className={[
        "inline-flex items-center rounded-full border border-border bg-surface",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        disabled={!canDecrease}
        aria-label={
          canDecrease
            ? `Decrease the quantity to ${value - 1}`
            : "The minimum quantity is 1"
        }
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-brand-50 hover:text-brand-700 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <MinusIcon width={15} height={15} />
      </button>

      <span
        aria-live="polite"
        aria-atomic="true"
        className="min-w-8 text-center text-sm font-semibold tabular-nums text-foreground"
      >
        {value}
        <span className="sr-only"> units</span>
      </span>

      <button
        type="button"
        onClick={() => onChange(Math.min(effectiveMax, value + 1))}
        disabled={!canIncrease}
        aria-label={
          canIncrease
            ? `Increase the quantity to ${value + 1}`
            : `The maximum quantity is ${effectiveMax}`
        }
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-brand-50 hover:text-brand-700 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <PlusIcon width={15} height={15} />
      </button>
    </div>
  );
}
