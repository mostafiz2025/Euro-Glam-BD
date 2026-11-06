import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
  hexChannels,
  isHexColor,
  isLegiblePair,
  MARQUEE_COLOR_PRESETS,
  marqueeContrast,
  MIN_CONTRAST_BODY,
  normalizeHexColor,
  phoneHref,
  relativeLuminance,
} from "@/lib/format/colors";

/**
 * The announcement marquee's colours.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The marquee's ground and type are two hex triplets the admin picks in
 * the admin console, and they are rendered **inline** into a `style`
 * attribute. Three properties carry the whole feature, and all three are
 * pure functions:
 *
 *   1. **A colour is a colour.** The value comes from the database and
 *      goes straight into a `style` attribute, so it is untrusted input
 *      and has to be checked. `url(javascript:…)` is not a colour, and
 *      it must never reach the page.
 *
 *   2. **One colour, one spelling.** `#FFF` and `#ffffff` are the same
 *      colour, and the database must not hold both — otherwise the
 *      admin's audit trail would show a colour change that did not
 *      happen.
 *
 *   3. **The pair must be readable.** The admin may pick a pale rose
 *      ground with white type, and the result is a bar on every page
 *      that says something nobody can read. So the pair is measured, and
 *      the threshold is WCAG's body-text ratio — because the marquee is
 *      a thin strip of a small moving line, not a heading.
 */
describe("normalizeHexColor", () => {
  it("leaves a canonical six-digit colour alone", () => {
    expect(normalizeHexColor("#1c1917")).toBe("#1c1917");
  });

  it("folds a colour to lowercase", () => {
    // One canonical spelling per colour, so the audit log's "before" and
    // "after" cannot disagree about whether `#FFF` changed.
    expect(normalizeHexColor("#BE185D")).toBe("#be185d");
  });

  it("expands the three-digit form", () => {
    // A colour picker and a human both produce it, and refusing it would
    // be pedantry.
    expect(normalizeHexColor("#fff")).toBe("#ffffff");
    expect(normalizeHexColor("#F0A")).toBe("#ff00aa");
  });

  it("trims the surrounding whitespace", () => {
    expect(normalizeHexColor("  #1c1917  ")).toBe("#1c1917");
  });

  it("refuses a value that is not a colour", () => {
    // These are the values that must never reach a `style` attribute.
    expect(normalizeHexColor("")).toBeNull();
    expect(normalizeHexColor("red")).toBeNull();
    expect(normalizeHexColor("#12345")).toBeNull();
    expect(normalizeHexColor("#1234567")).toBeNull();
    expect(normalizeHexColor("#12345g")).toBeNull();
    expect(normalizeHexColor("url(javascript:alert(1))")).toBeNull();
    expect(normalizeHexColor("#1c1917; background: url(x)")).toBeNull();
  });

  it("refuses a value with no hash", () => {
    expect(normalizeHexColor("1c1917")).toBeNull();
  });
});

describe("isHexColor", () => {
  it("accepts the three- and six-digit forms, in either case", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("#FFF")).toBe(true);
    expect(isHexColor("#1c1917")).toBe(true);
    expect(isHexColor("#1C1917")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isHexColor("#ffff")).toBe(false);
    expect(isHexColor("fff")).toBe(false);
    expect(isHexColor("#gggggg")).toBe(false);
  });
});

describe("hexChannels", () => {
  it("splits a colour into its channels", () => {
    expect(hexChannels("#1c1917")).toEqual({ r: 28, g: 25, b: 23 });
    expect(hexChannels("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexChannels("#000000")).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("expands the three-digit form first", () => {
    expect(hexChannels("#f00")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("returns null for a value that is not a colour", () => {
    expect(hexChannels("nope")).toBeNull();
  });
});

describe("relativeLuminance", () => {
  it("is zero for black and one for white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("is a number between zero and one", () => {
    const luminance = relativeLuminance("#be185d");

    expect(luminance).not.toBeNull();
    expect(luminance as number).toBeGreaterThan(0);
    expect(luminance as number).toBeLessThan(1);
  });

  it("returns null for a value that is not a colour", () => {
    expect(relativeLuminance("nope")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is 21 for black against white", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });

  it("is 1 for a colour against itself", () => {
    expect(contrastRatio("#1c1917", "#1c1917")).toBeCloseTo(1, 5);
  });

  it("does not care which way round the pair is", () => {
    // The ratio is a property of the pair, so the caller cannot get the
    // order wrong and get a different answer.
    expect(contrastRatio("#ffffff", "#1c1917")).toBeCloseTo(
      contrastRatio("#1c1917", "#ffffff") as number,
      5,
    );
  });

  it("returns null when either colour is not a colour", () => {
    expect(contrastRatio("nope", "#000000")).toBeNull();
    expect(contrastRatio("#000000", "nope")).toBeNull();
  });
});

describe("isLegiblePair", () => {
  it("accepts white on the shop's darkest fill", () => {
    // The default pair. If this ever failed, the default bar would be
    // unreadable and every shop that never touched the colours would
    // ship an illegible page.
    expect(isLegiblePair(DEFAULT_MARQUEE_TEXT, DEFAULT_MARQUEE_BG)).toBe(true);
  });

  it("accepts white on the brand's rose", () => {
    expect(isLegiblePair("#ffffff", "#be185d")).toBe(true);
  });

  it("accepts ink on white", () => {
    expect(isLegiblePair("#1c1917", "#ffffff")).toBe(true);
  });

  it("refuses white on a pale blush", () => {
    /*
     * The pair an admin would pick by accident — a soft background with
     * the default white type. It is a valid pair of colours and an
     * unreadable bar.
     */
    expect(isLegiblePair("#ffffff", "#fce7f3")).toBe(false);
  });

  it("refuses a colour against itself", () => {
    expect(isLegiblePair("#be185d", "#be185d")).toBe(false);
  });

  it("refuses a pair it cannot measure", () => {
    // The safe answer to "is this pair readable?" is the one that does
    // not claim it is.
    expect(isLegiblePair("nope", "#000000")).toBe(false);
    expect(isLegiblePair("#000000", "nope")).toBe(false);
  });

  it("uses the body-text threshold, not the large-text one", () => {
    /*
     * The marquee is a small moving line of marketing copy — not a
     * heading, and not large. So the strict ratio applies.
     */
    expect(MIN_CONTRAST_BODY).toBe(4.5);
  });
});

describe("marqueeContrast", () => {
  it("rounds to one decimal place", () => {
    const ratio = marqueeContrast("#1c1917", "#ffffff");

    expect(ratio).not.toBeNull();
    expect(ratio as number).toBe(Math.round((ratio as number) * 10) / 10);
  });

  it("returns null for a pair it cannot measure", () => {
    expect(marqueeContrast("nope", "#ffffff")).toBeNull();
  });
});

describe("the colour presets", () => {
  it("are all legible pairs", () => {
    /*
     * Every swatch is a pair that has been checked, so picking two of
     * them can never produce an unreadable bar.
     */
    for (const preset of MARQUEE_COLOR_PRESETS) {
      expect(
        isLegiblePair(preset.foreground, preset.background),
        `${preset.name} should be legible`,
      ).toBe(true);
    }
  });

  it("are all real colours", () => {
    for (const preset of MARQUEE_COLOR_PRESETS) {
      expect(isHexColor(preset.background)).toBe(true);
      expect(isHexColor(preset.foreground)).toBe(true);
    }
  });

  it("include the default pair", () => {
    // The default has to be one of the offered pairs, or the admin form
    // would open on a swatch it does not show.
    expect(
      MARQUEE_COLOR_PRESETS.some(
        (preset) =>
          preset.background === DEFAULT_MARQUEE_BG &&
          preset.foreground === DEFAULT_MARQUEE_TEXT,
      ),
    ).toBe(true);
  });
});

describe("the defaults", () => {
  it("are the colours the bar carried before it could be painted", () => {
    expect(DEFAULT_MARQUEE_BG).toBe("#1c1917");
    expect(DEFAULT_MARQUEE_TEXT).toBe("#ffffff");
  });

  it("are legible together", () => {
    expect(isLegiblePair(DEFAULT_MARQUEE_TEXT, DEFAULT_MARQUEE_BG)).toBe(true);
  });
});

describe("phoneHref", () => {
  it("keeps the digits and the leading plus", () => {
    expect(phoneHref("+880 1819-000000")).toBe("tel:+8801819000000");
    expect(phoneHref("01819-000000")).toBe("tel:01819000000");
  });

  it("drops the separators a human writes", () => {
    // The shop writes its number the way it reads it, and all of these
    // spellings are the same number and all of them should dial.
    expect(phoneHref("(01819) 000000")).toBe("tel:01819000000");
    expect(phoneHref("01819 000000")).toBe("tel:01819000000");
  });

  it("discards anything that is not a digit, so a scheme cannot be smuggled in", () => {
    /*
     * The scheme's letters are not digits, so they are removed and what
     * is left is a bare number — the `1` in `alert(1)`.
     */
    expect(phoneHref("javascript:alert(1)")).toBe("tel:1");
  });

  it("returns null for a string with no digits", () => {
    // The caller renders plain text rather than a link that does nothing.
    expect(phoneHref("")).toBeNull();
    expect(phoneHref("no numbers here")).toBeNull();
  });
});
