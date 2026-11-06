/**
 * Money formatting for the browser.
 *
 * ── Why this file exists, and why it is separate from `src/lib/pricing.ts`
 * ───────────────────────────────────────────────────────────────────────
 *
 * `src/lib/pricing.ts` is the server-side authority for money. It must
 * stay free of anything browser-specific, because it is imported by the
 * checkout service and the order service, and those run on the server.
 *
 * This module is the **presentation** layer: it turns an integer poisha
 * value into the string a customer reads. It contains no arithmetic and
 * no rules — only formatting.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **Money is integer poisha. Always. Never a float.**
 *
 * 1 BDT = 100 poisha. The conversion is done by integer division and
 * remainder, so `150050` poisha is exactly `৳1,500.50` — never
 * `৳1,500.4999999999998`, which is what floating-point arithmetic
 * would produce.
 *
 * The client never *computes* a price. It receives one from the API and
 * renders it. This module formats what it is given; it never decides
 * what something costs.
 */

/**
 * Formats a poisha amount as Bangladeshi Taka.
 *
 * The output uses the Bengali digit grouping (`en-BD` locale), so
 * `150050` renders as `৳1,500.50`.
 *
 * A negative amount is rendered with a leading minus sign. That case
 * cannot arise in the catalogue — a price is never negative — but a
 * refund or a credit can be, and a formatter that renders `৳-50` is a
 * formatter nobody trusts.
 *
 * @param pricePaisa - The amount, in poisha.
 */
export function formatPaisa(pricePaisa: number): string {
  const negative = pricePaisa < 0;
  const absolute = Math.abs(pricePaisa);

  const taka = Math.floor(absolute / 100);
  const paisa = absolute % 100;

  const takaFormatted = taka.toLocaleString("en-BD");

  const body =
    paisa === 0
      ? `৳${takaFormatted}`
      : `৳${takaFormatted}.${paisa.toString().padStart(2, "0")}`;

  return negative ? `-${body}` : body;
}

/**
 * Formats a poisha amount without the currency symbol.
 *
 * Used where the symbol is rendered separately — a price with the struck
 * through original, for instance, where showing `৳` twice reads as a
 * mistake.
 */
export function formatPaisaBare(pricePaisa: number): string {
  const negative = pricePaisa < 0;
  const absolute = Math.abs(pricePaisa);

  const taka = Math.floor(absolute / 100);
  const paisa = absolute % 100;

  const takaFormatted = taka.toLocaleString("en-BD");

  const body =
    paisa === 0
      ? takaFormatted
      : `${takaFormatted}.${paisa.toString().padStart(2, "0")}`;

  return negative ? `-${body}` : body;
}

/**
 * Returns the discount as a whole-number percentage.
 *
 * The API already sends `discountPercentage`, so this is only used to
 * derive a fallback from the two prices when the mirror column is
 * missing. The result is rounded, because a badge reading "14.2857% off"
 * is not a thing a customer should read.
 */
export function discountPercent(
  pricePaisa: number,
  discountPricePaisa: number | null,
  provided?: number | null,
): number | null {
  if (provided !== null && provided !== undefined) {
    return provided;
  }

  if (discountPricePaisa === null || pricePaisa <= 0) {
    return null;
  }

  if (discountPricePaisa >= pricePaisa) {
    return null;
  }

  return Math.round(((pricePaisa - discountPricePaisa) / pricePaisa) * 100);
}
