"use client";

import { useState } from "react";

import { StarIcon } from "@/components/ui/icons";

/**
 * The star input.
 *
 * ── Why this is not a `<select>` or a radio group ────────────────────────
 *
 * A rating is an *ordinal* scale — 4 is meaningfully better than 3, and
 * a customer should be able to see the scale to answer the question. A
 * dropdown of "1 … 5" hides that relationship; a row of stars shows it.
 *
 * The radio-group semantics are still there underneath: each star is a
 * `<label>` wrapping a real `<input type="radio">`, so the form works
 * with a keyboard, submits correctly, and is announced as a radio group
 * by a screen reader. The visual stars are `aria-hidden`.
 *
 * ── The hover state ──────────────────────────────────────────────────────
 *
 * The stars fill on hover, so the customer can preview the value before
 * committing. But the *selected* value is the state, not the hover — the
 * fill is derived from `hovered ?? value`, and clearing the hover falls
 * back to the value. A control that shows the hovered value as though it
 * were selected is lying about the state.
 */
export type StarInputProps = {
  /** The currently selected rating, 0 when nothing is chosen. */
  readonly value: number;
  /** Called with the new rating. */
  readonly onChange: (rating: number) => void;
  /** The name of the radio group. */
  readonly name: string;
  /** Whether the input is disabled. */
  readonly disabled?: boolean;
  /** The error message, if the field is invalid. */
  readonly error?: string;
};

export function StarInput({
  value,
  onChange,
  name,
  disabled = false,
  error,
}: StarInputProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  const shown = hovered ?? value;
  const errorId = `${name}-error`;

  return (
    <div>
      {/*
       * The error is announced on the fieldset, not on an individual
       * radio. `aria-invalid` is not a supported attribute on the
       * `radio` role — a radio is valid or invalid as part of a group,
       * and the group is what the fieldset represents.
       */}
      <fieldset
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      >
        <legend className="sr-only">Your rating</legend>

        <div
          className="flex items-center gap-1"
          onMouseLeave={() => setHovered(null)}
        >
          {[1, 2, 3, 4, 5].map((star) => (
            <label
              key={star}
              className={[
                "cursor-pointer rounded p-0.5 transition-transform duration-150",
                "hover:scale-110",
                disabled ? "cursor-not-allowed opacity-50" : "",
              ].join(" ")}
              onMouseEnter={() => {
                if (!disabled) setHovered(star);
              }}
            >
              <input
                type="radio"
                name={name}
                value={star}
                checked={value === star}
                onChange={() => onChange(star)}
                disabled={disabled}
                className="sr-only"
              />

              <StarIcon
                width={28}
                height={28}
                className={[
                  "transition-colors duration-150",
                  star <= shown ? "text-brand-500" : "text-neutral-300",
                ].join(" ")}
                fill={star <= shown ? "currentColor" : "none"}
                strokeWidth={1.5}
              />

              <span className="sr-only">
                {star} {star === 1 ? "star" : "stars"}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
