/**
 * The promotional badge vocabulary.
 *
 * ── Why a closed set of known badges, plus free text ─────────────────────
 *
 * A product used to carry two hardcoded booleans: `isNewArrival` and
 * `isBestSeller`. Two checkboxes answer two questions, and a shop that
 * wants a "Limited Edition" badge or a seasonal "Eid Special" badge has
 * nowhere to put it — so it ends up in the product **description**, where
 * it is invisible to the catalogue, unsearchable, and impossible to
 * filter by.
 *
 * So a product now carries a **list of badges**. The list holds any of:
 *
 *   • A **known badge** from the closed set below — offered as a
 *     checkbox, so an admin picks rather than types.
 *   • A **custom tag** — typed freely, for the one-off campaign badge
 *     that a closed set cannot anticipate.
 *
 * The closed set is what makes the checkboxes useful; the free text is
 * what makes the feature complete. Neither alone is enough: a closed
 * set alone cannot hold "Eid Special 2026", and free text alone puts a
 * "typo" badge on the storefront forever.
 *
 * ── Why the two legacy booleans stay ─────────────────────────────────────
 *
 * `Product.isNewArrival` and `Product.isBestSeller` are read by the
 * storefront — the product card and the product page render them as
 * "New" and "Best Seller" badges. They are the **derived** form of two
 * entries in the badge list, and the service keeps them in sync with
 * the list on every write.
 *
 * So the columns are not a second source of truth — they are a mirror
 * of one. An admin checks "New Arrival" in the badge editor and the
 * storefront lights up, without the storefront having to learn about
 * the badge list at all.
 */

/**
 * The badges the admin form offers as checkboxes.
 *
 * **A closed set.** Each one has exactly one meaning, and the label is
 * what the customer reads on the storefront. Adding a badge is a
 * deliberate act, because every badge in this list will appear on a
 * product card.
 */
export const KNOWN_BADGES = [
  "New Arrival",
  "Best Seller",
  "Discount Offer",
  "Limited Edition",
] as const;

/**
 * One of the known badges.
 */
export type KnownBadge = (typeof KNOWN_BADGES)[number];

/**
 * The badge that marks a product as a new arrival.
 *
 * The name matches the badge label exactly, so the mapping between the
 * list and the column is a lookup rather than a translation table.
 */
export const NEW_ARRIVAL_BADGE = "New Arrival";

/**
 * The badge that marks a product as a best seller.
 */
export const BEST_SELLER_BADGE = "Best Seller";

/**
 * The badge that marks a product as discounted.
 *
 * **Derived, not stored.** Whether a product is discounted is a fact
 * about its two prices, and prices change. A badge that says
 * "Discount Offer" on a product whose discount was removed yesterday
 * is a lie the storefront would tell — so the badge is computed from
 * the prices at render time, and a product may not carry it in its
 * stored list.
 */
export const DISCOUNT_BADGE = "Discount Offer";

/**
 * Whether a badge is one of the known ones.
 *
 * The comparison is case-insensitive, so an admin who types "best
 * seller" gets the known badge rather than a custom tag that happens
 * to look like it.
 */
export function isKnownBadge(badge: string): badge is KnownBadge {
  const normalized = badge.trim().toLowerCase();

  return KNOWN_BADGES.some((known) => known.toLowerCase() === normalized);
}

/**
 * The known badge matching a string, in its canonical form.
 *
 * Returns `null` for a badge that is not known. The canonical form is
 * the entry from `KNOWN_BADGES` — so "best seller" becomes
 * "Best Seller" — which is what stops the same badge being stored
 * twice under two spellings.
 */
export function canonicalBadge(badge: string): KnownBadge | null {
  const normalized = badge.trim().toLowerCase();

  const match = KNOWN_BADGES.find(
    (known) => known.toLowerCase() === normalized,
  );

  return match ?? null;
}
