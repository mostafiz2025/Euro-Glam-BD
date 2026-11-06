import { OtpPurpose } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { requestOtp } from "@/lib/auth/otp";
import { verifySignupOtp } from "@/lib/auth/verification";

/**
 * The registration-verification integration tests.
 *
 * ── What these exercise ───────────────────────────────────────────────────
 *
 * The property that matters about account verification is a
 * **concurrency** property, and it is a database property:
 *
 *   1. **The verification code is single-use.** The row is deleted the
 *      moment it is verified, so a second request carrying the same code
 *      finds nothing.
 *
 *   2. **The account is marked verified exactly once.** The write is
 *      conditional on the account still being unverified, so two
 *      concurrent requests carrying the same code cannot both claim to
 *      be the one that verified it.
 *
 *   3. **The account is only marked verified when the code is right.**
 *      A wrong code leaves the account untouched.
 *
 * These run against the real database, because the conditional delete
 * and the conditional update are the whole mechanism — a mock would
 * happily allow both requests to succeed.
 *
 * The mail is stubbed at the transport boundary, for the same reason the
 * other OTP tests stub it: there is deliberately no mock driver for
 * email, so the code is captured from the message that *would* have gone
 * out.
 */

import { prisma } from "./client";

/**
 * The codes captured from the messages the transport was asked to send.
 */
const sentMessages: Array<{
  to: string;
  subject: string;
  text: string;
  html: string;
}> = [];

vi.mock("@/lib/email", () => ({
  sendEmail: async (message: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }) => {
    sentMessages.push(message);

    return { ok: true };
  },
  EmailError: class EmailError extends Error {},
  isEmailConfigured: () => true,
  resetTransport: () => {},
  readSmtpConfig: () => ({
    host: "smtp.gmail.com",
    port: 587,
    user: "shop@example.com",
    pass: "app-password",
  }),
}));

let databaseAvailable = false;

const runId = `ver${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * The account that has just registered and has not been verified.
 */
const NEW_EMAIL = `${runId}_new@example.com`;

const createdUserIds: string[] = [];

async function createUnverifiedUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "New Customer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
      emailVerifiedAt: null,
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  return user.id;
}

/**
 * The code that was captured for an address.
 */
function capturedCode(email: string): string {
  const message = sentMessages.find((m) => m.to === email);

  if (!message) {
    throw new Error(`No message was captured for ${email}.`);
  }

  const match = /(\d{6})/.exec(message.subject);

  if (!match) {
    throw new Error(`The captured message for ${email} carried no code.`);
  }

  return match[1];
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the account " +
        "verification integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  await createUnverifiedUser(NEW_EMAIL);
});

afterAll(async () => {
  if (!databaseAvailable) return;

  try {
    await prisma.emailOtp.deleteMany({ where: { email: NEW_EMAIL } });
    await prisma.emailOtpAttempt.deleteMany({ where: { email: NEW_EMAIL } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } finally {
    sentMessages.length = 0;
  }
});

beforeEach(async () => {
  if (!databaseAvailable) return;

  sentMessages.length = 0;

  await prisma.emailOtp.deleteMany({ where: { email: NEW_EMAIL } });
  await prisma.emailOtpAttempt.deleteMany({ where: { email: NEW_EMAIL } });

  // Every test starts from an unverified account.
  await prisma.user.updateMany({
    where: { email: NEW_EMAIL },
    data: { emailVerifiedAt: null },
  });
});

describe("verifySignupOtp", () => {
  it("marks the account verified", async () => {
    if (!databaseAvailable) return;

    await requestOtp(NEW_EMAIL, OtpPurpose.SIGNUP);

    const result = await verifySignupOtp(NEW_EMAIL, capturedCode(NEW_EMAIL));

    expect(result.ok).toBe(true);
    expect(result).toHaveProperty("firstVerification", true);

    const user = await prisma.user.findUnique({
      where: { email: NEW_EMAIL },
      select: { emailVerifiedAt: true },
    });

    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it("rejects a wrong code and leaves the account unverified", async () => {
    if (!databaseAvailable) return;

    await requestOtp(NEW_EMAIL, OtpPurpose.SIGNUP);

    const code = capturedCode(NEW_EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    const result = await verifySignupOtp(NEW_EMAIL, wrong);

    expect(result.ok).toBe(false);

    const user = await prisma.user.findUnique({
      where: { email: NEW_EMAIL },
      select: { emailVerifiedAt: true },
    });

    // A wrong code must not verify anything.
    expect(user?.emailVerifiedAt).toBeNull();
  });

  it("rejects a code that was never issued", async () => {
    if (!databaseAvailable) return;

    const result = await verifySignupOtp(NEW_EMAIL, "123456");

    expect(result.ok).toBe(false);
  });

  it("will not accept the same code twice", async () => {
    if (!databaseAvailable) return;

    await requestOtp(NEW_EMAIL, OtpPurpose.SIGNUP);

    const code = capturedCode(NEW_EMAIL);

    const first = await verifySignupOtp(NEW_EMAIL, code);
    const second = await verifySignupOtp(NEW_EMAIL, code);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("does not claim a first verification for an already-verified account", async () => {
    if (!databaseAvailable) return;

    /*
     * The code is issued while the account is still unverified, and the
     * account is then verified **out of band** — as if another device,
     * or an administrator, had already completed the verification.
     *
     * The code is deliberately issued first, because the service refuses
     * to issue a signup code for an account that is already verified:
     * such an account has nothing left to prove. So the only way to
     * present a live signup code for a verified account is to have
     * obtained it before the verification happened.
     */
    await requestOtp(NEW_EMAIL, OtpPurpose.SIGNUP);

    const code = capturedCode(NEW_EMAIL);

    await prisma.user.updateMany({
      where: { email: NEW_EMAIL },
      data: { emailVerifiedAt: new Date() },
    });

    const second = await verifySignupOtp(NEW_EMAIL, code);

    expect(second.ok).toBe(true);
    expect(second).toHaveProperty("firstVerification", false);
  });

  it("does not let a sign-in code verify an account", async () => {
    if (!databaseAvailable) return;

    /*
     * The account is verified so that a sign-in code can be issued to it.
     * The verification code is then spent trying to verify — and the
     * verification lookup does not read the sign-in row.
     */
    await prisma.user.updateMany({
      where: { email: NEW_EMAIL },
      data: { emailVerifiedAt: new Date() },
    });

    await requestOtp(NEW_EMAIL, OtpPurpose.SIGNIN);

    const result = await verifySignupOtp(NEW_EMAIL, capturedCode(NEW_EMAIL));

    expect(result.ok).toBe(false);
  });

  it("marks the account verified exactly once under concurrency", async () => {
    if (!databaseAvailable) return;

    await requestOtp(NEW_EMAIL, OtpPurpose.SIGNUP);

    const code = capturedCode(NEW_EMAIL);

    /*
     * Two requests carrying the same valid code, at the same time.
     *
     * Both will read the account as unverified, and both will find the
     * code. The conditional write is what settles it: only one can set
     * the timestamp, and the other is told the account was already
     * verified.
     */
    const [first, second] = await Promise.all([
      verifySignupOtp(NEW_EMAIL, code),
      verifySignupOtp(NEW_EMAIL, code),
    ]);

    const firstVerifications = [first, second].filter(
      (r) => r.ok && "firstVerification" in r && r.firstVerification,
    );

    expect(firstVerifications).toHaveLength(1);
  });

  it("deletes the code row once the account is verified", async () => {
    if (!databaseAvailable) return;

    await requestOtp(NEW_EMAIL, OtpPurpose.SIGNUP);

    await verifySignupOtp(NEW_EMAIL, capturedCode(NEW_EMAIL));

    const rows = await prisma.emailOtp.findMany({
      where: { email: NEW_EMAIL },
    });

    // A verified code is worth nothing, and keeping its hash around
    // only widens the window in which a leaked hash is useful.
    expect(rows).toHaveLength(0);
  });
});
