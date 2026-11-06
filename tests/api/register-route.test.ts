import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The registration route.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * Registration creates an account but does **not** sign the customer in.
 * That is the whole rule, and it is worth one property above all:
 *
 *   1. **No session cookie is issued.** The account is created
 *      unverified, a code is mailed, and the session is issued by
 *      `verify-otp` once the code comes back. A cookie here would mean
 *      the shop had signed in somebody it cannot yet reach — and the
 *      shop mails that address order confirmations, SMS alerts and
 *      one-time passwords.
 *
 *   2. **The account is created unverified.** `emailVerifiedAt: null`,
 *      set by the route itself, is the only thing that makes the account
 *      inert. The route may not leave the field to a default.
 *
 *   3. **A failed mail does not undo the registration.** The account
 *      stays, and the response says the code was not sent, so the
 *      customer can ask for another one instead of starting again and
 *      losing the address they had claimed.
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
 * What the database and the OTP service are configured to do.
 */
const stubs = {
  existingUser: null as { id: string } | null,
  createdWith: null as Record<string, unknown> | null,
  createError: null as Error | null,
  otpError: null as Error | null,
  otpSent: true,
  requestedPurposes: [] as string[],
};

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: async () => stubs.existingUser,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (stubs.createError) throw stubs.createError;

        stubs.createdWith = data;

        return {
          id: "new-user-1",
          name: data.name,
          email: data.email,
          phone: data.phone ?? null,
          role: "CUSTOMER",
          smsOptIn: data.smsOptIn,
        };
      },
    },
    userSkinProfile: {
      create: async () => ({ id: "profile-1" }),
    },
  },
}));

vi.mock("@/lib/auth/otp", () => ({
  requestOtp: async (_email: string, purpose: string) => {
    stubs.requestedPurposes.push(purpose);

    if (stubs.otpError) throw stubs.otpError;

    return {
      sent: stubs.otpSent,
      knownAddress: true,
      retryAfterMs: 0,
    };
  },
  verifyOtp: async () => ({ ok: false }),
  hashCode: () => "hash",
  generateOtpCode: () => "123456",
}));

const { POST: register } = await import("@/app/api/auth/register/route");

/**
 * Builds a request with a JSON body.
 */
function jsonRequest(body: unknown): Request {
  return new Request("https://euroglambd.com/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const REGISTRATION = {
  name: "Ayesha Rahman",
  email: "ayesha@example.com",
  password: "correct-horse-battery",
};

beforeEach(() => {
  cookieWrites.length = 0;

  stubs.existingUser = null;
  stubs.createdWith = null;
  stubs.createError = null;
  stubs.otpError = null;
  stubs.otpSent = true;
  stubs.requestedPurposes.length = 0;
});

describe("POST /api/auth/register", () => {
  it("creates the account and asks for a verification code", async () => {
    const response = await register(jsonRequest(REGISTRATION));

    expect(response.status).toBe(201);

    // The code is a signup code, not a sign-in code.
    expect(stubs.requestedPurposes).toEqual(["SIGNUP"]);
  });

  it("sets no session cookie", async () => {
    await register(jsonRequest(REGISTRATION));

    /*
     * The single most important property of this route.
     *
     * The account exists and is waiting for a code. A cookie here would
     * let the customer browse the shop as a signed-in customer while
     * their address is still unproved — and the shop sends order
     * confirmations, SMS alerts and one-time passwords to it.
     */
    expect(cookieWrites).toHaveLength(0);
  });

  it("creates the account unverified", async () => {
    await register(jsonRequest(REGISTRATION));

    // `emailVerifiedAt: null` is set by the route itself. The account's
    // inertness must not depend on a database default that a later
    // migration could change.
    expect(stubs.createdWith?.emailVerifiedAt).toBeNull();
  });

  it("never creates an administrator", async () => {
    await register(jsonRequest(REGISTRATION));

    // The role is never read from the request — otherwise anybody could
    // self-register as an admin by posting `{"role": "ADMIN"}`.
    expect(stubs.createdWith?.role).toBe("CUSTOMER");
  });

  it("reports the account as unverified", async () => {
    const response = await register(jsonRequest(REGISTRATION));

    const payload = (await response.json()) as {
      ok: boolean;
      data?: {
        user?: { emailVerified?: boolean; id?: string };
        verificationSent?: boolean;
        message?: string;
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.user?.id).toBe("new-user-1");
    expect(payload.data?.user?.emailVerified).toBe(false);
    expect(payload.data?.verificationSent).toBe(true);
  });

  it("refuses a duplicate address with a 409", async () => {
    stubs.existingUser = { id: "someone-else" };

    const response = await register(jsonRequest(REGISTRATION));

    expect(response.status).toBe(409);

    const payload = (await response.json()) as {
      ok: boolean;
      error?: { code?: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("CONFLICT");

    // Nothing was created and nothing was mailed.
    expect(stubs.createdWith).toBeNull();
    expect(stubs.requestedPurposes).toHaveLength(0);
    expect(cookieWrites).toHaveLength(0);
  });

  it("keeps the account when the mail cannot be sent", async () => {
    stubs.otpError = new Error("The mail server refused the message.");

    const response = await register(jsonRequest(REGISTRATION));

    /*
     * The account still exists.
     *
     * The alternative — deleting it because the mail failed — would
     * mean a customer whose mail server had a bad minute loses their
     * account and the address they had claimed, and has to start again.
     */
    expect(response.status).toBe(201);
    expect(stubs.createdWith).not.toBeNull();

    const payload = (await response.json()) as {
      data?: { verificationSent?: boolean; user?: { emailVerified?: boolean } };
    };

    // The customer is told the code did not go out, so they can ask for
    // another one.
    expect(payload.data?.verificationSent).toBe(false);
    expect(payload.data?.user?.emailVerified).toBe(false);

    expect(cookieWrites).toHaveLength(0);
  });
});
