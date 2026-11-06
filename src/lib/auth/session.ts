import { cookies } from "next/headers";

import { SESSION_COOKIE_NAME, getTtlSeconds } from "./jwt";

/**
 * Session cookie management.
 *
 * The token lives in an HTTP-only cookie so that JavaScript running in the
 * browser can never read it. That is the single most important property
 * here: an XSS bug can then exfiltrate nothing, because the token is
 * unreachable from `document.cookie`.
 *
 * Cookie attributes:
 *   httpOnly  — blocks JavaScript access (XSS resistance)
 *   sameSite  — "lax" blocks cross-site POST/CSRF while still allowing
 *               top-level GET navigation, so a shared link still works
 *   secure    — HTTPS only, enabled in production
 *   path      — "/" so the cookie is sent on every route
 *   maxAge    — matches the JWT's own expiry
 */

/**
 * The attributes used when writing the session cookie.
 */
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

/**
 * Reads the current session token from the request cookies.
 */
export async function getSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * Writes the session cookie.
 *
 * Must be called from a Route Handler or Server Action — `cookies()` is
 * read-only inside a Server Component.
 */
export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, cookieOptions(getTtlSeconds()));
}

/**
 * Removes the session cookie.
 *
 * The attributes must match those used when setting it, or the browser
 * will treat it as a different cookie and leave the original in place.
 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, "", cookieOptions(0));
}

export { SESSION_COOKIE_NAME };
