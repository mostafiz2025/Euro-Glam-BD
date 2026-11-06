import { ProductNotFound } from "@/app/(storefront)/products/[id]/product-not-found";

/**
 * The not-found boundary for the product-not-found route.
 *
 * The route calls `notFound()` so the framework sets the status to
 * `404` and renders this boundary. The markup is shared with
 * `products/[id]/not-found.tsx` — the customer reads this screen when
 * something has gone wrong, so it must not exist in two places.
 */
export default function ProductsNotFoundBoundary() {
  return <ProductNotFound />;
}
