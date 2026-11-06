import {
  PaymentBrandMark,
  railTint,
} from "@/components/commerce/payment-brand-mark";
import { CheckIcon } from "@/components/ui/icons";
import type { PaymentRail } from "@/lib/format/payment-rails";

/**
 * The provider grid.
 *
 * ── The grid is inert, and that is the point ──────────────────────────────
 *
 * This grid looks like a radio group, and it is built with real radio
 * inputs — but it is a **confirmation**, not a control.
 *
 * `settleGatewayPayment` reads `order.paymentMethod` **from the
 * database** and never accepts a method from the client. The order row
 * is the record. So if this grid let the customer switch bKash for
 * Nagad, the settle would succeed while the order row still said
 * `BKASH` — and the shop would try to reconcile a bKash transfer
 * against a Nagad order. That is DECISIONS.md #147 broken in a new
 * place.
 *
 * So the radio for the recorded rail is `checked` and the others are
 * `disabled`. The customer sees the full reference-design grid, sees
 * exactly which rail their order is on, and **cannot** desynchronise
 * the order from its own record.
 *
 * The radio is still a radio rather than a plain `<div>`, because the
 * radio carries semantics a div does not: the browser's own `checked`
 * state, the announcement of the position ("bKash, radio button, 1 of
 * 2"), and the arrow-key navigation between options.
 *
 * ── The disabled technique ────────────────────────────────────────────────
 *
 * A disabled radio is removed from the tab order, which is correct. But
 * it must still be **perceivable**, so:
 *
 *   • The radio keeps `disabled`, so a screen reader announces the tile
 *     as unavailable.
 *   • The tile sits at `opacity-60` with `cursor-not-allowed` — never
 *     `display:none`, which would remove it from the tree entirely.
 *   • The reason is **visible text**, not `sr-only`. A sighted customer
 *     must be able to *read* why a tile is greyed out; a reason only a
 *     screen reader can hear is not an explanation.
 *
 * Each grid is its own `<fieldset>` with a `<legend>`, so the screen
 * reader announces the group and the position within it — the same
 * idiom the checkout's operator choice uses.
 */

/**
 * The props for the grid.
 */
export type PaymentProviderGridProps = {
  /** The rails to show. */
  readonly rails: readonly PaymentRail[];
  /** The id of the rail the order was recorded with. */
  readonly selectedRailId: string;
  /** The accessible name of the group. */
  readonly legend: string;
  /** The name of the radio group. */
  readonly name: string;
  /** Extra classes for the grid. */
  readonly className?: string;
};

/**
 * The provider grid.
 */
export function PaymentProviderGrid({
  rails,
  selectedRailId,
  legend,
  name,
  className,
}: PaymentProviderGridProps) {
  return (
    <fieldset className={className}>
      <legend className="sr-only">{legend}</legend>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {rails.map((rail) => {
          const isSelected = rail.id === selectedRailId;

          /**
           * Whether the rail can be used.
           *
           * A rail is usable when it is **available in principle** *and*
           * it is the one this order was recorded with. A rail the shop
           * cannot settle is never usable, whatever the order says.
           */
          const isUsable = rail.status === "available" && isSelected;

          const inputId = `${name}-${rail.id}`;

          return (
            <div key={rail.id}>
              {/*
                The label.

                It is a `<label>` wrapping the radio, so clicking the tile
                selects the radio — the house's pattern from the payment
                method selector. It is **not** a `<label htmlFor>` with
                the radio outside, because the radio is `disabled` on
                most tiles and a label pointing at a disabled control
                does nothing.
              */}
              <label
                htmlFor={inputId}
                className={[
                  "flex h-full flex-col gap-2 rounded-[var(--radius-card)] border p-3",
                  "transition-all duration-200 ease-[var(--ease-out-soft)]",
                  "focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2",
                  isSelected
                    ? "border-brand-400 bg-brand-50 ring-1 ring-brand-300"
                    : "border-border bg-surface",
                  isUsable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                ].join(" ")}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={name}
                  value={rail.id}
                  checked={isSelected}
                  disabled={!isUsable}
                  onChange={() => {
                    /*
                     * Deliberately empty of behaviour.
                     *
                     * The grid is a confirmation, not a control. The
                     * `onChange` exists only so the radio is a real
                     * radio rather than a `<div role="radio">`; the
                     * selected rail is decided by the server's order
                     * row, and nothing the customer does here can
                     * change it.
                     *
                     * Writing it this way — an empty handler with a
                     * comment — is deliberate. A future edit that adds
                     * an `onMethodChange` here would let the customer
                     * desynchronise the order from its own record.
                     */
                  }}
                  className="peer sr-only"
                />

                <span className="flex items-start justify-between gap-2">
                  <PaymentBrandMark
                    shortLabel={rail.shortLabel}
                    tint={railTint(rail.id)}
                    className={isSelected ? "" : "grayscale"}
                  />

                  {/*
                    The selection ring.

                    Drawn from the radio's real `checked` state by the
                    `peer` sibling, so it is the browser's own notion of
                    selection rather than a second piece of state.
                  */}
                  <span
                    aria-hidden="true"
                    className={[
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
                      "transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2",
                      isSelected
                        ? "border-brand-600 bg-brand-600 text-white"
                        : "border-neutral-300 bg-surface",
                    ].join(" ")}
                  >
                    {isSelected ? <CheckIcon width={12} height={12} /> : null}
                  </span>
                </span>

                <span className="text-sm font-semibold text-foreground">
                  {rail.label}
                </span>
              </label>

              {/*
                The reason.

                **Visible text**, not `sr-only`. A sighted customer must
                be able to read why a tile is greyed out — a reason only
                a screen reader can hear is not an explanation. It is
                also the reconciliation guard made legible: the customer
                can see that the shop *can* take a Nagad payment, just
                not for this order.
              */}
              {rail.reason ? (
                <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-foreground-muted">
                  {rail.reason}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
