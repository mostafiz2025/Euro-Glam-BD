/**
 * Narrowing the untyped `Product.ingredients` column.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * `Product.ingredients` is a `Jsonb` column. The database does not know
 * its shape, and Prisma therefore types it as `unknown`. The seed writes
 * it as `{ ingredients: string[], source?: string }`, and the admin writes
 * it through a validated schema — but the *read* path cannot assume
 * that, because a row could have been written by an older version of the
 * admin, or by a direct database edit.
 *
 * So the shape is **narrowed at the read boundary**, with a total
 * function: it always returns something renderable, and it never throws.
 *
 * The rule: **a malformed row renders as an empty list, not as a crash
 * on the product page.** A product whose ingredient JSON is corrupt
 * should still be sellable.
 */

/**
 * The narrowed shape of the ingredients column.
 */
export type ParsedIngredients = {
  /** The ingredient list, in the order it was written. */
  ingredients: string[];
  /** Where the list came from, e.g. "Manufacturer label". */
  source: string | null;
  /** Any extra free-text notes the admin attached. */
  notes: string | null;
};

/**
 * Narrows the untyped ingredients value.
 *
 * @param raw - The value as it came out of the database.
 */
export function parseIngredients(raw: unknown): ParsedIngredients {
  const empty: ParsedIngredients = {
    ingredients: [],
    source: null,
    notes: null,
  };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return empty;
  }

  const record = raw as Record<string, unknown>;

  const list = Array.isArray(record.ingredients)
    ? record.ingredients.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  return {
    ingredients: list,
    source: typeof record.source === "string" ? record.source : null,
    notes: typeof record.notes === "string" ? record.notes : null,
  };
}

/**
 * Turns a raw ingredient list into display-friendly short names.
 *
 * The list is stored with full INCI names ("Sodium Hyaluronate"), which
 * is correct for the ingredient table but long for a chip row. This
 * shortens the common ones for the chip row while the full list stays
 * available in the accordion.
 */
export function shortIngredientName(name: string): string {
  const known: Record<string, string> = {
    "Sodium Hyaluronate": "Hyaluronic Acid",
    "Sodium Hyaluronate;": "Hyaluronic Acid",
    "Sodium Cocoyl Isethionate": "Coco-Glucoside",
    "Poloxamer 184": "Micelle",
    "Ascorbyl Glucoside": "Vitamin C",
    "Ethyl Ascorbic Acid": "Vitamin C",
    "Cetearyl Alcohol": "Fatty Alcohol",
    "Tocopherol": "Vitamin E",
    "Panthenol": "Pro-Vitamin B5",
    "Niacinamide": "Niacinamide",
    "Glycerin": "Glycerin",
    "Aqua": "Water",
    "Perfume": "Fragrance",
    "Parfum": "Fragrance",
  };

  return known[name.trim()] ?? name.trim();
}
