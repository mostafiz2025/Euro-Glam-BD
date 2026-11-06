import { OrderNotFound } from "./order-not-found";

/**
 * The not-found boundary for the order detail page.
 *
 * The markup lives in `order-not-found.tsx`, because the proxy renders
 * the same screen through a different route.
 */
export default function OrderNotFoundBoundary() {
  return <OrderNotFound />;
}
