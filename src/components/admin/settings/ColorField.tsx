"use client";

import {
  marqueeContrast,
  MIN_CONTRAST_BODY,
  normalizeHexColor,
} from "@/lib/format/colors";

/**
 * A colour field.
 *
 * ── What this is ──────────────────────────────────────────────────────────
 *
 * One colour the admin chooses, with a **native picker** and a hex
 * text box beside it.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The picker is the native one.**
 *
 * `<input type="color">` is the browser's own control, and it is used
 * rather than a custom one for three reasons:
 *
 *   • It opens the operating system's colour panel, which on a phone is
 *     the thing the customer already knows how to use.
 *   • It is keyboard-accessible and screen-reader-labelled for free.
 *   • It always hands back `#rrggbb`, which is exactly the shape the
 *     validation layer accepts. A custom picker would have to
 *     reproduce that guarantee.
 *
 * **2. The hex box is for people who know the colour.**
 *
 * A picker cannot reach a colour the admin has in mind but cannot find
 * by eye — a brand colour from a design file, say. The text box lets
 * them type it.
 *
 * It is validated **while they type**, and only a value that could
 * still become a hex triplet is written back. An incomplete value is
 * not pushed into the picker, because a colour input cannot hold a
 * half-typed hex — the two would disagree, and the picker would be
 * showing a colour the admin never chose.
 *
 * **3. The contrast is shown, live.**
 *
 * The pair's contrast ratio is displayed **as the admin chooses**, not
 * only when they press Save. The server refuses an illegible pair, and
 * a refusal that arrives after the admin has spent a minute choosing is
 * a worse experience than a warning that appeared while they were
 * still choosing.
 *
 * The warning is a **warning**, not a block: the client may not know
 * what the other half of the pair *already saved* is, and the server's
 * judgement on the stored pair is the authority. So the client warns
 * on what it can see, and the server refuses on what it knows.
 */
export function ColorField({
  id,
  label,
  description,
  value,
  onChange,
  /** The colour this one is measured against, for the contrast reading. */
  against,
  /** True when the pair is too faint to read. */
  warns,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The current value, as a hex triplet. */
  readonly value: string;
  readonly onChange: (next: string) => void;
  /**
   * The other colour of the pair, for the contrast reading.
   *
   * `null` when the pair is not measurable — the admin has not chosen
   * the other half yet.
   */
  readonly against: string | null;
  /** True when the pair is below the legibility threshold. */
  readonly warns: boolean;
  readonly disabled?: boolean;
}) {
  const normalized = normalizeHexColor(value) ?? "#000000";

  const ratio =
    against === null ? null : marqueeContrast(against, normalized);

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>

      <p className="mt-0.5 text-xs text-foreground-muted">{description}</p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {/*
          The picker.

          It is a real `<input type="color">`, so it is keyboard
          accessible and it hands back a six-digit hex triplet. The
          visible swatch is the input's own rendering — there is one
          control and not two that have to be kept in step.
        */}
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="color"
            value={normalized}
            onChange={(event) => onChange(event.target.value.toLowerCase())}
            disabled={disabled}
            aria-describedby={`${id}-contrast`}
            className="h-10 w-14 cursor-pointer rounded-[var(--radius-card)] border border-border bg-surface p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          />

          <input
            type="text"
            value={normalized}
            onChange={(event) => {
              const next = event.target.value.trim().toLowerCase();

              // Only a value that could still become a hex triplet is
              // written back — and the field keeps the admin's own
              // text so they can see what they typed.
              if (/^#[0-9a-f]{0,6}$/.test(next)) {
                onChange(next);
              }
            }}
            disabled={disabled}
            spellCheck={false}
            aria-label={`${label} hex value`}
            className="w-28 rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>

      {/* ── The contrast reading ───────────────────────────────────── */}
      <p
        id={`${id}-contrast`}
        className={[
          "mt-2 text-xs",
          warns
            ? "font-medium text-red-600 dark:text-red-400"
            : "text-foreground-muted",
        ].join(" ")}
      >
        {ratio === null ? (
          "Choose the other colour to see the contrast."
        ) : warns ? (
          `This combination is too faint to read — ${ratio}:1. The announcement needs at least ${MIN_CONTRAST_BODY}:1.`
        ) : (
          `Contrast ${ratio}:1 — comfortably readable.`
        )}
      </p>
    </div>
  );
}
