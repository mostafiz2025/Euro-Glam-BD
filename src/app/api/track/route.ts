import { cookies } from "next/headers";
import { connection } from "next/server";

import { db } from "@/lib/db";
import {
  VISITOR_COOKIE_NAME,
  deriveTrafficEvent,
  generateVisitorId,
} from "@/lib/traffic";

/**
 * POST /api/track
 *
 * The traffic beacon.
 *
 * ── Why this route is public ──────────────────────────────────────────────
 *
 * It is storefront traffic, not admin traffic. A customer's browser
 * posts to it; requiring a session would mean recording only
 * signed-in customers' visits, which would bias the breakdown toward
 * the people who already have accounts.
 *
 * It is deliberately **not** behind `requireAdmin()`. The admin guard
 * would reject every caller.
 *
 * ── What it does not accept ──────────────────────────────────────────────
 *
 * The request body carries only what the browser already knows about
 * the visit: a path, a referrer, and the UTM parameters. There is no
 * field for an IP address, a user agent, or a user id, because the
 * collector does not want them and the route will not accept them.
 *
 * The referrer is reduced to its **host** before it reaches the
 * database, so a campaign parameter or a session token in a query
 * string never lands in the traffic log.
 *
 * ── The write is best-effort ──────────────────────────────────────────────
 *
 * An analytics failure must never break a customer's page. So every
 * failure path here returns a success. A dropped analytics event is a
 * missing number; a 500 on the storefront is a broken shop. The second
 * is far worse than the first.
 *
 * The route still returns the visitor id when it sets a new cookie, so
 * the browser can keep using the same id.
 */

/**
 * The body the beacon sends.
 */
type TrackPayload = {
  readonly path?: unknown;
  readonly referrer?: unknown;
  readonly utmSource?: unknown;
};

/**
 * Reads a string field from the body, if it is a string.
 *
 * A field that is not a string is treated as absent. It is never
 * coerced — a number or an object in `path` is a client bug, and
 * coercing it would put a strange value in the database.
 */
function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

export async function POST(request: Request): Promise<Response> {
  // `connection()` MUST be called outside the try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  let visitorId: string | null = null;
  let setCookie: string | null = null;

  try {
    const jar = await cookies();

    // The visitor's id, from the first-party cookie. A visitor need
    // not be signed in — this is not the user id, and it is not
    // derived from anything about the visitor.
    const existing = jar.get(VISITOR_COOKIE_NAME)?.value;

    if (existing && /^[a-f0-9]{32}$/.test(existing)) {
      visitorId = existing;
    }

    if (!visitorId) {
      visitorId = generateVisitorId();

      // A year-long, first-party cookie. `SameSite=Lax` so it is not
      // attached to cross-site requests; `Secure` in production so it
      // is never sent over plain HTTP.
      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

      setCookie = `${VISITOR_COOKIE_NAME}=${visitorId}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    }

    const body = (await request.json().catch(() => ({}))) as TrackPayload;

    const event = {
      path: readString(body.path) ?? "/",
      referrer: readString(body.referrer),
      utmSource: readString(body.utmSource),
      visitorId,
    };

    const derived = deriveTrafficEvent(event);

    // Fire-and-forget. A failure here must not fail the request.
    await db.trafficEvent.create({
      data: {
        id: crypto.randomUUID(),
        source: derived.source,
        referrerHost: derived.referrerHost,
        path: derived.path,
        visitorId: event.visitorId,
      },
    }).catch((error: unknown) => {
      console.error("[track] Traffic event was not recorded:", error);
    });
  } catch (error) {
    // Even a failure to read the body is swallowed. The beacon is
    // best-effort by design.
    console.error("[track] Traffic beacon failed:", error);
  }

  const headers = new Headers({
    "Cache-Control": "no-store",
  });

  if (setCookie) {
    headers.set("Set-Cookie", setCookie);
  }

  // Always a 202. The route never rejects a caller.
  return new Response(null, { status: 202, headers });
}
