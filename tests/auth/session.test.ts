import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The session cookie.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * The session cookie is the whole of the customer's authority. It is
 * written in exactly one place — `setSessionCookie` — and every route
 * that signs somebody in goes through it: the password login, the
 * passwordless sign-in code, and the registration verification code.
 *
 * So the properties that matter are all in this one function:
 *
 *   1. **It is HTTP-only.** JavaScript in the browser must never be able
 *      to read the token. This is the property that turns an XSS bug
 *      from "the attacker has the customer's session" into "the attacker
 *      has nothing".
 *
 *   2. **Its life matches the token's life.** The cookie's `maxAge` and
 *      the JWT's `exp` are set from the same number. If the cookie
 *      outlives the token the customer keeps a cookie that no longer
 *      authenticates anything, and the shop has to explain why they are
 *      "signed in" but not signed in.
 *
 *   3. **Its scope is the whole site.** `path: "/"`, because the
 *      customer's session is used on the storefront, the cart and the
 *      account pages alike.
 *
 *   4. **`sameSite` is "lax".** Strict would break the shared-link
 *      case; `none` would open the site to cross-site POSTs.
 *
 *   5. **It is `secure` in production.** In development it is not, or
 *      the cookie would never be sent over plain HTTP.
 *
 * ── Why the cookie is mocked rather than exercised for real ─────────────
 *
 * `next/headers` cannot be used outside a request scope, so the store is
 * mocked and every write is recorded. That is not a compromise here —
 * the attributes are the entire content of this file, and a real cookie
 * jar would tell us nothing about the options that were passed.
 */

/**
 * A recorded cookie write.
 */
type CookieWrite = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

const cookieWrites: CookieWrite[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieWrites.push({ name, value, options });
    },
  }),
}));

const { setSessionCookie, clearSessionCookie, getSessionToken } = await import(
  "@/lib/auth/session"
);

const { SESSION_COOKIE_NAME, DEFAULT_TTL_SECONDS, getTtlSeconds } = await import(
  "@/lib/auth/jwt"
);

describe("the session cookie", () => {
  beforeEach(() => {
    cookieWrites.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("is written under the expected name", async () => {
    await setSessionCookie("a-token");

    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0].name).toBe(SESSION_COOKIE_NAME);
    expect(cookieWrites[0].name).toBe("egb_session");
    expect(cookieWrites[0].value).toBe("a-token");
  });

  it("is HTTP-only", async () => {
    await setSessionCookie("a-token");

    // The single most important property of this cookie. If a script
    // can read it, an XSS bug is a session theft.
    expect(cookieWrites[0].options.httpOnly).toBe(true);
  });

  it("is scoped to the whole site", async () => {
    await setSessionCookie("a-token");

    // The session is used on the storefront, the cart and the account
    // pages. A cookie scoped to a sub-path would be missing from all
    // but one of them.
    expect(cookieWrites[0].options.path).toBe("/");
  });

  it("is same-site lax", async () => {
    await setSessionCookie("a-token");

    // "lax" blocks the cross-site POST that a CSRF attempt needs,
    // while still allowing a top-level GET navigation — so a shared
    // link to a product page still carries the session.
    expect(cookieWrites[0].options.sameSite).toBe("lax");
  });

  it("is secure in production and not secure in development", async () => {
    vi.stubEnv("NODE_ENV", "production");

    try {
      await setSessionCookie("a-token");

      expect(cookieWrites[0].options.secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }

    cookieWrites.length = 0;

    vi.stubEnv("NODE_ENV", "development");

    try {
      await setSessionCookie("a-token");

      // Not secure in development, or the cookie would never be sent
      // over plain HTTP and nothing could be tested.
      expect(cookieWrites[0].options.secure).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("lives exactly as long as the token it carries", async () => {
    await setSessionCookie("a-token");

    /*
     * The cookie and the JWT must expire together.
     *
     * A cookie that outlives its token is a cookie that keeps being
     * sent after it has stopped meaning anything — the customer is
     * "signed in" in the sense that the browser still offers the
     * cookie, and not in the sense that anything accepts it.
     */
    expect(cookieWrites[0].options.maxAge).toBe(getTtlSeconds());
  });

  it("uses the default lifetime when the environment says nothing", async () => {
    const original = process.env.AUTH_JWT_TTL_SECONDS;

    try {
      delete process.env.AUTH_JWT_TTL_SECONDS;

      expect(getTtlSeconds()).toBe(DEFAULT_TTL_SECONDS);

      await setSessionCookie("a-token");

      expect(cookieWrites[0].options.maxAge).toBe(DEFAULT_TTL_SECONDS);
    } finally {
      if (original === undefined) {
        delete process.env.AUTH_JWT_TTL_SECONDS;
      } else {
        process.env.AUTH_JWT_TTL_SECONDS = original;
      }
    }
  });

  it("follows a lifetime configured in the environment", async () => {
    const original = process.env.AUTH_JWT_TTL_SECONDS;

    try {
      process.env.AUTH_JWT_TTL_SECONDS = "3600";

      await setSessionCookie("a-token");

      expect(cookieWrites[0].options.maxAge).toBe(3600);
    } finally {
      if (original === undefined) {
        delete process.env.AUTH_JWT_TTL_SECONDS;
      } else {
        process.env.AUTH_JWT_TTL_SECONDS = original;
      }
    }
  });
});

describe("clearing the session cookie", () => {
  beforeEach(() => {
    cookieWrites.length = 0;
  });

  it("empties the cookie and expires it immediately", async () => {
    await clearSessionCookie();

    expect(cookieWrites[0].value).toBe("");
    expect(cookieWrites[0].options.maxAge).toBe(0);
  });

  it("uses the same attributes the cookie was set with", async () => {
    await setSessionCookie("a-token");
    await clearSessionCookie();

    const written = cookieWrites[0].options;
    const cleared = cookieWrites[1].options;

    /*
     * A cookie cleared with different attributes is a *different
     * cookie* to the browser, and the original survives. So every
     * attribute that identifies the cookie must match.
     */
    expect(cleared.httpOnly).toBe(written.httpOnly);
    expect(cleared.sameSite).toBe(written.sameSite);
    expect(cleared.secure).toBe(written.secure);
    expect(cleared.path).toBe(written.path);
  });
});

describe("reading the session token", () => {
  it("is undefined when the request carries no session", async () => {
    // The mocked store holds no cookies, which is the state of every
    // signed-out request.
    await expect(getSessionToken()).resolves.toBeUndefined();
  });
});
