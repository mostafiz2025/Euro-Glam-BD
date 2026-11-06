import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, verifyToken } from "@/lib/auth/jwt";
import {
  orderExists,
  orderIdFromPath,
  productExists,
  productIdFromPath,
} from "@/lib/catalog/existence";

/**
 * Edge proxy — defence in depth for admin routes.
 *
 * (Next.js 16 renamed the `middleware` file convention to `proxy`. The
 * behaviour and the Edge runtime are unchanged; only the filename and the
 * exported function name differ.)
 *
 * This runs on EVERY request, before the route handler. It is NOT the
 * authorisation decision. The authoritative checks live in
 * `requireAdmin` / `requireUser` (src/lib/auth/guards.ts), which re-read
 * the role from the database.
 *
 * Why have both:
 *
 *  • The proxy rejects a request with no valid token in ~1ms, before
 *    it ever touches the database. An attacker probing /api/admin/* is
 *    rejected at the edge rather than after a DB round-trip.
 *
 *  • The guard re-reads the role, so a token minted while the user was an
 *    admin cannot grant admin access for the next seven days after they
 *    are demoted. The proxy alone would be vulnerable to that, because
 *    the role claim lives in the token.
 *
 * In short: the proxy is a fast filter, the guard is the authority.
 * Never rely on the proxy alone.
 */

/**
 * Public paths that must never require a session.
 *
 * These are matched as prefixes. `/api/auth` covers login, register and
 * logout.
 *
 * The two OTP paths are public **by necessity**, not by convenience: they
 * are the sign-in path for a customer who has no session yet. Requiring a
 * session to obtain a session would make the flow impossible.
 *
 * They are protected by something else entirely — the mailed code, which
 * is attempt-limited, single-use and expires. See `src/lib/auth/otp.ts`.
 */
const PUBLIC_PATHS = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
  "/api/auth/send-otp",
  "/api/auth/verify-otp",
  "/api/health",
];

/**
 * Admin-only path prefixes.
 *
 * Both the API and the **pages** are protected, but they are answered
 * differently — an API route gets a JSON error envelope, and a page
 * gets a redirect. So the two prefixes are kept apart in
 * `isAdminApiPath` and `isAdminPagePath` rather than being swept
 * through one list.
 *
 * The pages matter as much as the API. A proxy that rejects
 * `/api/admin/*` but lets `/admin/*` through is a proxy that stops a
 * customer's *request* for data while still letting them *render* the
 * dashboard shell. The layout in `src/app/admin/layout.tsx` is the
 * authoritative gate — it re-reads the role from the database — but the
 * proxy should still reject an obvious mistake before it reaches the
 * database, which is the whole job of a fast filter.
 */
const ADMIN_API_PREFIX = "/api/admin";
const ADMIN_PAGE_PREFIX = "/admin";

/**
 * The API path prefixes that a signed-out visitor may still call.
 *
 * ── Why this list exists ─────────────────────────────────────────────────
 *
 * The proxy originally guarded *every* path, because the application
 * was API-only. That was correct then. It is wrong now.
 *
 * The storefront is public: a customer must be able to browse the
 * catalogue, read a product page and see the reviews **without an
 * account**. A shop that shows a 401 to an anonymous visitor is not a
 * shop.
 *
 * So the session requirement is narrowed to the endpoints that genuinely
 * mutate private state — the cart, the orders and the advisor. Those
 * all have their own authoritative guard (`requireUser`) in the route
 * handler, which re-reads the user from the database. The proxy remains
 * what it has always been: a **fast filter** that rejects an obvious
 * mistake before it reaches the database, not the authorisation
 * decision.
 */
const PUBLIC_API_PREFIXES = [
  "/api/products",
  "/api/categories",
  /*
   * The guest order-tracking endpoint.
   *
   * It is public by necessity, not by convenience: the customer who most
   * needs to know where their parcel is — the one who ordered as a guest,
   * or who never made an account — is by definition not signed in. A
   * session requirement would make the endpoint answer only to the
   * customers who do not need it.
   *
   * It is protected by something else entirely: the **contact detail**.
   * The caller must supply the email address or the phone number that is
   * on the order, and the service compares it against the order's own
   * values. That is a secret the customer holds and an attacker does
   * not, and the endpoint counts its attempts from the database so a
   * guess is expensive.
   *
   * The prefix matches the whole subtree. Nothing else lives under
   * `/api/order-tracking` today, and if a write were ever placed there
   * it would need a carve-out in `PUBLIC_API_PATTERNS` — exactly as the
   * review submission did.
   */
  "/api/order-tracking",
];

/**
 * Public API paths that are read-only.
 *
 * ── Why the prefix list is not enough ─────────────────────────────────────
 *
 * `PUBLIC_API_PREFIXES` matches by *prefix*, so `/api/products` also
 * covers `/api/products/{id}/reviews` — and that route is a **write**.
 *
 * A prefix is the right tool for a whole subtree of read-only endpoints,
 * but it is the wrong tool for a subtree that mixes reads and writes. The
 * prefix list is kept for the genuinely read-only trees, and this list
 * carves out the paths inside them that mutate state.
 *
 * The proxy is a fast filter, not the authority — `requireCustomer()` in
 * the route handler is what actually rejects an anonymous submission. But
 * the filter's whole job is to reject an obvious mistake *before* it
 * reaches the database, and a blanket public prefix for a tree that
 * contains a write defeats that. The review submission is the first
 * mutating endpoint to live under a public prefix, so the carve-out is
 * made here rather than left to be discovered later.
 *
 * The patterns carry a `:param` segment, because the concrete path at
 * runtime has a real product id in it — `/api/products/abc123/reviews`.
 * A literal `[id]` would never match anything, and the carve-out would
 * silently do nothing, which is the worst possible failure for a
 * security control: it looks like it is working.
 *
 * The pattern covers the whole `reviews` **subtree**, not just the
 * exact path. `/api/products/{id}/reviews/{reviewId}` is a different
 * endpoint — a read of one review, or a write to it — and it lives
 * under the same public prefix. Anchoring the pattern to the exact
 * path would leave the subtree's other endpoints swept in by the
 * prefix, which is the bug this carve-out exists to prevent.
 */
const PUBLIC_API_PATTERNS = [
  /^\/api\/products\/[^/]+\/reviews(\/|$)/,
];

/**
 * Returns true when the path is explicitly public.
 *
 * Exported so the routing decision can be unit-tested without spinning
 * up a request — the same reason `isAdminApiPath` is exported.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Returns true when the path is an admin **API** route.
 *
 * The two are separated because they are answered differently: an API
 * route gets a JSON error envelope, and a page gets a redirect.
 */

/**
 * Returns true when the path is a storefront page rather than an API
 * route.
 *
 * A page renders HTML. It is never a JSON error envelope, so the
 * proxy's job — rejecting a request that is not allowed to proceed —
 * does not apply to it. Pages carry their own access rules: the
 * account page redirects to a sign-in, the admin pages are not part of
 * the storefront at all.
 */
function isPagePath(pathname: string): boolean {
  return !pathname.startsWith("/api/");
}

/**
 * Returns true when the path is an API route a signed-out visitor may
 * call.
 *
 * The carve-out list is checked **first**: a path that sits inside a
 * public prefix but is explicitly listed as a write is *not* public,
 * even though the prefix matched. Checking the prefix first would make
 * the carve-out unreachable, and the carve-out is the whole point.
 */
export function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return false;
  }

  return PUBLIC_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Returns true when the path is an admin **API** route.
 *
 * Exported so the routing decision can be unit-tested without spinning
 * up a request.
 */
export function isAdminApiPath(pathname: string): boolean {
  return (
    pathname === ADMIN_API_PREFIX || pathname.startsWith(`${ADMIN_API_PREFIX}/`)
  );
}

/**
 * Returns true when the path is an admin **page** route.
 *
 * Exported for the same reason as `isAdminApiPath`.
 *
 * The prefix match is anchored to a **path segment**. `/administrator`
 * is a different path from `/admin`, and treating it as the dashboard
 * would lock a page that has nothing to do with administration.
 */
export function isAdminPagePath(pathname: string): boolean {
  return (
    pathname === ADMIN_PAGE_PREFIX || pathname.startsWith(`${ADMIN_PAGE_PREFIX}/`)
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // ── The admin pages ────────────────────────────────────────────────────
  //
  // An admin **page** is checked here, before the storefront branch
  // below would let every page through.
  //
  // The check is deliberately narrow: the proxy verifies that a *token
  // exists* and that its role claim says ADMIN. It does **not** re-read
  // the role from the database — that is the layout's job, and it is the
  // authoritative check. The proxy's contribution is to turn an obvious
  // mistake into an immediate redirect, before the request reaches the
  // server component tree.
  //
  // So there are three answers:
  //
  //   • No token at all → the sign-in page, with the destination kept
  //     so the admin lands where they were headed.
  //   • A token that is not an admin → the "that area is for staff"
  //     page. A raw 403 would be a dead end with no way out; a page
  //     that explains and offers a way back is not.
  //   • An admin token → straight through, to the layout, which does
  //     the real check.
  if (isAdminPagePath(pathname)) {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const claims = await verifyToken(token);

    if (!claims) {
      const url = request.nextUrl.clone();

      url.pathname = "/login";
      url.search = `?next=${encodeURIComponent(pathname)}`;

      return NextResponse.redirect(url);
    }

    if (claims.role !== "ADMIN") {
      const url = request.nextUrl.clone();

      url.pathname = "/forbidden";
      url.search = "";

      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  }

  // A storefront page is public. The page itself decides what to do
  // with a signed-out visitor; the proxy does not lock the shop.
  if (isPagePath(pathname)) {
    // A product page that does not exist must answer with a real 404.
    //
    // The page body streams behind a `<Suspense>` boundary, so by the
    // time the product turns out to be missing the response has
    // already started — and Next.js documents that the status stays
    // `200` in that case. The not-found UI still renders, and a
    // `noindex` tag is added, but the status code is wrong.
    //
    // The documented remedy is to make the check *before* streaming
    // starts. That is what this is.
    //
    // A `null` result means "could not tell" — a database blip, a
    // timeout. It must **not** produce a 404: turning every product
    // page into a 404 because the catalogue was briefly unreachable
    // is a far worse failure than the one being fixed.
    const productId = productIdFromPath(pathname);

    if (productId !== null) {
      // The request's own origin is passed so the self-reference cannot
      // point at a different server — a hardcoded `localhost:3000` is
      // wrong on every port except 3000, and the failure is silent.
      const exists = await productExists(productId, request.nextUrl.origin);

      if (exists === false) {
        // The product is gone. The request is **rewritten** to the
        // not-found route rather than answered with a bare 404, so
        // the customer gets the branded "we could not find that"
        // screen instead of an empty response.
        //
        // The rewrite keeps the original URL — the customer still
        // sees `/products/missing-thing` — and the not-found route
        // sets the status to 404.
        const url = request.nextUrl.clone();

        url.pathname = "/products-not-found";

        return NextResponse.rewrite(url, { status: 404 });
      }
    }

    // An order that does not exist — or belongs to someone else — must
    // answer with a real 404, for the same reason.
    //
    // The check runs through the API, which is scoped by the caller's
    // session. A signed-out visitor is answered `401`, which the check
    // reads as "do not know" — the order page itself offers them a
    // sign-in, and that is the right response for someone who may well
    // be the owner.
    const orderId = orderIdFromPath(pathname);

    if (orderId !== null) {
      const exists = await orderExists(
        orderId,
        request.nextUrl.origin,
        request.headers.get("cookie") ?? undefined,
      );

      if (exists === false) {
        const url = request.nextUrl.clone();

        url.pathname = "/orders-not-found";

        return NextResponse.rewrite(url, { status: 404 });
      }
    }

    return NextResponse.next();
  }

  // A read-only catalogue endpoint is public too — the product list and
  // the category list are what the storefront is built on.
  if (isPublicApiPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const claims = await verifyToken(token);

  if (!claims) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAUTHENTICATED",
          message: "You must be signed in to do that.",
        },
      },
      { status: 401 },
    );
  }

  if (isAdminApiPath(pathname) && claims.role !== "ADMIN") {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "This action requires administrator access.",
        },
      },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Match every path except Next.js internals and static assets.
   *
   * `matcher` runs at the Edge, so the check must be cheap — it is a
   * single HMAC verification, no database access.
   */
  matcher: [
    /*
     * All request paths except:
     *  - _next/static  (build output)
     *  - _next/image   (image optimiser)
     *  - favicon.ico, and common static files
     *  - uploads/*     (user media served from the public directory)
     */
    "/((?!_next/static|_next/image|favicon.ico|uploads/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
