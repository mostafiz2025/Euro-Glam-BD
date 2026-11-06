"use client";

import { MARQUEE_COLOR_PRESETS } from "@/lib/format/colors";

/**
 * The colour presets.
 *
 * ── Why a set of swatches as well as a free picker ───────────────────────
 *
 * The picker allows **any** colour, because the shop may want a colour
 * this codebase has never seen — a brand colour from a design file, a
 * seasonal tone. That is the feature.
 *
 * But a picker that opens on an arbitrary hue is a picker that makes
 * people *choose*, and the swatches are the answer to "what is the bar
 * usually?". So the common cases are one click away.
 *
 * ── Why a preset is a **pair** ───────────────────────────────────────────
 *
 * Each swatch is a background *and* a text colour together, because
 * that is how the bar is actually used: the ground and the type are
 * chosen as a unit, and a pair is only legible as a unit.
 *
 * So clicking a swatch sets **both** colours. That is deliberate, and
 * it is why every preset here has been checked for legibility — picking
 * two of them can never produce an unreadable bar.
 *
 * A separate control for the ground alone would allow the admin to
 * paint the bar in the ground of one preset and the type of another,
 * which is how you get a rose ground with white type at 2:1.
 */
export function ColorPresetPicker({
  background,
  text,
  onApply,
  disabled,
}: {
  /** The current background. */
  readonly background: string;
  /** The current text colour. */
  readonly text: string;
  /** Called with the preset's pair. */
  readonly onApply: (background: string, text: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-foreground">Colour presets</p>

      <p className="mt-0.5 text-xs text-foreground-muted">
        Each preset is a background and a text colour together, so the
        announcement is always readable. Picking one replaces both.
      </p>

      <ul className="mt-3 flex flex-wrap gap-2">
        {MARQUEE_COLOR_PRESETS.map((preset) => {
          const isChosen =
            preset.background.toLowerCase() === background.toLowerCase() &&
            preset.foreground.toLowerCase() === text.toLowerCase();

          return (
            <li key={preset.name}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onApply(preset.background, preset.foreground)}
                aria-pressed={isChosen}
                className={[
                  "flex items-center gap-2 rounded-full border py-1 pl-1 pr-3",
                  "text-xs font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  isChosen
                    ? "border-brand-500 bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-200"
                    : "border-border bg-surface text-foreground hover:border-brand-300",
                ].join(" ")}
              >
                {/*
                  The swatch itself: the preset's ground, with a dot in
                  the preset's type colour. Two pixels of type tell the
                  admin what the bar will look like before they click.
                */}
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 items-center justify-center rounded-full"
                  style={{ backgroundColor: preset.background }}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: preset.foreground }}
                  />
                </span>

                {preset.name}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
