/**
 * Colour helpers for the announcement marquee.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The marquee's ground and type are two hex triplets the admin picks.
 * Two things follow from that, and both of them need code:
 *
 *   1. The value must be **checked**. A colour that reaches the browser
 *      as `url(javascript:…)` or as an unterminated string is not a
 *      colour, it is a way to inject something else into a `style`
 *      attribute. The value is stored in the database and rendered
 *      inline, so it is untrusted input and is validated as such.
 *
 *   2. The pair must be **legible**. The admin may choose a ground and
 *      a type that are too close in lightness, and the result is a bar
 *      nobody can read. The shop should be told *before* the bar goes
 *      live, not after a customer has complained.
 *
 * So the arithmetic lives here, once, and both the server (which
 * refuses an illegible pair on the way in) and the client (which warns
 * while the admin is still choosing) use it.
 *
 * ── Why this module is client-safe ───────────────────────────────────────
 *
 * It imports nothing and holds no server-only code, so a client
 * component can use it without pulling anything into the browser
 * bundle. The same rule `src/lib/format/payment.ts` follows.
 */

/**
 * The colours the marquee can be painted with.
 *
 * A **six-digit hex triplet** — `#rrggbb` — in the canonical lowercase
 * form.
 *
 * Three-digit hex (`#fff`) is accepted on the way in and expanded to
 * six digits, because a colour picker and a human both produce it. But
 * the *stored* form is always six digits: one canonical spelling per
 * colour means the audit log's "before" and "after" cannot disagree
 * about whether `#FFF` changed.
 */
export type HexColor = `#${string}`;

/**
 * A six-digit hex triplet, in any case.
 *
 * The `i` flag matters. The **schema** accepts an uppercase colour —
 * `/^#(?:[0-9a-f]{6}|[0-9a-f]{3})$/i` — because a human typing
 * `#BE185D` has given a perfectly good colour and refusing it would be
 * pedantry. If this pattern were lowercase-only, the schema would
 * accept the value and the normaliser would then throw it away, and the
 * admin would silently get the **default** colour instead of the one
 * they picked. The two layers have to agree on what a colour is.
 */
const SIX_DIGIT_HEX = /^#[0-9a-f]{6}$/i;

/**
 * A three-digit hex triplet, in any case.
 */
const THREE_DIGIT_HEX = /^#[0-9a-f]{3}$/i;

/**
 * The shop's darkest fill.
 *
 * The colour the marquee carried before the admin could change it, and
 * the default for a fresh row. It is the **fill** step of the neutral
 * ramp — the part that deliberately does not re-point in the dark
 * theme — so a bar painted in it looks the same in both themes.
 */
export const DEFAULT_MARQUEE_BG = "#1c1917";

/**
 * The colour the marquee's type was in before the admin could change
 * it.
 */
export const DEFAULT_MARQUEE_TEXT = "#ffffff";

/**
 * Whether a string is a hex colour this module accepts.
 *
 * Accepts the three- and six-digit forms, in either case.
 */
export function isHexColor(value: string): boolean {
  return SIX_DIGIT_HEX.test(value) || THREE_DIGIT_HEX.test(value);
}

/**
 * Puts a hex colour into its canonical form.
 *
 * Returns `null` when the value is not a colour at all — which is
 * different from a colour that is merely wrong, and is why the return
 * type is nullable rather than a string.
 *
 * The canonical form is **lowercase six digits**. Two reasons:
 *
 *   1. `#FFF` and `#ffffff` are the same colour, and the database
 *      must not hold both — otherwise the admin's audit trail would
 *      show a colour change that did not happen.
 *   2. Lowercase is what the browser's colour inputs produce, so a
 *      value that round-trips through the admin form comes back
 *      unchanged.
 */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();

  if (THREE_DIGIT_HEX.test(trimmed)) {
    const [r, g, b] = trimmed.slice(1).toLowerCase();

    return `#${r}${r}${g}${g}${b}${b}`;
  }

  if (SIX_DIGIT_HEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return null;
}

/**
 * The red, green and blue channels of a hex colour, as 0–255 numbers.
 *
 * Returns `null` for a value that is not a colour.
 */
export function hexChannels(
  color: string,
): { readonly r: number; readonly g: number; readonly b: number } | null {
  const normalized = normalizeHexColor(color);

  if (normalized === null) return null;

  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

/**
 * A colour's **relative luminance**, as WCAG defines it.
 *
 * The sRGB channels are linearised first, because a monitor's response
 * to light is not linear: the arithmetic is only correct on linear
 * values, and skipping that step is the usual reason a hand-rolled
 * contrast check disagrees with every other one.
 *
 * Returns `null` for a value that is not a colour.
 */
export function relativeLuminance(color: string): number | null {
  const channels = hexChannels(color);

  if (channels === null) return null;

  const linearize = (channel: number): number => {
    const value = channel / 255;

    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };

  return (
    0.2126 * linearize(channels.r) +
    0.7152 * linearize(channels.g) +
    0.0722 * linearize(channels.b)
  );
}

/**
 * The contrast ratio between two colours, from 1 to 21.
 *
 * 1 is two identical colours — no contrast at all. 21 is black against
 * white — the maximum the display can produce.
 *
 * Returns `null` when either colour is not a colour.
 */
export function contrastRatio(
  foreground: string,
  background: string,
): number | null {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);

  if (a === null || b === null) return null;

  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The WCAG thresholds.
 *
 * **4.5:1** is the ratio at which body text is legible for everyone,
 * including a reader with low vision. **3:1** is the threshold for
 * *large* text — 18pt, or 14pt bold — and for a UI component's
 * boundary.
 *
 * The marquee is a single scrolling line of marketing copy at a small
 * size, so the bar's own type is held to the **4.5:1** body-text
 * threshold. It is not a heading, and it is not large.
 */
export const MIN_CONTRAST_BODY = 4.5;
export const MIN_CONTRAST_LARGE = 3;

/**
 * Whether a pair of colours is legible enough for body text.
 *
 * The rule is deliberately the **strict** one. A bar is a thin strip of
 * a moving line of type; a pair that would be acceptable for a large
 * heading is not acceptable for this.
 *
 * A pair that cannot be measured at all — because one of the colours
 * is not a colour — is **not** legible. The safe answer to "is this
 * pair readable?" is always the one that does not claim it is.
 */
export function isLegiblePair(
  foreground: string,
  background: string,
): boolean {
  const ratio = contrastRatio(foreground, background);

  if (ratio === null) return false;

  return ratio >= MIN_CONTRAST_BODY;
}

/**
 * The contrast ratio between the marquee's ground and its type,
 * rounded to one decimal place.
 *
 * `null` when the pair cannot be measured.
 */
export function marqueeContrast(
  background: string,
  foreground: string,
): number | null {
  const ratio = contrastRatio(foreground, background);

  if (ratio === null) return null;

  return Math.round(ratio * 10) / 10;
}

/**
 * The swatches the admin may choose the marquee's colours from.
 *
 * ── Why a closed set of swatches as well as a free colour picker ────────
 *
 * The picker allows any colour, because the shop may want a colour
 * this codebase has never seen. But a picker that opens on a random
 * hue is a picker that makes people *choose* — and the swatches are
 * the answer to "what is the bar usually?", so the common cases are
 * one click away.
 *
 * Every swatch is a pair that has been checked for legibility, so
 * picking two of them can never produce an unreadable bar.
 */
export const MARQUEE_COLOR_PRESETS = [
  {
    name: "Ink",
    background: "#1c1917",
    foreground: "#ffffff",
  },
  {
    name: "Rose",
    background: "#be185d",
    foreground: "#ffffff",
  },
  {
    name: "Deep rose",
    background: "#9d174d",
    foreground: "#ffffff",
  },
  {
    name: "Warm stone",
    background: "#44403c",
    foreground: "#ffffff",
  },
  {
    name: "White",
    background: "#ffffff",
    foreground: "#1c1917",
  },
  {
    name: "Blush",
    background: "#fce7f3",
    foreground: "#9d174d",
  },
] as const;

/**
 * The `tel:` href for a display phone number.
 *
 * ── Why the digits are extracted rather than the string escaped ─────────
 *
 * The shop writes its number the way it reads it — "01819-000000",
 * "+880 1819-000000", "01819 000000". Those are all the same number,
 * and all of them should dial.
 *
 * So the href is built from the **digits and the plus sign alone**,
 * with spaces, dashes and parentheses dropped. Everything else in the
 * string is discarded — which also means a string that tried to smuggle
 * a scheme (`javascript:…`) cannot: the scheme's letters are not
 * digits, so they are removed and what is left is a bare number.
 *
 * Returns `null` when the string holds no digits at all, so the caller
 * renders plain text rather than a link that does nothing.
 */
export function phoneHref(phone: string): string | null {
  const digits = phone.replace(/[^\d+]/g, "");

  // A leading `+` is the only symbol that survives, and it is only
  // meaningful at the very front.
  const cleaned = digits.startsWith("+")
    ? `+${digits.slice(1).replace(/\D/g, "")}`
    : digits.replace(/\D/g, "");

  if (cleaned.replace(/\D/g, "") === "") return null;

  return `tel:${cleaned}`;
}
