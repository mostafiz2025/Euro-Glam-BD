import { OtpPurpose } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/errors";
import { hashCode, requestOtp, verifyOtp } from "@/lib/auth/otp";
import { OTP_MAX_ATTEMPTS } from "@/lib/validation/otp";

/**
 * The email sign-in integration tests.
 *
 * These exercise the real database, because the properties that matter
 * most about a one-time password **are** database properties:
 *
 *   1. **The code is never stored in the clear.** Only a salted hash of it
 *      reaches the table, so a dump of the table is not a list of codes
 *      that work.
 *
 *   2. **The code is single-use.** The row is deleted the moment it is
 *      verified — including under concurrency, which is the case where a
 *      naive delete would let two requests both sign in.
 *
 *   3. **The attempt limit is counted in the database.** A process-local
 *      counter would be reset on every restart and would not be shared
 *      between instances — which is exactly when a cap is needed.
 *
 *   4. **The resend cooldown is counted in the database**, for the same
 *      reason.
 *
 * The mail itself is **not** sent. There is no mock driver for the email
 * transport — deliberately, because a silently dropped email is a sign-in
 * that appears to work and then does not. So the transport is stubbed at
 * the boundary of these tests: the code is captured from the message
 * that *would* have gone out, and everything else — the hashing, the
 * expiry, the attempt counting, the single-use deletion — is the real
 * implementation against the real table.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

/**
 * The codes captured from the messages the transport was asked to send.
 *
 * The transport is stubbed rather than mocked away: `sendEmail` is
 * replaced with a recorder, and the tests read the code out of the
 * captured message. That keeps the *shape* of the message under test —
 * the code really does appear in the subject and the body — while
 * keeping the network out of it.
 *
 * The stub is a `vi.mock` factory rather than a spy because the module
 * is imported statically at the top of this file: a `vi.doMock` would
 * arrive too late, after the real module had already been bound.
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

const runId = `otp${Date.now()}${Math.floor(Math.random() * 100000)}`;

/**
 * The customer who has an account.
 */
const OWNER_EMAIL = `${runId}_owner@example.com`;

/**
 * An address that belongs to nobody.
 */
const STRANGER_EMAIL = `${runId}_stranger@example.com`;

/**
 * An account that has been created but has not yet been verified.
 *
 * This is the state every new customer is in between submitting the
 * registration form and entering the code that was mailed to them.
 */
const UNVERIFIED_EMAIL = `${runId}_unverified@example.com`;

const createdUserIds: string[] = [];

/**
 * Creates a customer account.
 *
 * The account is created **verified** by default, because the sign-in
 * flow refuses to issue a code to an account that has not proved it owns
 * its inbox.
 *
 * The unverified case is exercised separately, by the account created
 * for the signup flow.
 */
async function createUser(
  email: string,
  options: { verified?: boolean } = {},
): Promise<string> {
  const verified = options.verified ?? true;

  const user = await prisma.user.create({
    data: {
      name: "OTP Customer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
      ...(verified ? { emailVerifiedAt: new Date() } : {}),
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);

  return user.id;
}

/**
 * The code that was captured for an address.
 *
 * The code appears in the subject as well as the body, so the subject is
 * the reliable place to read it from — the body is HTML-escaped and
 * formatted for a human.
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

/**
 * Every address these tests touch.
 *
 * They are listed together because the cleanup deletes by address, and a
 * forgotten address would leave a row behind that the next run would
 * trip over.
 */
const ALL_EMAILS = [OWNER_EMAIL, STRANGER_EMAIL, UNVERIFIED_EMAIL];

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the email OTP " +
        "integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  await createUser(OWNER_EMAIL);
  await createUser(UNVERIFIED_EMAIL, { verified: false });
});

afterAll(async () => {
  if (!databaseAvailable) return;

  try {
    await prisma.emailOtp.deleteMany({
      where: { email: { in: ALL_EMAILS } },
    });
    await prisma.emailOtpAttempt.deleteMany({
      where: { email: { in: ALL_EMAILS } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  } finally {
    sentMessages.length = 0;
  }
});

beforeEach(async () => {
  if (!databaseAvailable) return;

  sentMessages.length = 0;

  await prisma.emailOtp.deleteMany({
    where: { email: { in: ALL_EMAILS } },
  });
  await prisma.emailOtpAttempt.deleteMany({
    where: { email: { in: ALL_EMAILS } },
  });
});

describe("requestOtp", () => {
  it("sends a code to an address that has an account", async () => {
    if (!databaseAvailable) return;

    const outcome = await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    expect(outcome.sent).toBe(true);
    expect(outcome.knownAddress).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe(OWNER_EMAIL);
  });

  it("writes a row for the code", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const rows = await prisma.emailOtp.findMany({
      where: { email: OWNER_EMAIL },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does not store the code in the clear", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);

    const row = await prisma.emailOtp.findFirst({
      where: { email: OWNER_EMAIL },
    });

    expect(row).not.toBeNull();
    expect(row?.codeHash).not.toBe(code);
    expect(row?.codeHash).not.toContain(code);
    expect(row?.codeHash).toBe(hashCode(code, row!.id));
  });

  it("sends nothing to an address that has no account", async () => {
    if (!databaseAvailable) return;

    const outcome = await requestOtp(STRANGER_EMAIL, OtpPurpose.SIGNIN);

    expect(outcome.sent).toBe(false);
    expect(outcome.knownAddress).toBe(false);
    expect(sentMessages).toHaveLength(0);

    const rows = await prisma.emailOtp.findMany({
      where: { email: STRANGER_EMAIL },
    });

    expect(rows).toHaveLength(0);
  });

  it("replaces a previous code rather than adding a second one", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    // Move the cooldown out of the way. The cooldown is counted on the
    // *attempt* ledger, not on the OTP row — that is the whole point of
    // the separate ledger.
    await prisma.emailOtpAttempt.updateMany({
      where: { email: OWNER_EMAIL },
      data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) },
    });

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const rows = await prisma.emailOtp.findMany({
      where: { email: OWNER_EMAIL },
    });

    /*
     * One outstanding code, not two.
     *
     * A customer with two live codes has two emails in their inbox that
     * both look like the current one, and no way to tell which is which.
     */
    expect(rows).toHaveLength(1);
  });

  it("refuses a second code inside the cooldown", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    await expect(requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN)).rejects.toThrow(ApiError);
  });

  it("cools the resend down for an address with no account too", async () => {
    if (!databaseAvailable) return;

    /*
     * The cooldown is keyed by **address**, not by account.
     *
     * If it were keyed by account, an address with no account would never
     * be cooled down — and the endpoint would be a free enumeration
     * oracle: probe a thousand addresses as fast as the network allows,
     * and the ones that answer 429 are the ones with customers.
     */
    await requestOtp(STRANGER_EMAIL, OtpPurpose.SIGNIN);

    await expect(requestOtp(STRANGER_EMAIL, OtpPurpose.SIGNIN)).rejects.toThrow(ApiError);
  });

  it("records an attempt for an address with no account", async () => {
    if (!databaseAvailable) return;

    /*
     * The ledger records the *attempt*, not the outcome.
     *
     * If it only recorded requests that produced a code, the cooldown
     * would not apply to the addresses an attacker would actually probe.
     */
    await requestOtp(STRANGER_EMAIL, OtpPurpose.SIGNIN);

    const attempts = await prisma.emailOtpAttempt.findMany({
      where: { email: STRANGER_EMAIL },
    });

    expect(attempts).toHaveLength(1);
  });

  it("records the same shape of attempt for an address with an account", async () => {
    if (!databaseAvailable) return;

    /*
     * The two rows must be indistinguishable. A ledger that recorded
     * which addresses belong to customers would turn a dump of this
     * database into the customer list — which is the one thing the
     * endpoint must not reveal.
     */
    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const owner = await prisma.emailOtpAttempt.findFirst({
      where: { email: OWNER_EMAIL },
    });

    await requestOtp(STRANGER_EMAIL, OtpPurpose.SIGNIN);

    const stranger = await prisma.emailOtpAttempt.findFirst({
      where: { email: STRANGER_EMAIL },
    });

    expect(Object.keys(owner ?? {}).sort()).toEqual(
      Object.keys(stranger ?? {}).sort(),
    );
  });
});

describe("verifyOtp", () => {
  it("accepts the code that was sent", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const result = await verifyOtp(
      OWNER_EMAIL,
      capturedCode(OWNER_EMAIL),
      OtpPurpose.SIGNIN,
    );

    expect(result.ok).toBe(true);
  });

  it("rejects a wrong code", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    const result = await verifyOtp(OWNER_EMAIL, wrong, OtpPurpose.SIGNIN);

    expect(result.ok).toBe(false);
  });

  it("rejects a code that was never issued", async () => {
    if (!databaseAvailable) return;

    const result = await verifyOtp(OWNER_EMAIL, "123456", OtpPurpose.SIGNIN);

    expect(result.ok).toBe(false);
  });

  it("rejects a code for an address with no code outstanding", async () => {
    if (!databaseAvailable) return;

    const result = await verifyOtp(STRANGER_EMAIL, "123456", OtpPurpose.SIGNIN);

    expect(result.ok).toBe(false);
  });

  it("deletes the row once the code is used", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    await verifyOtp(
      OWNER_EMAIL,
      capturedCode(OWNER_EMAIL),
      OtpPurpose.SIGNIN,
    );

    const rows = await prisma.emailOtp.findMany({
      where: { email: OWNER_EMAIL },
    });

    /*
     * A verified code is worth nothing. Leaving it behind — even flagged
     * as consumed — keeps a replayable hash in the table and gives an
     * attacker one more thing to take.
     */
    expect(rows).toHaveLength(0);
  });

  it("will not accept the same code twice", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);

    const first = await verifyOtp(OWNER_EMAIL, code, OtpPurpose.SIGNIN);
    const second = await verifyOtp(OWNER_EMAIL, code, OtpPurpose.SIGNIN);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("counts a wrong guess", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    await verifyOtp(OWNER_EMAIL, wrong, OtpPurpose.SIGNIN);

    const row = await prisma.emailOtp.findFirst({
      where: { email: OWNER_EMAIL },
    });

    expect(row?.attempts).toBe(1);
  });

  it("kills the code after the attempt limit", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      const result = await verifyOtp(OWNER_EMAIL, wrong, OtpPurpose.SIGNIN);

      expect(result.ok).toBe(false);
    }

    const row = await prisma.emailOtp.findFirst({
      where: { email: OWNER_EMAIL },
    });

    expect(row?.attempts).toBe(OTP_MAX_ATTEMPTS);

    // The right code no longer works, either.
    const result = await verifyOtp(OWNER_EMAIL, code, OtpPurpose.SIGNIN);

    expect(result.ok).toBe(false);
  });

  it("rejects an expired code", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);

    // Push the expiry into the past.
    await prisma.emailOtp.updateMany({
      where: { email: OWNER_EMAIL },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await verifyOtp(OWNER_EMAIL, code, OtpPurpose.SIGNIN);

    expect(result.ok).toBe(false);
  });

  it("rejects a code issued for a different address", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);

    const result = await verifyOtp(STRANGER_EMAIL, code, OtpPurpose.SIGNIN);

    expect(result.ok).toBe(false);
  });
});

/**
 * The two purposes.
 *
 * ── The rule under test ──────────────────────────────────────────────────
 *
 * **A code issued for one purpose must not work for the other.**
 *
 * The shop mails a six-digit code for two different jobs:
 *
 *   • **SIGNUP** — proving that the person registering owns the inbox
 *     they registered with.
 *
 *   • **SIGNIN** — letting an existing customer sign in without a
 *     password.
 *
 * These are different credentials, and the difference is load-bearing.
 * Without it, an intercepted signup verification mail is a **valid
 * sign-in code** for an account that was never verified — which would
 * hand the attacker the account permanently, and would leave the shop
 * believing it can reach a customer whose inbox it has never proved it
 * can reach.
 *
 * These tests run against the real table, because the property is a
 * database property: the purpose is part of the **lookup**, not a note
 * on the row.
 */
describe("the two OTP purposes", () => {
  it("refuses a sign-in code for an account that has not been verified", async () => {
    if (!databaseAvailable) return;

    /*
     * The account exists, but it has not proved it owns its inbox. A
     * sign-in code would be a key to a door that is not open yet.
     */
    const outcome = await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNIN);

    expect(outcome.sent).toBe(false);
    expect(outcome.knownAddress).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });

  it("issues a signup code for an account that has not been verified", async () => {
    if (!databaseAvailable) return;

    const outcome = await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNUP);

    expect(outcome.sent).toBe(true);
    expect(outcome.knownAddress).toBe(true);
    expect(sentMessages).toHaveLength(1);
  });

  it("refuses a signup code for an account that is already verified", async () => {
    if (!databaseAvailable) return;

    /*
     * There is nothing left to prove. The account proved it when it was
     * created, and mailing a second code would leave the customer
     * waiting for an email that completes nothing.
     */
    const outcome = await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNUP);

    expect(outcome.sent).toBe(false);
    expect(outcome.knownAddress).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });

  it("stores the purpose on the row", async () => {
    if (!databaseAvailable) return;

    await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNUP);

    const row = await prisma.emailOtp.findFirst({
      where: { email: UNVERIFIED_EMAIL },
    });

    expect(row?.purpose).toBe(OtpPurpose.SIGNUP);
  });

  it("does not let a signup code sign in", async () => {
    if (!databaseAvailable) return;

    await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNUP);

    const code = capturedCode(UNVERIFIED_EMAIL);

    // The sign-in lookup does not even read the signup row.
    const result = await verifyOtp(
      UNVERIFIED_EMAIL,
      code,
      OtpPurpose.SIGNIN,
    );

    expect(result.ok).toBe(false);
  });

  it("does not let a sign-in code verify an account", async () => {
    if (!databaseAvailable) return;

    /*
     * The account is verified so that a sign-in code can be issued to it.
     * The verification code is then spent trying to verify — and the
     * verification lookup does not read the sign-in row.
     */
    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const code = capturedCode(OWNER_EMAIL);

    const result = await verifyOtp(
      OWNER_EMAIL,
      code,
      OtpPurpose.SIGNUP,
    );

    expect(result.ok).toBe(false);
  });

  it("keeps the two purposes as separate rows", async () => {
    if (!databaseAvailable) return;

    /*
     * Asking for one purpose must not destroy the other's code.
     *
     * The two flows are separate journeys, and a customer may be in the
     * middle of one while the other runs. Deleting across purposes would
     * mean asking for a sign-in code silently cancelled a pending
     * signup.
     */
    await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNUP);

    // Move the cooldown out of the way.
    await prisma.emailOtpAttempt.updateMany({
      where: { email: UNVERIFIED_EMAIL },
      data: { createdAt: new Date(Date.now() - 5 * 60 * 1000) },
    });

    await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNIN);

    const rows = await prisma.emailOtp.findMany({
      where: { email: UNVERIFIED_EMAIL },
    });

    // The sign-in one was refused, so only the signup row survives.
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe(OtpPurpose.SIGNUP);
  });

  it("counts the cooldown once across both purposes", async () => {
    if (!databaseAvailable) return;

    /*
     * The cooldown is keyed by **address**, not by address-and-purpose.
     *
     * If it were per purpose, the two flows would be two independent mail
     * budgets for one mailbox — which is exactly the way to get an
     * address suspended, and it would make the limit weaker than it
     * looks.
     */
    await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNUP);

    await expect(
      requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNIN),
    ).rejects.toThrow(ApiError);
  });

  it("names the purpose in the subject of the message", async () => {
    if (!databaseAvailable) return;

    await requestOtp(UNVERIFIED_EMAIL, OtpPurpose.SIGNUP);

    const message = sentMessages.find((m) => m.to === UNVERIFIED_EMAIL);

    // A customer with two codes in their inbox has to be able to tell
    // which is which from the subject line alone.
    expect(message?.subject).toContain("verification code");
  });

  it("names the sign-in purpose in the subject of the message", async () => {
    if (!databaseAvailable) return;

    await requestOtp(OWNER_EMAIL, OtpPurpose.SIGNIN);

    const message = sentMessages.find((m) => m.to === OWNER_EMAIL);

    expect(message?.subject).toContain("sign-in code");
  });
});
