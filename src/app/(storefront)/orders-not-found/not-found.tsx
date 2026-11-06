import { OrderNotFound } from "@/app/(storefront)/orders/[id]/order-not-found";

/**
 * The not-found boundary for the order-not-found route.
 *
 * The route calls `notFound()` so the framework sets the status to
 * `404` and renders this boundary. The markup is shared with
 * `orders/[id]/not-found.tsx` — the customer reads this screen when
 * something has gone wrong, so it must not exist in two places.
 */
export default function OrdersNotFoundBoundary() {
  return <OrderNotFound />;
}
