import { notFound } from "next/navigation";

/**
 * The order-not-found route.
 *
 * ── Why this route exists ─────────────────────────────────────────────────
 *
 * The order page renders its body inside a `<Suspense>` boundary, so
 * the shell is sent to the browser *before* the order is read. When
 * the order turns out not to exist, `notFound()` throws — but the
 * response has already started, so the status stays `200`. Next.js
 * documents this exactly:
 *
 *   "The response starts streaming from the `<Suspense>` boundary before
 *   `notFound()` runs, so it keeps its `200` status."
 *
 * The `noindex` tag Next.js adds protects the search ranking, but a
 * `200` for a missing order is still wrong: a monitoring dashboard
 * counts it as a success, and a crawler that ignores `noindex` sees a
 * page at a URL that does not exist.
 *
 * So the proxy checks the order's existence *before* the page renders,
 * and rewrites a missing order to this route. The rewrite keeps the
 * customer's URL (`/orders/abc`) while this route answers with a real
 * `404` and the branded not-found screen.
 *
 * The route is deliberately **not** under `/orders/[id]` — a rewrite to
 * a dynamic segment would re-enter the order lookup. A flat path has
 * no lookup to re-enter.
 *
 * ── Why this route calls `notFound()` ─────────────────────────────────────
 *
 * The subtle part, and the easy thing to get wrong.
 *
 * `NextResponse.rewrite(url, { status: 404 })` sets the status on the
 * *rewrite*. But when the target route is prerendered, the framework
 * serves the cached static shell and **discards the status**:
 *
 *   x-middleware-rewrite: /orders-not-found
 *   x-nextjs-prerender: 1
 *   x-nextjs-cache: HIT
 *   → 200 OK
 *
 * The rewrite happened; the `404` did not. The response was a `200` for
 * an order that does not exist — precisely the bug this route was
 * built to fix. Making the route dynamic is not enough on its own
 * either: the prerendered *shell* is still served.
 *
 * The reliable mechanism is Next.js's own. Calling `notFound()` from
 * the route raises the framework's not-found error, and the framework
 * renders the nearest `not-found.tsx` boundary and sets the status to
 * `404` — the same code path that produces a correct 404 everywhere
 * else. The status is not something the proxy attaches; it is
 * something the framework decides.
 */

/**
 * The order-not-found page.
 */
export default function OrdersNotFoundPage() {
  // The framework renders the nearest not-found boundary and answers
  // with a genuine 404.
  notFound();
}
