/**
 * Where a signed-in user is sent.
 *
 * ── Why this is a module and not inline in the form ──────────────────────
 *
 * The rule is small but it is not obvious, and a rule that is not
 * obvious is a rule that gets broken the moment somebody edits the
 * form. Two things in particular need to be true at the same time:
 *
 *   1. **An admin lands in the console.** An administrator who signs in
 *      belongs at `/admin`. Sending them to the storefront and making
 *      them type the address by hand is a small, silly, entirely
 *      avoidable failure.
 *
 *   2. **A `next` parameter cannot redirect off-site.** The parameter
 *      arrives from the query string, so it is attacker-controlled. It
 *      may only ever be a *relative* path inside this site.
 *
 * Keeping both in one pure function means the guard can be tested
 * without a browser, a server, or a database — and the form just calls
 * it.
 *
 * ── The precedence rule ──────────────────────────────────────────────────
 *
 * **The role wins.** An admin always goes to `/admin`, even when a
 * `next` parameter is present. The reason is that `next` exists to
 * honour a *customer's* interrupted journey — they were sent to the
 * cart, so they should land in the cart. An admin has no such journey:
 * their interrupted journey is the console. A `next` that points an
 * administrator at the storefront is not a request, it is a leftover.
 *
 * So:
 *
 *   - role `ADMIN`  → `/admin`
 *   - anyone else   → the sanitised `next`, defaulting to `/`
 */

/** The roles the sign-in API can report. */
export type AuthenticatedRole = "ADMIN" | "CUSTOMER" | (string & {});

/** The path an administrator is sent to after signing in. */
export const ADMIN_HOME = "/admin";

/**
 * Sanitises a `next` parameter into a safe in-site path.
 *
 * Rejects anything that is not a same-origin relative path:
 *
 *   - `null` / `""` → `/`
 *   - `https://evil.example` → `/` (absolute URL)
 *   - `//evil.example` → `/` (protocol-relative URL — the browser
 *     would read the host as `evil.example`)
 *   - `javascript:alert(1)` → `/` (a scheme, not a path)
 *   - `/cart` → `/cart` (a genuine relative path)
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  // `//host` is a protocol-relative URL, not a path on this site.
  if (raw.startsWith("//")) return "/";
  // A backslash is treated as a forward slash by some browsers, so
  // `/\evil.example` is as dangerous as `//evil.example`.
  if (raw.startsWith("/\\")) return "/";
  return raw;
}

/**
 * Chooses the destination after a successful sign-in.
 *
 * @param role   The role reported by the sign-in API.
 * @param next   The raw, untrusted `next` query parameter.
 */
export function destinationAfterSignIn(
  role: AuthenticatedRole | null | undefined,
  next: string | null | undefined,
): string {
  if (role === "ADMIN") return ADMIN_HOME;
  return safeNext(next);
}
