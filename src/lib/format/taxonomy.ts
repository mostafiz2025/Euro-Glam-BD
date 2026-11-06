/**
 * Storefront taxonomy — the category icons and the shop-by groupings.
 *
 * ── Why some of this is static, and some is not ──────────────────────────
 *
 * The **categories, concerns and brands** come from the database
 * (`Category`, `SkinConcern`, `Brand`), because they are data the admin
 * maintains. A concern the admin adds has to appear in the storefront
 * without a code change.
 *
 * The **icons** are static, and that is a deliberate split. A category's
 * icon is a presentation concern, not a catalogue fact, and putting an
 * SVG key on a database row means every category the admin creates
 * needs a matching entry in this file before it can render — the
 * storefront would show a blank tile for a category that exists
 * perfectly well in the database.
 *
 * So the rule is: **a category with no icon entry still renders**, with
 * a neutral fallback tile. The icon table is an enhancement, never a
 * gate. And when the admin uploads a card image, the image outranks the
 * icon — but the icon stays as the fallback.
 *
 * ── What was retired here ────────────────────────────────────────────────
 *
 * This file used to hold `BRANDS` and `CONCERNS` as static arrays. Both
 * were **retired, not kept in parallel** — two lists drift, and the
 * drifted one is the one the storefront shows. The brand registry
 * (`KNOWN_BRANDS` in `src/lib/format/brand.ts`) **stays**: it is the
 * canonicalisation vocabulary the product path validates against, and it
 * is the seed's source. The `Brand` table is seeded from it.
 */

/**
 * The icon key for a category.
 */
export type CategoryIconKey =
  | "cleanser"
  | "serum"
  | "moisturiser"
  | "sunscreen"
  | "makeup"
  | "lipstick"
  | "baby"
  | "hair";

/**
 * The category icon table.
 *
 * Keyed by the category **slug** — the same slug the API filters by.
 */
export const CATEGORY_ICONS: Readonly<
  Record<string, { readonly icon: CategoryIconKey; readonly label: string }>
> = {
  "cleansers": { icon: "cleanser", label: "Cleansers" },
  "serums": { icon: "serum", label: "Serums" },
  "moisturisers": { icon: "moisturiser", label: "Moisturisers" },
  "sunscreens": { icon: "sunscreen", label: "Sunscreens" },
  "makeup": { icon: "makeup", label: "Makeup" },
  "lipsticks": { icon: "lipstick", label: "Lipsticks" },
  "baby-care": { icon: "baby", label: "Baby Care" },
  "hair-care": { icon: "hair", label: "Hair Care" },
};

/**
 * The fallback tile for a category with no icon entry.
 *
 * Used so a category the admin adds after this file was written still
 * appears in the grid.
 */
export const CATEGORY_FALLBACK = {
  icon: "serum" as CategoryIconKey,
  label: "More",
};

/**
 * The "shop by" groupings shown on the home page.
 *
 * These are editorial groupings over the category list — a way in, not a
 * replacement for the full category list. Each one links to a real
 * filtered view.
 */
export type ShopByGroup = {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly href: string;
  readonly categorySlug?: string;
  readonly search?: string;
};

export const SHOP_BY: readonly ShopByGroup[] = [
  {
    id: "concerns",
    title: "By Skin Concern",
    subtitle: "Targeted actives",
    href: "/products?view=concerns",
  },
  {
    id: "serums",
    title: "Serums",
    subtitle: "Actives & treatments",
    href: "/products?category=serums",
    categorySlug: "serums",
  },
  {
    id: "makeup",
    title: "Makeup",
    subtitle: "Lips, base & brow",
    href: "/products?category=makeup",
    categorySlug: "makeup",
  },
  {
    id: "sunscreen",
    title: "Sunscreen",
    subtitle: "UV defence",
    href: "/products?category=sunscreens",
    categorySlug: "sunscreens",
  },
  {
    id: "baby",
    title: "Baby Care",
    subtitle: "Gentle & tear-free",
    href: "/products?category=baby-care",
    categorySlug: "baby-care",
  },
  {
    id: "brands",
    title: "By Brand",
    subtitle: "European labels",
    href: "/products?view=brands",
  },
];

/**
 * The price bands offered in the filter panel.
 *
 * **These are in poisha, not taka.** 1 BDT = 100 poisha, so ৳500 is
 * `50000`. The values are converted to the query parameters by
 * `priceBandToQuery` in the products page.
 */
export type PriceBand = {
  readonly id: string;
  readonly label: string;
  readonly minPaisa: number | null;
  readonly maxPaisa: number | null;
};

export const PRICE_BANDS: readonly PriceBand[] = [
  { id: "under-1000", label: "Under ৳1,000", minPaisa: null, maxPaisa: 100000 },
  { id: "1000-2500", label: "৳1,000 – ৳2,500", minPaisa: 100000, maxPaisa: 250000 },
  { id: "2500-4000", label: "৳2,500 – ৳4,000", minPaisa: 250000, maxPaisa: 400000 },
  { id: "over-4000", label: "Above ৳4,000", minPaisa: 400000, maxPaisa: null },
];
