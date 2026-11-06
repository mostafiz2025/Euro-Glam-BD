/**
 * Existence checks that are safe to run on the Edge.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The product detail page renders its body inside a `<Suspense>`
 * boundary, so the shell is sent to the browser *before* the product
 * is read. When the product turns out not to exist, `notFound()` throws
 * and the not-found UI renders in place of the streamed content — but
 * the response has already started, so the status stays `200`.
 *
 * Next.js documents this behaviour precisely:
 *
 *   "The response starts streaming from the `<Suspense>` boundary before
 *   `notFound()` runs, so it keeps its `200` status. Next.js adds a
 *   `noindex` tag."
 *
 * The `noindex` tag protects the search ranking. It does not protect
 * the **status code**, and a 200 for a missing product is wrong in two
 * ways: a monitoring dashboard counts it as a success, and a crawler
 * that ignores `noindex` sees a "page" at a URL that does not exist.
 *
 * The documented fix is to run the existence check *before* streaming
 * starts — in the proxy.
 *
 * ── Why it uses `fetch`, not Prisma ───────────────────────────────────────
 *
 * The proxy runs on the **Edge runtime**. Prisma's client is a Node.js
 * library: it needs `node:fs`, `node:net` and a TCP socket, none of
 * which exist on the Edge. Importing it here would fail at build time.
 *
 * So this module asks the API over HTTP. That is a real round-trip, and
 * it is the honest trade for a check that runs on every product request.
 * It is mitigated in three ways:
 *
 *   1. The check is **skipped** for anything that is not a product
 *      page, so it costs nothing on the home page, the listing, the
 *      APIs or the static assets.
 *   2. A failed check **does not block the request**. A database
 *      blip must not turn every product page into a 404 — that is a
 *      far worse outcome than a 200 for a missing product. The check
 *      answers "does it exist?" only when it can answer confidently.
 *   3. The page's own `notFound()` remains the authority. This check
 *      is a fast path that produces the right status code; the page
 *      is what actually decides whether the product is there.
 */

/**
 * The API's base URL.
 *
 * ── The order of preference ──────────────────────────────────────────────
 *
 * 1. `INTERNAL_API_URL` — an explicit override, for a deployment where
 *    the API lives behind a different address than the storefront.
 * 2. **The request's own origin.** This is the correct default, and it
 *    is what almost every deployment should use.
 * 3. `HOSTNAME` — the platform's own hostname.
 * 4. `http://localhost:3000` — the last resort, for a bare local run.
 *
 * ── Why the request's own origin comes first ──────────────────────────────
 *
 * The previous fallback was `http://localhost:3000`. That is correct
 * only when the app happens to be on port 3000 — and it is *silently*
 * wrong otherwise. A deployment on port 8080, or a `next start -p
 * 3100`, gets a proxy that fetches from a **different server**: the
 * check times out, returns "do not know", and every missing product
 * page answers `200` instead of `404`. The failure is invisible, which
 * is the worst kind.
 *
 * The request already knows its own address — the host and port the
 * customer typed. Using it means the self-reference can never point at
 * the wrong server.
 */
function apiBaseUrl(requestOrigin?: string): string {
  const explicit = process.env.INTERNAL_API_URL?.trim();

  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  if (requestOrigin) {
    return requestOrigin.replace(/\/+$/, "");
  }

  const host = process.env.HOSTNAME?.trim();

  if (host) {
    return `http://${host}`;
  }

  return "http://localhost:3000";
}

/**
 * The pattern that identifies a product detail path.
 *
 * `/products/<id>` — exactly one segment after `/products`. The
 * listing page is `/products` on its own, and `/products?…` carries a
 * query string rather than a path segment, so neither matches.
 */
const PRODUCT_PATH = /^\/products\/([^/]+)$/;

/**
 * The pattern that identifies an order detail path.
 */
const ORDER_PATH = /^\/orders\/([^/]+)$/;

/**
 * Decodes a path segment, tolerating a malformed escape sequence.
 *
 * ── Why this cannot just be `decodeURIComponent` ─────────────────────────
 *
 * `decodeURIComponent` **throws** a `URIError` when the segment contains
 * a percent sign that is not followed by two hex digits — `%`, `%zz`,
 * `%E0%A4`. Those are perfectly valid things for a browser to send, and
 * they arrive at the proxy on every request, because the proxy matches
 * the *pathname* and never touches the database for a bad segment.
 *
 * An uncaught `URIError` in the proxy is a **500**: the request dies
 * before the page renders. So a URL like `/products/%` — a mistyped
 * link, a crawler probing for escaping, a truncated bookmark — took the
 * whole route down instead of showing a not-found page.
 *
 * A malformed segment is not a product id. It is not an order id. It is
 * simply not a page we recognise, so the honest answer is `null` — the
 * same answer the function already returns for a path that does not
 * match at all. The caller's behaviour is then unchanged: no
 * existence check is attempted, and the page renders its own
 * not-found UI.
 *
 * The `try` is deliberately narrow: it wraps the decode and nothing
 * else, so a genuine bug elsewhere in the function still throws.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment).trim();
  } catch {
    // A malformed percent-escape. Not a page we know how to handle.
    return null;
  }
}

/**
 * Extracts the product id from a pathname, if it is a product page.
 */
export function productIdFromPath(pathname: string): string | null {
  const match = PRODUCT_PATH.exec(pathname);

  if (!match) {
    return null;
  }

  const id = decodeSegment(match[1]);

  if (id === null || id.length === 0) {
    return null;
  }

  return id;
}

/**
 * Extracts the order id from a pathname, if it is an order page.
 */
export function orderIdFromPath(pathname: string): string | null {
  const match = ORDER_PATH.exec(pathname);

  if (!match) {
    return null;
  }

  const id = decodeSegment(match[1]);

  if (id === null || id.length === 0) {
    return null;
  }

  return id;
}

/**
 * Returns true when the product exists.
 *
 * Returns `null` — meaning "do not know" — when the check could not be
 * completed. The caller must treat `null` as "do not block the
 * request". Only a confident `false` produces a 404.
 */
export async function productExists(
  id: string,
  requestOrigin?: string,
): Promise<boolean | null> {
  return exists(
    `${apiBaseUrl(requestOrigin)}/api/products/${encodeURIComponent(id)}`,
  );
}

/**
 * Returns true when the order exists **and belongs to the caller**.
 *
 * The check goes through the API, which is scoped by the caller's
 * session. An order belonging to someone else is indistinguishable
 * from one that does not exist — which is the correct behaviour, and
 * the reason this cannot be a database lookup.
 *
 * Returns `null` — "do not know" — when the check could not be
 * completed. A signed-out visitor is one of those cases: the API
 * answers `401`, which is not evidence of absence.
 */
export async function orderExists(
  id: string,
  requestOrigin?: string,
  cookie?: string,
): Promise<boolean | null> {
  const headers: Record<string, string> = { accept: "application/json" };

  if (cookie) {
    headers.cookie = cookie;
  }

  return exists(
    `${apiBaseUrl(requestOrigin)}/api/orders/${encodeURIComponent(id)}`,
    headers,
  );
}

/**
 * Asks the API whether a resource exists.
 *
 * The shared body of `productExists` and `orderExists`.
 */
async function exists(
  url: string,
  headers: Record<string, string> = { accept: "application/json" },
): Promise<boolean | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      // A short timeout: this check is on the critical path of every
      // product page view, and a slow answer is worse than no answer.
      signal: AbortSignal.timeout(2500),
      headers,
      cache: "no-store",
    });

    if (response.status === 404) {
      return false;
    }

    if (response.status === 401 || response.status === 403) {
      // The caller is not authorised to see this resource. That is not
      // the same as "it does not exist" — for a signed-out visitor it
      // means nothing at all.
      return null;
    }

    if (!response.ok) {
      // The API could not answer. That is not evidence of absence.
      return null;
    }

    const payload: unknown = await response.json();

    if (
      typeof payload === "object" &&
      payload !== null &&
      "ok" in payload &&
      (payload as { ok: unknown }).ok === false
    ) {
      return false;
    }

    return true;
  } catch {
    // A network failure, a timeout, a DNS error — all of them mean
    // "do not know", never "does not exist".
    return null;
  }
}
