import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The password login route.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The login route is one of three places a session is issued (the other
 * two are the two OTP verification flows), and it is the only one of the
 * three that still has a password behind it. So it carries two properties
 * that are worth more than the happy path:
 *
 *   1. **An unverified account is refused.** The password may be
 *      perfectly correct, but the account has not proved that its owner
 *      can receive mail at its address — and the shop sends order
 *      confirmations, SMS alerts and one-time passwords there. The
 *      refusal is a `403`, and it says what to do about it.
 *
 *   2. **The refusal comes *after* the password check.** Checking the
 *      account's state first would be tidier and cheaper, and it would
 *      also be an enumeration oracle: an attacker who does not know the
 *      password would learn which addresses have unverified accounts. So
 *      the order is deliberate, and these tests pin it.
 *
 * The tests also cover the ordinary failure — a wrong password — because
 * that answer must be identical to the answer for an address that has no
 * account at all.
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

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();

  return {
    ...actual,
    connection: async () => undefined,
  };
});

/**
 * The account the database holds.
 *
 * `passwordHash` is a real bcrypt hash of "correct-horse-battery", so
 * the password check genuinely passes rather than being stubbed out. The
 * point of these tests is the *ordering* of the checks, and an ordering
 * test with a stubbed password check proves nothing.
 */
const PASSWORD = "correct-horse-battery";

const dbStub = {
  user: {
    id: "user-1",
    name: "Shop Customer",
    email: "customer@example.com",
    phone: "+8801712345678",
    role: "CUSTOMER",
    smsOptIn: false,
    passwordHash: "",
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  } as {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    role: string;
    smsOptIn: boolean;
    passwordHash: string;
    emailVerifiedAt: Date | null;
  } | null,
};

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: async () => dbStub.user,
    },
  },
}));

/**
 * The session token is signed with this secret — a real one, so the
 * signing path is exercised rather than stubbed.
 */
process.env.AUTH_JWT_SECRET =
  "test-only-secret-that-is-at-least-32-bytes-long-for-signing";

const { POST: login } = await import("@/app/api/auth/login/route");
const { hashPassword } = await import("@/lib/auth/password");
const { verifyToken } = await import("@/lib/auth/jwt");

/**
 * Builds a request with a JSON body.
 */
function jsonRequest(body: unknown): Request {
  return new Request("https://euroglambd.com/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  cookieWrites.length = 0;

  dbStub.user = {
    id: "user-1",
    name: "Shop Customer",
    email: "customer@example.com",
    phone: "+8801712345678",
    role: "CUSTOMER",
    smsOptIn: false,
    passwordHash: await hashPassword(PASSWORD),
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
});

describe("POST /api/auth/login", () => {
  it("signs a verified customer in and sets the session cookie", async () => {
    const response = await login(
      jsonRequest({ email: "customer@example.com", password: PASSWORD }),
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data?: { user?: { id?: string; emailVerified?: boolean } };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.user?.id).toBe("user-1");
    expect(payload.data?.user?.emailVerified).toBe(true);

    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0].name).toBe("egb_session");
    expect(cookieWrites[0].options.httpOnly).toBe(true);
    expect(cookieWrites[0].options.path).toBe("/");
    expect(cookieWrites[0].options.sameSite).toBe("lax");
  });

  it("issues a token that carries the account's identity and role", async () => {
    await login(jsonRequest({ email: "customer@example.com", password: PASSWORD }));

    const claims = await verifyToken(cookieWrites[0].value);

    expect(claims?.sub).toBe("user-1");
    expect(claims?.email).toBe("customer@example.com");
    expect(claims?.role).toBe("CUSTOMER");
  });

  it("refuses an unverified account with a 403", async () => {
    dbStub.user = { ...dbStub.user!, emailVerifiedAt: null };

    const response = await login(
      jsonRequest({ email: "customer@example.com", password: PASSWORD }),
    );

    expect(response.status).toBe(403);

    const payload = (await response.json()) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("FORBIDDEN");

    // The message must tell the customer what to do, not merely that
    // they may not.
    expect(payload.error?.message).toMatch(/verify/i);
  });

  it("sets no cookie for an unverified account", async () => {
    dbStub.user = { ...dbStub.user!, emailVerifiedAt: null };

    await login(jsonRequest({ email: "customer@example.com", password: PASSWORD }));

    // An unverified account that got a session cookie would be signed in
    // by any route that trusted the cookie without re-reading the
    // account.
    expect(cookieWrites).toHaveLength(0);
  });

  it("answers a wrong password exactly as it answers an unknown account", async () => {
    const wrongPassword = await login(
      jsonRequest({ email: "customer@example.com", password: "not-the-password" }),
    );

    const wrongPayload = (await wrongPassword.json()) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };

    dbStub.user = null;

    const unknownAccount = await login(
      jsonRequest({ email: "nobody@example.com", password: PASSWORD }),
    );

    const unknownPayload = (await unknownAccount.json()) as {
      ok: boolean;
      error?: { code?: string; message?: string };
    };

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);

    /*
     * The two answers must be byte-identical.
     *
     * If they differed, the endpoint would tell an attacker which
     * addresses have accounts — the single most useful thing a login
     * endpoint can leak.
     */
    expect(wrongPayload.error?.code).toBe(unknownPayload.error?.code);
    expect(wrongPayload.error?.message).toBe(unknownPayload.error?.message);
  });

  it("does not reveal that an account exists to a wrong password", async () => {
    const response = await login(
      jsonRequest({ email: "customer@example.com", password: "not-the-password" }),
    );

    const payload = (await response.json()) as {
      error?: { message?: string };
    };

    // The message names neither the account nor its state.
    expect(payload.error?.message).toBe("Incorrect email or password.");
    expect(payload.error?.message).not.toMatch(/verif/i);
    expect(cookieWrites).toHaveLength(0);
  });

  it("refuses an unverified account with a wrong password as a 401, not a 403", async () => {
    /*
     * The verification gate sits **after** the password check.
     *
     * If it sat before, an attacker who does not know the password
     * would learn which addresses are merely awaiting verification — a
     * fact about the account's state, obtained without proving anything.
     */
    dbStub.user = { ...dbStub.user!, emailVerifiedAt: null };

    const response = await login(
      jsonRequest({ email: "customer@example.com", password: "not-the-password" }),
    );

    expect(response.status).toBe(401);

    const payload = (await response.json()) as {
      error?: { message?: string };
    };

    expect(payload.error?.message).toBe("Incorrect email or password.");
  });
});
