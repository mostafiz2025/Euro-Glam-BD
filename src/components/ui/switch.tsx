"use client";

import { useId } from "react";

/**
 * The switch.
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 * A **toggle**, not a checkbox.
 *
 * The two look similar, and the difference is not cosmetic: a checkbox
 * says "include this in the batch", and a switch says "this is on right
 * now". The announcement marquee is the second kind of thing — it is
 * either showing or it is not — so it gets a switch.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The state is a real `<input type="checkbox">`.**
 *
 * The whole visual is CSS drawn on top of a checkbox that has been
 * hidden with `sr-only`. That is not a shortcut — it is the accessible
 * answer:
 *
 *   • The control is **reachable by keyboard** and toggles on Space.
 *   • It is **announced with its state** by every screen reader. The
 *     `role="switch"` is what makes the announcement "on" and "off"
 *     rather than "checked" and "unchecked" — and `switch` is one of
 *     the roles ARIA in HTML permits on a checkbox, so it does not
 *     override the element's native behaviour.
 *   • It **participates in a form**. A `<button role="switch">` would
 *     submit nothing, so the parent form would have to be wired by hand
 *     to read the state — and a form that submits the wrong value is
 *     worse than no form.
 *
 * The checkbox is `sr-only` rather than `hidden` because `display: none`
 * removes an element from the accessibility tree **and** from the tab
 * order; `sr-only` keeps it focusable while hiding it visually.
 *
 * **2. The knob moves with `peer-checked`.**
 *
 * The `peer` variant is what makes the two halves of the control agree:
 * `peer` styles the knob and the track **relative to the checkbox that
 * precedes it** in the DOM. There is no JavaScript connecting the input
 * to the visual, so there is no state to fall out of sync — the visual
 * *is* the input.
 *
 * The knob is moved with `translate-x` rather than by changing `left`,
 * because `transform` does not trigger layout.
 *
 * **3. The colours come from the theme.**
 *
 * The off state is `bg-border` and the on state is `bg-brand-600`; the
 * knob is `bg-white` in both. A switch that changed its *hue* when it
 * was switched on would be a second thing to read, and the position of
 * the knob is already saying everything.
 *
 * **4. It says which way it points.**
 *
 * The knob is off to the left and on to the right — the convention
 * every switch on every platform uses. Reversing it for a European
 * boutique would be a joke at the customer's expense.
 *
 * **5. The focus ring is on the track, not the knob.**
 *
 * The knob is 12 pixels wide and sits *inside* the track, so a ring
 * around the knob would be clipped by the track's own overflow. The
 * ring is drawn on the track instead, and it is a `peer-focus-visible`
 * variant, so it appears only when the checkbox has keyboard focus.
 *
 * **6. It can be disabled, and it looks it.**
 *
 * A disabled switch is dimmed and is skipped by the tab order. It is a
 * real state on a real form.
 */

/**
 * The switch's props.
 */
export type SwitchProps = {
  /** Whether the switch is on. */
  readonly checked: boolean;
  /** Called when the switch is flipped. */
  readonly onChange: (checked: boolean) => void;
  /** The visible label. */
  readonly label: string;
  /** A description shown under the label. */
  readonly description?: string;
  /** The accessible name, when the visible label is not the whole name. */
  readonly ariaLabel?: string;
  /** Whether the switch can be interacted with. */
  readonly disabled?: boolean;
  /** The switch's id, for a `<label htmlFor>`. */
  readonly id?: string;
};

/**
 * The switch.
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  ariaLabel,
  disabled = false,
  id,
}: SwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label
          htmlFor={switchId}
          className={[
            "block text-sm font-medium",
            disabled ? "text-foreground-muted" : "text-foreground",
            "cursor-pointer",
          ].join(" ")}
        >
          {label}
        </label>

        {description ? (
          <p className="mt-0.5 text-xs text-foreground-muted">{description}</p>
        ) : null}
      </div>

      {/*
        The control.

        The `<input>` comes **first** so that `peer-*` has something to
        peer against — a peer variant only matches elements that come
        *after* the peer in the DOM.
      */}
      <span className="relative inline-flex shrink-0 items-center">
        <input
          id={switchId}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          aria-label={ariaLabel}
          className="peer sr-only"
        />

        {/* The track. */}
        <span
          aria-hidden="true"
          className={[
            "h-6 w-11 rounded-full transition-colors duration-200",
            "peer-checked:bg-brand-600",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
            "bg-border",
            disabled ? "opacity-50" : "",
          ].join(" ")}
        />

        {/* The knob. */}
        <span
          aria-hidden="true"
          className={[
            "pointer-events-none absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm",
            "transition-transform duration-200 ease-[var(--ease-out-soft)]",
            "peer-checked:translate-x-5",
            disabled ? "opacity-50" : "",
          ].join(" ")}
        />
      </span>
    </div>
  );
}
