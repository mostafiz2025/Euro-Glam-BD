import { ProductNotFound } from "./product-not-found";

/**
 * The not-found page for a product.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * A product that does not exist must not render as a blank product
 * page. A blank page is indistinguishable from a broken site; a page
 * that says "we could not find that" and offers a way forward is a
 * page that does its job.
 *
 * It also covers the case where a product existed when the link was
 * shared and has since been removed from the catalogue — a normal
 * thing for a shop, and not the customer's fault.
 *
 * The markup lives in `product-not-found.tsx`, because the proxy
 * renders the same screen through a different route.
 */
export default function ProductNotFoundBoundary() {
  return <ProductNotFound />;
}
