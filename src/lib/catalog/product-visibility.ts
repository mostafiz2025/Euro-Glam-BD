import type { Prisma } from "@prisma/client";

/**
 * The storefront's product visibility filter.
 *
 * ── What "archived" means ────────────────────────────────────────────────
 *
 * A product with `archivedAt` set is **withdrawn from sale**. It is not
 * deleted — it is hidden. It must not appear:
 *
 *   • in the catalogue grid, or in a search result
 *   • on its own product page
 *   • in the category filter panel, **or in that panel's counts**
 *   • in the related-products rail
 *   • in the AI advisor's recommendations
 *   • in the cart's add-to-cart path
 *   • at checkout
 *   • as the subject of a new review
 *
 * ── Why the helper exists ────────────────────────────────────────────────
 *
 * The filter is one predicate. The **risk** is that it gets applied at
 * nine of the ten places it needs to be, and the tenth is forgotten — and
 * a forgotten filter **sells an archived product**.
 *
 * So the predicate lives here, once, and every storefront query ANDs it
 * in. A new query site that forgets it is a bug, but it is a bug in one
 * file rather than a scattered set of hand-written conditions that
 * drift apart.
 *
 * ── Why it is a plain object and not a function ──────────────────────────
 *
 * It is a constant. It has no inputs. A function would invite a caller
 * to pass arguments, and the one thing this filter must never do is
 * become conditional.
 *
 * ── The count is the subtle one ──────────────────────────────────────────
 *
 * The category filter panel's counts are a **filtered relation count**,
 * not a `where` on the product query. See the note at
 * `src/lib/catalog/service.ts` — a panel that offers "12 products" when
 * only nine are sellable is a filter that lies.
 */

/**
 * The filter that keeps archived products out of a storefront query.
 *
 * AND this into every customer-facing product query.
 */
export const ACTIVE_PRODUCT_WHERE = {
  archivedAt: null,
} satisfies Prisma.ProductWhereInput;

/**
 * The filter, as a `Prisma.ProductWhereInput`.
 *
 * The same object, typed for the places that want the type rather than
 * the literal. It is the *same* object — not a copy — so there is no
 * second definition to drift.
 */
export const activeProductWhere = ACTIVE_PRODUCT_WHERE;
