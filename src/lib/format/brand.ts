/**
 * The brand vocabulary.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * A product's brand is now a **first-class, editable field** — the admin
 * form has a brand picker, and `Product.brand` holds the result. This
 * module is the **vocabulary** that picker offers and that the server
 * validates against.
 *
 * The vocabulary is a **closed list plus a typed escape hatch**:
 *
 *   • A **known brand** from the list below — offered as a suggestion, so
 *     an admin picks rather than types, and so "CeraVe" is always stored
 *     with that exact spelling.
 *   • A **custom brand** — typed freely, for the shop that stocks
 *     something this list has never heard of.
 *
 * Neither alone is enough. A closed list alone cannot hold a brand the
 * code was written before; free text alone would put "cerave", "CeraVe"
 * and "CERAVE" on three products, and the storefront would show all
 * three.
 *
 * ── Why the column is not a foreign key ──────────────────────────────────
 *
 * There is no `Brand` table. A `Brand` table would mean a second admin
 * CRUD (list, create, rename, merge), a join on every product read, and
 * a migration rewriting every seeded row against a new table — for a
 * label with a closed vocabulary.
 *
 * Instead the vocabulary lives here, in the validation layer, and the
 * column is a plain string. The picker and the server read **this**
 * list, so the suggestions an admin sees and the values the server
 * accepts cannot drift apart.
 *
 * ── The one place the list is declared ───────────────────────────────────
 *
 * `KNOWN_BRANDS` below is the **single source of truth**. The home page's
 * brand carousel used to carry its own copy, and the two lists had
 * already drifted — one had "Musta Baby" and the other did not. The
 * carousel now derives its tiles from this list, so there is exactly one
 * place a brand is registered.
 */

/**
 * The brands the shop stocks.
 *
 * **A brand is registered when the shop actually stocks it.** Adding one
 * is a deliberate act: the entry means "this brand exists, offer it in
 * the picker, and accept it from the server".
 *
 * The order is alphabetical, except that "Musta Baby" and "Musta Makeup"
 * sit together — they are the shop's own two lines and are related
 * enough that an admin looking for one will look near the other.
 */
export const KNOWN_BRANDS: readonly string[] = [
  "Bioderma",
  "CeraVe",
  "La Roche-Posay",
  "Maybelline",
  "Musta Baby",
  "Musta Makeup",
  "Neutrogena",
  "The Ordinary",
  "Vichy",
];

/**
 * The maximum length of a brand name.
 *
 * A brand name is a label. 80 characters is more than "La Roche-Posay"
 * and more than any brand a shop would reasonably stock.
 */
export const MAX_BRAND_LENGTH = 80;

/**
 * The registry, sorted longest-first.
 *
 * Computed once at module load rather than on every call — the list is a
 * constant and sorting it per call would be waste on a list page that
 * renders twenty rows.
 *
 * **Longest first matters.** "La Roche-Posay" is 13 characters and "La"
 * is 2 — if "La" were matched first, "La Roche-Posay Effaclar Gel"
 * would be branded "La". Sorting by length descending means the
 * longest registered prefix wins, which is the only ordering that
 * gives the right answer for every entry here.
 */
const BRANDS_BY_LENGTH: readonly string[] = [...KNOWN_BRANDS].sort(
  (a, b) => b.length - a.length,
);

/**
 * The result of splitting a product name.
 */
export type BrandSplit = {
  /** The brand, or `null` when the name does not begin with a known brand. */
  readonly brand: string | null;
  /**
   * The product title — the name with the brand prefix removed.
   *
   * When there is no brand, this is the **whole** name, so a caller can
   * render `title` unconditionally and never show an empty cell.
   */
  readonly title: string;
};

/**
 * Splits a product name into its brand and its title.
 *
 * ── The matching rules ──────────────────────────────────────────────────
 *
 * 1. The name is trimmed and its internal whitespace is collapsed, so
 *    `"CeraVe  Hydrating  Cream"` splits the same way as
 *    `"CeraVe Hydrating Cream"`.
 * 2. The brand must be a **prefix** of the name, followed by
 *    whitespace. A brand that appears in the middle — "Cream by
 *    Bioderma" — is not a brand prefix and is not matched.
 * 3. The match is **case-insensitive**, because a product named
 *    "CERAVE Hydrating Cream" is still a CeraVe product.
 * 4. The **longest** registered prefix wins.
 *
 * ── What this is for now ────────────────────────────────────────────────
 *
 * This was how the brand was found before `Product.brand` existed. It
 * is now the **fallback**: a product whose brand column is null — one
 * written before the column was added, or one the admin never set — can
 * still have its brand derived from its name rather than showing none.
 *
 * @param name - The product's name.
 */
export function splitBrandAndTitle(name: string): BrandSplit {
  const normalized = name.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return { brand: null, title: "" };
  }

  const lower = normalized.toLowerCase();

  for (const brand of BRANDS_BY_LENGTH) {
    const candidate = brand.toLowerCase();

    if (!lower.startsWith(candidate)) continue;

    // The brand must be followed by whitespace — "CeraVe" must not
    // match a product called "Ceramide Cream", and "CeraVe" must not
    // match "CeraVexfoliant".
    const next = normalized[brand.length];

    if (next === undefined || !/\s/.test(next)) continue;

    const title = normalized.slice(brand.length).trim();

    // A name that is *only* the brand has no title to show. Returning
    // the whole name is the honest answer — there is nothing to split.
    if (title.length === 0) {
      return { brand: null, title: normalized };
    }

    return { brand, title };
  }

  return { brand: null, title: normalized };
}

/**
 * The canonical spelling of a brand, or `null` when it is not known.
 *
 * A known brand is folded to the registry's exact entry, so "cerave"
 * and "CeraVe" are one brand and cannot end up on two products as two
 * different strings.
 *
 * A **custom** brand is returned in its trimmed, whitespace-collapsed
 * form — the same shape a registered brand has.
 */
export function canonicalBrand(brand: string): string | null {
  const normalized = brand.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) return null;

  const match = KNOWN_BRANDS.find(
    (known) => known.toLowerCase() === normalized.toLowerCase(),
  );

  return match ?? normalized;
}

/**
 * Whether a brand is one of the registered ones.
 *
 * The comparison is case-insensitive, so an admin who types "best
 * seller"-style lowercase gets the known brand rather than a custom one
 * that happens to look like it.
 */
export function isKnownBrand(brand: string): boolean {
  const normalized = brand.trim().toLowerCase();

  return KNOWN_BRANDS.some((known) => known.toLowerCase() === normalized);
}

/**
 * The brand to show for a product.
 *
 * ── The order ───────────────────────────────────────────────────────────
 *
 * The **stored** brand wins. The derivation is the fallback for a row
 * whose brand column is null — a product written before the column
 * existed, or one an admin never set.
 *
 * So the derived value is never stored over a real one, and a product
 * with a deliberately-set brand keeps it even if its name does not start
 * with that brand.
 */
export function displayBrand(
  storedBrand: string | null | undefined,
  productName: string,
): string | null {
  if (storedBrand !== null && storedBrand !== undefined) {
    const trimmed = storedBrand.trim();

    if (trimmed.length > 0) return trimmed;
  }

  return splitBrandAndTitle(productName).brand;
}
