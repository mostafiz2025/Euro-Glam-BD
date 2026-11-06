import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The logout route.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * A logout that does not actually end the session is the worst kind of
 * bug in an authentication system, because it *looks* like it works. The
 * user clicks "Sign out", the app navigates to the login page, and
 * everything appears to be fine — while a valid session token is still
 * sitting in the browser, and the next person to use the device is
 * still signed in.
 *
 * So the property under test is the **cookie**, not the navigation. The
 * navigation is the browser's job; the cookie is the server's.
 *
 * Three things must hold:
 *
 *   1. The route clears the cookie, and it clears it with `maxAge: 0`
 *      and the **same attributes** it was set with. A cookie cleared
 *      with different attributes is a *different cookie* to the
 *      browser, and the original survives.
 *   2. The route answers with the standard envelope, so the client
 *      can tell success from failure.
 *   3. The route is a `POST`. A `GET` logout is a logout a prefetcher
 *      or an `<img>` tag can trigger by accident.
 */

/**
 * The recorded cookie writes.
 */
type CookieWrite = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

const cookieWrites: CookieWrite[] = [];

/**
 * A minimal stand-in for the `cookies()` store.
 *
 * `next/headers` cannot be used outside a request scope, so the module
 * is mocked. The mock records every write, which is exactly what the
 * assertions need.
 */
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieWrites.push({ name, value, options });
    },
  }),
}));

/**
 * `connection()` is a Next.js runtime helper that only resolves inside a
 * request scope. In a unit test it must not reject.
 */
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();

  return {
    ...actual,
    connection: async () => undefined,
  };
});

const { POST } = await import("@/app/api/auth/logout/route");

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    cookieWrites.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("clears the session cookie", async () => {
    const response = await POST();

    expect(response.status).toBe(200);

    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0].name).toBe("egb_session");
  });

  it("empties the cookie's value", async () => {
    await POST();

    // The value is emptied *and* the max age is zero. Either alone is
    // enough for a browser; both together are what every browser and
    // every HTTP client in the wild actually honours.
    expect(cookieWrites[0].value).toBe("");
    expect(cookieWrites[0].options.maxAge).toBe(0);
  });

  it("uses the same attributes the cookie was set with", async () => {
    await POST();

    const { options } = cookieWrites[0];

    // A cookie cleared with different attributes is a *different*
    // cookie to the browser, and the original survives. So the
    // httpOnly, sameSite, secure and path attributes must match the
    // ones `setSessionCookie` writes.
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
  });

  it("keeps the cookie HTTP-only", async () => {
    await POST();

    // The cleared cookie must carry httpOnly too, or a client-side
    // script could read the (empty) cookie and, more importantly, a
    // later write of a *different* cookie with the same name could
    // shadow it.
    expect(cookieWrites[0].options.httpOnly).toBe(true);
  });

  it("answers with the standard success envelope", async () => {
    const response = await POST();

    const payload = (await response.json()) as {
      ok: boolean;
      data?: { success?: boolean };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.success).toBe(true);
  });

  it("is idempotent", async () => {
    // Logging out twice must not error. The second call clears a cookie
    // that is already gone, which is a no-op, not a failure.
    const first = await POST();
    const second = await POST();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(cookieWrites).toHaveLength(2);
  });
});
