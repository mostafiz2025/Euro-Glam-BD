import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The email sign-in routes.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * Two properties of these routes are worth more than the happy path:
 *
 *   1. **The mail configuration is a hard failure.** There is no mock
 *      driver for the email transport, because the email carries a
 *      one-time password. A silently dropped email is not a degraded
 *      experience — it is a sign-in that appears to work and then does
 *      not. So a deployment with no credentials answers `503` and says
 *      so, rather than `200` and delivering nothing.
 *
 *   2. **Every verification failure is the same failure.** A mistyped
 *      code, an expired code and a code that was never issued all answer
 *      `401` with the same message and no details. If they produced
 *      different answers, the endpoint would tell an attacker how close
 *      they were.
 */

type CookieWrite = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

const cookieWrites: CookieWrite[] = [];

/**
 * The outcome the stubbed transport is configured to produce.
 *
 * The default is a successful send. A test that wants the failure path
 * sets `sendShouldThrow`.
 */
const mailStub = {
  sendShouldThrow: false,
  sentMessages: [] as Array<{ to: string; subject: string }>,
};

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
 * The email transport is stubbed at its own boundary.
 *
 * The stub throws an `EmailError` with `NOT_CONFIGURED` when the test
 * asks it to, which is how the "the shop has no mail configured" path
 * is exercised.
 */
vi.mock("@/lib/email", () => {
  class EmailError extends Error {
    readonly code: "NOT_CONFIGURED" | "SEND_FAILED";

    constructor(
      code: "NOT_CONFIGURED" | "SEND_FAILED",
      message: string,
      cause?: unknown,
    ) {
      super(message);
      this.name = "EmailError";
      this.code = code;

      if (cause !== undefined) this.cause = cause;
    }
  }

  return {
    EmailError,
    isEmailConfigured: () => true,
    resetTransport: () => {},
    readSmtpConfig: () => ({
      host: "smtp.gmail.com",
      port: 587,
      user: "shop@example.com",
      pass: "app-password",
    }),
    sendEmail: async (message: { to: string; subject: string }) => {
      if (mailStub.sendShouldThrow) {
        throw new EmailError(
          "NOT_CONFIGURED",
          "Email is not configured. Set EMAIL_USER and EMAIL_PASS in the environment.",
        );
      }

      mailStub.sentMessages.push({ to: message.to, subject: message.subject });

      return { ok: true };
    },
  };
});

/**
 * The OTP service is stubbed too, so these tests are about the **route**
 * — the envelope, the status codes and the cookie — rather than about
 * the database.
 *
 * `requestError` is how the "the mail server refused the message" path
 * is reached: the service throws the same `EmailError` the real
 * transport would throw, and the route has to translate it.
 */
const serviceStub = {
  requestOutcome: {
    sent: true,
    knownAddress: true,
    retryAfterMs: 0,
  } as {
    sent: boolean;
    knownAddress: boolean;
    retryAfterMs: number;
  },
  verifyResult: { ok: true, userId: "user-1" } as
    | { ok: true; userId: string }
    | { ok: false },
  signupResult: {
    ok: true,
    userId: "user-1",
    firstVerification: true,
  } as
    | { ok: true; userId: string; firstVerification: boolean }
    | { ok: false },
  requestError: null as Error | null,
  /**
   * The purposes the service was asked for, in order.
   *
   * The route passes the purpose through to the service, and the service
   * decides what it may issue. These tests assert the route does not
   * quietly substitute one for the other.
   */
  requestedPurposes: [] as string[],
};

vi.mock("@/lib/auth/otp", () => ({
  requestOtp: async (_email: string, purpose: string) => {
    serviceStub.requestedPurposes.push(purpose);

    if (serviceStub.requestError) throw serviceStub.requestError;

    return serviceStub.requestOutcome;
  },
  verifyOtp: async () => serviceStub.verifyResult,
  hashCode: () => "hash",
  generateOtpCode: () => "123456",
}));

/**
 * The verification service is stubbed separately, because the signup
 * flow goes through it rather than through `verifyOtp` directly — it
 * has to mark the account verified as well as check the code.
 */
vi.mock("@/lib/auth/verification", () => ({
  verifySignupOtp: async () => serviceStub.signupResult,
}));

/**
 * The database lookup that follows a successful verification.
 */
const dbStub = {
  user: {
    id: "user-1",
    name: "OTP Customer",
    email: "owner@example.com",
    phone: "+8801712345678",
    role: "CUSTOMER",
    smsOptIn: false,
    emailVerifiedAt: new Date(),
  } as {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    role: string;
    smsOptIn: boolean;
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

const { POST: sendOtp } = await import("@/app/api/auth/send-otp/route");
const { POST: verifyOtp } = await import("@/app/api/auth/verify-otp/route");

/**
 * `EmailError` is imported from the mocked module, so it is the **same
 * class** the route's `instanceof` check sees. A locally-declared copy
 * would not be `instanceof` the mocked one, and the route would fall
 * through to the generic 500.
 */
const { EmailError } = await import("@/lib/email");

/**
 * The session token is signed with this secret.
 *
 * A real one — 48 bytes of base64 — so the signing path is exercised
 * rather than stubbed out.
 */
process.env.AUTH_JWT_SECRET =
  "test-only-secret-that-is-at-least-32-bytes-long-for-signing";

/**
 * Builds a request with a JSON body.
 */
function jsonRequest(body: unknown): Request {
  return new Request("https://euroglambd.com/api/auth/send-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  cookieWrites.length = 0;
  mailStub.sendShouldThrow = false;
  mailStub.sentMessages.length = 0;

  serviceStub.requestOutcome = {
    sent: true,
    knownAddress: true,
    retryAfterMs: 0,
  };
  serviceStub.verifyResult = { ok: true, userId: "user-1" };
  serviceStub.signupResult = {
    ok: true,
    userId: "user-1",
    firstVerification: true,
  };
  serviceStub.requestError = null;
  serviceStub.requestedPurposes.length = 0;

  dbStub.user = {
    id: "user-1",
    name: "OTP Customer",
    email: "owner@example.com",
    phone: "+8801712345678",
    role: "CUSTOMER",
    smsOptIn: false,
    emailVerifiedAt: new Date(),
  };
});

describe("POST /api/auth/send-otp", () => {
  it("answers with the standard success envelope", async () => {
    const response = await sendOtp(jsonRequest({ email: "owner@example.com" }));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data?: { sent?: boolean };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.sent).toBe(true);
  });

  it("rejects a malformed body with a validation error", async () => {
    const response = await sendOtp(jsonRequest({ email: "not-an-email" }));

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      ok: boolean;
      error?: { code?: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a body with no email", async () => {
    const response = await sendOtp(jsonRequest({}));

    expect(response.status).toBe(400);
  });

  it("answers 404 for an address with no account", async () => {
    serviceStub.requestOutcome = {
      sent: false,
      knownAddress: false,
      retryAfterMs: 0,
    };

    const response = await sendOtp(jsonRequest({ email: "stranger@example.com" }));

    expect(response.status).toBe(404);

    const payload = (await response.json()) as {
      ok: boolean;
      error?: { code?: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("NOT_FOUND");
  });

  it("answers 503 when the mail server is not configured", async () => {
    /*
     * The whole point of there being no mock driver. A deployment that
     * cannot send email must **say so** — not look healthy while
     * delivering nothing.
     */
    serviceStub.requestError = new EmailError(
      "NOT_CONFIGURED",
      "Email is not configured. Set EMAIL_USER and EMAIL_PASS in the environment.",
    );

    const response = await sendOtp(jsonRequest({ email: "owner@example.com" }));

    expect(response.status).toBe(503);

    const payload = (await response.json()) as {
      ok: boolean;
      error?: { code?: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("does not leak the configuration detail into the response", async () => {
    serviceStub.requestError = new EmailError(
      "NOT_CONFIGURED",
      "Email is not configured. Set EMAIL_USER and EMAIL_PASS in the environment.",
    );

    const response = await sendOtp(jsonRequest({ email: "owner@example.com" }));

    const payload = (await response.json()) as {
      error?: { message?: string };
    };

    // The operator needs the detail; the customer does not. The message
    // names the symptom, not the environment variable.
    expect(payload.error?.message).not.toContain("EMAIL_PASS");
    expect(payload.error?.message).not.toContain("EMAIL_USER");
  });

  it("answers 503 when the message itself was refused", async () => {
    serviceStub.requestError = new EmailError(
      "SEND_FAILED",
      "The email could not be sent. Please try again shortly.",
    );

    const response = await sendOtp(jsonRequest({ email: "owner@example.com" }));

    expect(response.status).toBe(503);
  });
});

describe("POST /api/auth/verify-otp", () => {
  it("answers with the user and sets the session cookie", async () => {
    const response = await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "123456" }),
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data?: { user?: { id?: string } };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.user?.id).toBe("user-1");

    expect(cookieWrites).toHaveLength(1);
    expect(cookieWrites[0].name).toBe("egb_session");
    expect(cookieWrites[0].options.httpOnly).toBe(true);
  });

  it("issues a token that carries the account's identity and role", async () => {
    const { verifyToken } = await import("@/lib/auth/jwt");

    await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "123456" }),
    );

    const claims = await verifyToken(cookieWrites[0].value);

    /*
     * The token is the session. Its claims are what the edge proxy
     * reads to decide whether a request may proceed, and what the
     * client reads to decide where to send the customer after signing
     * in.
     *
     * The subject must be the account's id, and the role must be the
     * account's role — because the destination rule sends an admin to
     * the console and a customer to wherever they were going.
     */
    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe("user-1");
    expect(claims?.email).toBe("owner@example.com");
    expect(claims?.name).toBe("OTP Customer");
    expect(claims?.role).toBe("CUSTOMER");
  });

  it("issues a token carrying the ADMIN role for an administrator", async () => {
    const { verifyToken } = await import("@/lib/auth/jwt");

    dbStub.user = {
      ...dbStub.user!,
      id: "admin-1",
      email: "admin@example.com",
      name: "Shop Admin",
      role: "ADMIN",
    };

    await verifyOtp(
      jsonRequest({ email: "admin@example.com", code: "123456" }),
    );

    const claims = await verifyToken(cookieWrites[0].value);

    // The role in the token is what decides the destination, so an
    // administrator's token must carry ADMIN and not CUSTOMER.
    expect(claims?.role).toBe("ADMIN");
    expect(claims?.sub).toBe("admin-1");
  });

  it("rejects a wrong code with 401", async () => {
    serviceStub.verifyResult = { ok: false };

    const response = await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "000000" }),
    );

    expect(response.status).toBe(401);

    const payload = (await response.json()) as {
      ok: boolean;
      error?: { code?: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe("UNAUTHENTICATED");
  });
  it("sets no cookie when the code is rejected", async () => {
    serviceStub.verifyResult = { ok: false };

    await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "000000" }),
    );

    expect(cookieWrites).toHaveLength(0);
  });

  it("answers 401 when the account has gone", async () => {
    dbStub.user = null;

    const response = await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "123456" }),
    );

    expect(response.status).toBe(401);
    expect(cookieWrites).toHaveLength(0);
  });

  it("answers 403 when the account has not been verified", async () => {
    /*
     * The code was correct, but the account has not proved it owns the
     * inbox. A session for it would be a session for an address the shop
     * cannot reach — and the shop sends order confirmations, SMS
     * alerts and one-time passwords to that address.
     */
    dbStub.user = {
      id: "user-1",
      name: "OTP Customer",
      email: "owner@example.com",
      phone: "+8801712345678",
      role: "CUSTOMER",
      smsOptIn: false,
      emailVerifiedAt: null,
    };

    const response = await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "123456" }),
    );

    expect(response.status).toBe(403);

    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(payload.error?.code).toBe("FORBIDDEN");
    expect(payload.error?.message).toContain("verify");

    // No session for an unverified account.
    expect(cookieWrites).toHaveLength(0);
  });

  it("rejects a malformed code with a validation error", async () => {
    const response = await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "abcdef" }),
    );

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      error?: { code?: string };
    };

    expect(payload.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a body with no code", async () => {
    const response = await verifyOtp(jsonRequest({ email: "owner@example.com" }));

    expect(response.status).toBe(400);
  });

  it("accepts a code typed with a space in it", async () => {
    /*
     * A code pasted out of an email often arrives with a space in it.
     * Telling a customer their code is invalid when they typed it
     * correctly leaves them unable to sign in.
     */
    const response = await verifyOtp(
      jsonRequest({ email: "owner@example.com", code: "123 456" }),
    );

    expect(response.status).toBe(200);
  });
});

/**
 * The purpose on the wire.
 *
 * The route passes the purpose through to the service and to the right
 * verification path. These tests pin that plumbing, because the two
 * purposes are separate credentials and a route that substituted one for
 * the other would turn a signup code into a sign-in code.
 */
describe("the purpose on the request", () => {
  it("defaults to sign-in when the body carries no purpose", async () => {
    await sendOtp(jsonRequest({ email: "owner@example.com" }));

    expect(serviceStub.requestedPurposes).toEqual(["SIGNIN"]);
  });

  it("passes the sign-in purpose through to the service", async () => {
    await sendOtp(
      jsonRequest({ email: "owner@example.com", purpose: "SIGNIN" }),
    );

    expect(serviceStub.requestedPurposes).toEqual(["SIGNIN"]);
  });

  it("passes the signup purpose through to the service", async () => {
    await sendOtp(
      jsonRequest({ email: "owner@example.com", purpose: "SIGNUP" }),
    );

    expect(serviceStub.requestedPurposes).toEqual(["SIGNUP"]);
  });

  it("rejects a purpose that is not one of the two", async () => {
    const response = await sendOtp(
      jsonRequest({ email: "owner@example.com", purpose: "RESET_PASSWORD" }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 409 when a signup code is asked for an account that is already verified", async () => {
    /*
     * The service refuses to issue it, because there is nothing left to
     * prove. The route has to turn that into an answer the customer can
     * act on — "you are already verified, sign in instead" — rather than
     * a 200 that promises an email that will never arrive.
     */
    serviceStub.requestOutcome = {
      sent: false,
      knownAddress: true,
      retryAfterMs: 0,
    };

    const response = await sendOtp(
      jsonRequest({ email: "owner@example.com", purpose: "SIGNUP" }),
    );

    expect(response.status).toBe(409);

    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(payload.error?.code).toBe("CONFLICT");
    expect(payload.error?.message).toContain("already verified");
  });

  it("answers 409 when a sign-in code is asked for an account that is not verified", async () => {
    serviceStub.requestOutcome = {
      sent: false,
      knownAddress: true,
      retryAfterMs: 0,
    };

    const response = await sendOtp(
      jsonRequest({ email: "owner@example.com", purpose: "SIGNIN" }),
    );

    expect(response.status).toBe(409);

    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };

    expect(payload.error?.code).toBe("CONFLICT");
    expect(payload.error?.message).toContain("verify");
  });

  it("verifies a signup code through the verification service", async () => {
    const response = await verifyOtp(
      jsonRequest({
        email: "owner@example.com",
        code: "123456",
        purpose: "SIGNUP",
      }),
    );

    expect(response.status).toBe(200);
    expect(cookieWrites).toHaveLength(1);
  });

  it("says whether this verification is what made the account usable", async () => {
    const response = await verifyOtp(
      jsonRequest({
        email: "owner@example.com",
        code: "123456",
        purpose: "SIGNUP",
      }),
    );

    const payload = (await response.json()) as {
      data?: { firstVerification?: boolean };
    };

    expect(payload.data?.firstVerification).toBe(true);
  });

  it("does not claim a first verification on an ordinary sign-in", async () => {
    const response = await verifyOtp(
      jsonRequest({
        email: "owner@example.com",
        code: "123456",
        purpose: "SIGNIN",
      }),
    );

    const payload = (await response.json()) as {
      data?: { firstVerification?: boolean };
    };

    expect(payload.data?.firstVerification).toBeUndefined();
  });
});
