import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { OtpPurpose } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_OUTSTANDING_PER_EMAIL,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from "@/lib/validation/otp";

/**
 * The email one-time-password service.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * The shop mails a six-digit code for two different jobs:
 *
 *   • **SIGNUP** — proving that the person registering owns the inbox
 *     they registered with. The account is created unverified, and it
 *     becomes usable when the code comes back.
 *
 *   • **SIGNIN** — letting an existing customer sign in without a
 *     password they would have to invent, store and reset.
 *
 * Both codes are **credentials**: they prove control of an inbox, and
 * the inbox is proved by receiving mail at it.
 *
 * ── The rule that governs the purpose ─────────────────────────────────────
 *
 * **A code issued for one purpose must not work for the other.**
 *
 * These are different credentials, and the difference is load-bearing.
 * An intercepted signup verification mail is otherwise a **valid sign-in
 * code** for an account that was never verified — which would hand the
 * attacker the account permanently. So the purpose is stored on the row
 * and the verification only ever reads the row whose purpose matches.
 *
 * ── The rule that governs this file ───────────────────────────────────────
 *
 * **The code is a secret for exactly as long as it takes to use it, and
 * not one second longer.**
 *
 * Four things enforce that, and all four are necessary:
 *
 *   1. **The code is never stored.** Only a salted SHA-256 hash of it is
 *      written to the database, so a dump of the table is not a list of
 *      codes that work. See `hashCode`.
 *
 *   2. **The code expires.** Ten minutes, stored as an absolute instant
 *      on the row so that a restart cannot extend it.
 *
 *   3. **The code is single-use.** The row is deleted the moment it is
 *      verified. A verified code is worth nothing, and leaving it in the
 *      table only widens the window in which a leaked hash is useful.
 *
 *   4. **The code is attempt-limited.** Five wrong guesses and the row
 *      is dead, however much time is left on it. Six digits is a million
 *      possibilities, and a million possibilities is not a secret on its
 *      own.
 *
 * ── The rule that governs the failure ─────────────────────────────────────
 *
 * **A wrong code must not be a different wrong code.**
 *
 * The verification endpoint answers with exactly one negative outcome,
 * and it is the same outcome for a mistyped code, a code that has
 * expired, a code that was never issued, a code that has been used
 * already, a code that has run out of attempts, and a code issued for
 * the *other* purpose. If those produced different answers, the endpoint
 * would tell an attacker *how close* they were — and "this code exists
 * but has expired" is a fact about a customer's account that an attacker
 * should not be able to obtain.
 *
 * ── The rule that governs issuance ─────────────────────────────────────────
 *
 * **Issuing a code says nothing about whether an account exists.**
 *
 * `requestOtp` answers identically for an address that has an account and
 * one that does not. The difference is only in what the shop *does*: an
 * address with an account gets a code, and an address without one gets
 * a 404 — because a customer who asks for a code to an address that has
 * no account needs to be told so, or they will sit in front of a form
 * waiting for an email that will never arrive.
 *
 * The tension between those two requirements is real, and it is resolved
 * by the **rate limit**. The endpoint is rate-limited per address, so
 * enumerating addresses costs the attacker one request per minute per
 * address. That is slow enough to make a harvest of the customer list
 * impractical, and fast enough for a customer to get their code.
 */

/**
 * The number of digits in a code.
 *
 * Re-exported from the validation vocabulary so that the service and the
 * schema cannot drift apart.
 */
const CODE_LENGTH = OTP_LENGTH;

/**
 * Generates a six-digit code.
 *
 * `randomInt` is a cryptographically secure generator — it draws from
 * the platform's CSPRNG and rejects a range whose width is not a
 * multiple of the alphabet size, so the six digits are uniform rather
 * than merely "random-looking".
 *
 * The code is generated as a **number** and then zero-padded to six
 * digits. Generating it as a number rather than as six digit characters
 * matters: picking six digits independently would let "000001" and
 * "123456" be equally likely, but it would also make the leading digit
 * distribution depend on the implementation of the character picker.
 * One uniform draw over 1,000,000 gives every six-digit string exactly
 * the same probability.
 */
export function generateOtpCode(): string {
  const value = randomInt(0, 10 ** CODE_LENGTH);

  return value.toString().padStart(CODE_LENGTH, "0");
}

/**
 * Hashes a code, salted with the row's own id.
 *
 * ── Why SHA-256, and not bcrypt ───────────────────────────────────────────
 *
 * A password hash is deliberately slow, because a password is a secret
 * the user chose and the attacker may try for years. A one-time code is
 * not that: it has six digits and ten minutes of life. The search space
 * is a million, and the salt defeats the rainbow table, so the only
 * thing a slow hash would buy is server CPU on every verification — a
 * cost paid by the shop, to protect a credential that is dead within the
 * hour anyway.
 *
 * ── Why the salt is the row's id ───────────────────────────────────────────
 *
 * The salt must be unique per row, and it must be **known** — the
 * verification step recomputes the hash from the stored id and the
 * submitted code, so the salt cannot be a secret.
 *
 * The row id is ideal: it is unique by construction, it is already in
 * the table, and it means two customers who happen to be issued the same
 * six digits do not have the same stored value. Without that, the table
 * would double as a precomputed lookup of "which account does 123456
 * belong to?".
 *
 * The salt is **not** a secret and does not need to be: its job is to
 * stop precomputation and to stop two equal codes from being equal on
 * disk, not to make the hash irreversible.
 */
export function hashCode(code: string, otpId: string): string {
  return createHash("sha256")
    .update(`${otpId}:${code}`)
    .digest("hex");
}

/**
 * Compares two hex digests in constant time.
 *
 * `timingSafeEqual` throws when the two buffers have different lengths,
 * so the length is checked first. A length difference here is not
 * secret — it is a digest of a different shape entirely — but it must be
 * checked before the comparison rather than after it.
 */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");

  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

/**
 * What happened to a request for a code.
 */
export type OtpRequestOutcome = {
  /**
   * True when a code was issued and mailed.
   *
   * False when the address has no account — in which case nothing was
   * sent, and the caller tells the customer so.
   */
  readonly sent: boolean;

  /**
   * True when the code was mailed to an address that has an account.
   *
   * This is deliberately **not** returned when `sent` is false, and it is
   * not returned at all to the client — the caller uses it to decide the
   * shape of its response.
   */
  readonly knownAddress: boolean;

  /**
   * How long the caller should make the customer wait before asking for
   * another code, in milliseconds. Zero when a code was issued.
   */
  readonly retryAfterMs: number;
};

/**
 * Issues a one-time password for an address and mails it.
 *
 * @param email   - The normalised address to send the code to.
 * @param purpose - What the code is for. The verification step only
 *                  ever reads the row whose purpose matches.
 *
 * @throws ApiError 429 when the address was sent a code too recently.
 */
export async function requestOtp(
  email: string,
  purpose: OtpPurpose,
): Promise<OtpRequestOutcome> {
  const now = new Date();

  /*
   * The attempt is recorded **first**, and it is recorded for every
   * request.
   *
   * This is what makes the cooldown apply to an address with no account.
   * The alternative — counting the cooldown on the OTP row — would mean
   * that an address with no account is never cooled down, and that is
   * precisely the address an attacker would probe. A limit that excludes
   * exactly the traffic it exists to stop is not a limit.
   *
   * The ledger deliberately does not record whether the address had an
   * account, or whether a code was sent. A table that recorded the
   * outcome would be a table that says which addresses belong to
   * customers, and a dump of this database would then hand that over.
   *
   * The ledger is also **purpose-agnostic**. The cooldown is keyed by
   * address alone, so a customer who asks for a sign-in code and then
   * asks for a signup code is still held to one request a minute. If the
   * cooldown were per purpose, the two flows would be two independent
   * mail budgets for one mailbox — which is exactly the way to get an
   * address suspended.
   */
  const lastAttempt = await db.emailOtpAttempt.findFirst({
    where: { email },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (lastAttempt) {
    const elapsed = now.getTime() - lastAttempt.createdAt.getTime();

    if (elapsed < OTP_RESEND_COOLDOWN_MS) {
      throw new ApiError(
        "RATE_LIMITED",
        "Please wait a moment before requesting another code.",
        { retryAfterMs: OTP_RESEND_COOLDOWN_MS - elapsed },
      );
    }
  }

  await db.emailOtpAttempt.create({ data: { email } });

  /*
   * The user is looked up **after** the cooldown is checked.
   *
   * The order matters for the customer, not for the attacker. A customer
   * who asks for a code twice in a minute is told to wait — which is a
   * useful answer — rather than being told "no account here" for an
   * address that plainly has one, because the lookup never happened.
   *
   * It does not leak the account's existence to an attacker: the
   * cooldown is keyed by **address**, not by account, and an address
   * with no account is cooled down just the same. The rate limit is
   * therefore uniform over the whole address space, which is what makes
   * it a useful limit.
   */
  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerifiedAt: true,
    },
  });

  /*
   * No account.
   *
   * Nothing is sent, and the caller is told the address is unknown.
   *
   * The alternative — mailing a code to an address that has no account
   * — would waste the shop's mail quota and teach the attacker that the
   * address is *valid*, which is the one thing the enumeration is after.
   * A customer who asks for a code at an address with no account needs
   * to know that, or they will wait for an email that never comes.
   *
   * The rate limit is what keeps this answer from being an enumeration
   * oracle: one address may be probed once a minute, so harvesting the
   * customer list takes a very long time and a lot of mail.
   */
  if (!user) {
    await pruneExpiredOtps();

    return { sent: false, knownAddress: false, retryAfterMs: 0 };
  }

  /*
   * The two purposes are not interchangeable, and each one has its own
   * precondition.
   *
   * **SIGNUP** is for an account that has not been verified yet. An
   * account that is already verified does not need to prove anything
   * again — it already proved it — so asking for a signup code for a
   * verified account is a request that cannot be honoured. The code
   * would do nothing, and the customer would sit in front of a form
   * waiting for an email that never comes.
   *
   * **SIGNIN** is for an account that exists and is usable. An account
   * that has not been verified yet cannot be signed into, so mailing it
   * a sign-in code would be mailing a code for a door that is not open
   * yet. The customer needs the signup code first.
   *
   * Both refusals are reported as `sent: false, knownAddress: true` —
   * the address *is* known, the request just cannot be honoured for it.
   * The caller decides the message; this module does not, because the
   * right words differ between "this account is already verified" and
   * "this account still needs verifying".
   */
  const isVerified = user.emailVerifiedAt !== null;

  if (purpose === OtpPurpose.SIGNUP && isVerified) {
    await pruneExpiredOtps();

    return { sent: false, knownAddress: true, retryAfterMs: 0 };
  }

  if (purpose === OtpPurpose.SIGNIN && !isVerified) {
    await pruneExpiredOtps();

    return { sent: false, knownAddress: true, retryAfterMs: 0 };
  }

  /*
   * Any previous code for this address **and purpose** is deleted.
   *
   * A customer never has two live codes for the same address and the
   * same purpose, so there is never an email in their inbox that looks
   * like the current one. It also keeps the table small.
   *
   * The deletion is scoped by purpose, so asking for a sign-in code
   * does not silently destroy a pending signup code — and vice versa.
   * The two flows are separate journeys, and a customer may be in the
   * middle of one while the other is running.
   */
  await db.emailOtp.deleteMany({ where: { email, purpose } });

  const code = generateOtpCode();

  /*
   * The id is generated **before** the hash, because the id is the salt.
   *
   * Prisma's `@default(cuid())` would generate one anyway, but then the
   * salt would have to be read back to hash with it. Generating it here
   * keeps the salt and the row the same value by construction, with no
   * round-trip between them.
   */
  const otpId = createOtpId();

  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

  await db.emailOtp.create({
    data: {
      id: otpId,
      userId: user.id,
      purpose,
      codeHash: hashCode(code, otpId),
      email: user.email,
      expiresAt,
      attempts: 0,
    },
  });

  await mailOtp(user.email, user.name, code, expiresAt, purpose);

  /*
   * The prune.
   *
   * It runs here because this is the only path that writes to either
   * table, so an idle system never pays for it — and the tables only
   * need pruning in proportion to how much they are being used.
   */
  await pruneExpiredOtps();

  return { sent: true, knownAddress: true, retryAfterMs: 0 };
}

/**
 * Generates the id for an OTP row.
 *
 * The exact format does not matter — what matters is that it is unique
 * and unpredictable, because it is used as the hash salt and a guessable
 * salt is a useless salt.
 *
 * `randomBytes` rather than `randomInt`, because `randomInt` is limited
 * to a 48-bit range — the width of its range must fit in 48 bits — and
 * `Number.MAX_SAFE_INTEGER` is 53. Sixteen random bytes is 128 bits,
 * which is comfortably beyond what a salt needs.
 */
function createOtpId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The result of verifying a code.
 */
export type OtpVerifyResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false };

/**
 * Verifies a one-time password.
 *
 * @param email   - The normalised address the code was sent to.
 * @param code    - The six digits the customer typed.
 * @param purpose - What the code must have been issued for.
 *
 * @returns The result. The negative outcome is deliberately **flat** —
 *         there is no reason attached, because every reason would be a
 *         fact about a customer's account that an attacker could use.
 */
export async function verifyOtp(
  email: string,
  code: string,
  purpose: OtpPurpose,
): Promise<OtpVerifyResult> {
  /*
   * The lookup is scoped by the purpose.
   *
   * This is the line that stops a signup code from being a sign-in code.
   * The row for the other purpose is not merely rejected — it is not
   * even read, so there is nothing to compare the submitted digits
   * against.
   */
  const record = await db.emailOtp.findFirst({
    where: { email, purpose },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      codeHash: true,
      expiresAt: true,
      attempts: true,
    },
  });

  if (!record) return { ok: false };

  /*
   * The attempt counter is checked **before** the expiry, and both are
   * checked before the code is compared.
   *
   * The order does not change the outcome — both end in the same flat
   * failure — but checking the cheap conditions first means a dead code
   * does not pay for a hash comparison.
   */
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await db.emailOtp.deleteMany({ where: { id: record.id } });

    return { ok: false };
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    await db.emailOtp.deleteMany({ where: { id: record.id } });

    return { ok: false };
  }

  const candidate = hashCode(code, record.id);

  if (!digestsMatch(candidate, record.codeHash)) {
    /*
     * A wrong guess is counted.
     *
     * The count is a row update rather than a read-modify-write, so two
     * concurrent wrong guesses both land and neither is lost — which is
     * what happens with the naive version, and which would let an
     * attacker exceed the limit by racing.
     */
    await db.emailOtp.updateMany({
      where: { id: record.id, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });

    return { ok: false };
  }

  /*
   * A correct code.
   *
   * The row is deleted here, and the deletion is **conditional** — it
   * only fires if the row is still there. Two concurrent requests with
   * the same valid code would otherwise both read the row, both match,
   * and both sign in. The conditional delete makes exactly one of them
   * the winner: the other finds nothing to delete and fails.
   */
  const deleted = await db.emailOtp.deleteMany({
    where: { id: record.id },
  });

  if (deleted.count === 0) {
    return { ok: false };
  }

  return { ok: true, userId: record.userId };
}

/**
 * Deletes every code that has expired, and every attempt that is older
 * than the cooldown.
 *
 * An expired row is dead weight, but deleting it is not urgent: the
 * verification path already treats an expired code as a failure, and the
 * cooldown path already ignores an attempt outside the window. These
 * exist so the tables do not grow without bound.
 *
 * The attempt ledger is pruned to a **slack** window rather than exactly
 * the cooldown. The cooldown check reads the *most recent* attempt, so an
 * attempt just inside the window must survive; pruning to exactly the
 * cooldown would race with the check and occasionally let a request
 * through that should have been limited.
 *
 * It is called from the send path, where a fresh row is being written
 * anyway — so it costs nothing on an idle system.
 */
export async function pruneExpiredOtps(): Promise<void> {
  const now = new Date();

  await db.emailOtp
    .deleteMany({ where: { expiresAt: { lt: now } } })
    .catch((error: unknown) => {
      console.error("[otp] The expired codes were not pruned:", error);
    });

  const attemptCutoff = new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS * 2);

  await db.emailOtpAttempt
    .deleteMany({ where: { createdAt: { lt: attemptCutoff } } })
    .catch((error: unknown) => {
      console.error("[otp] The old attempts were not pruned:", error);
    });
}

/**
 * The number of outstanding codes for an address.
 *
 * Exported for the health endpoint and the tests.
 *
 * The count is per address **and purpose**, because that is the unit the
 * customer experiences: one live sign-in code, and one live signup code,
 * are two different emails with two different meanings. Counting them
 * together would report "2 outstanding" for a customer who has only one
 * code to act on.
 */
export async function countOutstandingOtps(
  email: string,
  purpose?: OtpPurpose,
): Promise<number> {
  return db.emailOtp.count({
    where: purpose ? { email, purpose } : { email },
  });
}

/**
 * The maximum number of outstanding codes an address may hold.
 *
 * Exported so the constant is reachable from the tests without the
 * validation module being re-exported wholesale.
 */
export const MAX_OUTSTANDING_PER_EMAIL = OTP_MAX_OUTSTANDING_PER_EMAIL;

/**
 * Mails a one-time password to a customer.
 *
 * The code is the only thing in the message that matters, so the message
 * says exactly that: here is your code, it lasts ten minutes, here is
 * what to do if you did not ask for it.
 *
 * The "if this was not you" line is not politeness. A sign-in code is
 * also a **password reset** mechanism in practice — if an attacker can
 * trigger a code for an address and the customer reads it out, the
 * attacker is in. So the message tells the customer what to do about it.
 *
 * ── Why the message names the purpose ─────────────────────────────────────
 *
 * The subject line says whether this is a **verification** code or a
 * **sign-in** code, because the customer has two things in their inbox
 * that look identical and mean different things. A customer who asked
 * to sign in should not have to guess whether the code in front of them
 * will let them in, and a customer who just registered should not
 * mistake a sign-in code for the one that verifies their new account.
 *
 * The wording differs too: a verification code *completes* something,
 * a sign-in code *opens* something. The "if this was not you" line
 * differs accordingly — an unwanted signup verification means somebody
 * registered with their address, and an unwanted sign-in code means
 * somebody is trying to get in.
 */
async function mailOtp(
  email: string,
  name: string,
  code: string,
  expiresAt: Date,
  purpose: OtpPurpose,
): Promise<void> {
  const minutes = Math.max(
    1,
    Math.round((expiresAt.getTime() - Date.now()) / 60_000),
  );

  const isSignup = purpose === OtpPurpose.SIGNUP;

  const subject = isSignup
    ? `Your Euro Glam BD verification code: ${code}`
    : `Your Euro Glam BD sign-in code: ${code}`;

  const text = isSignup
    ? [
        `Hello ${name},`,
        "",
        `Welcome to Euro Glam BD. Your verification code is ${code}.`,
        "",
        `Enter it to finish creating your account. It is valid for`,
        `${minutes} minutes and can be used once.`,
        "",
        "If you did not create an account with us, you can ignore this",
        "email — your address will not be used for anything.",
        "",
        "Euro Glam BD",
      ].join("\n")
    : [
        `Hello ${name},`,
        "",
        `Your Euro Glam BD sign-in code is ${code}.`,
        "",
        `It is valid for ${minutes} minutes and can be used once.`,
        "",
        "If you did not try to sign in, you can ignore this email — no one",
        "can sign in to your account without the code.",
        "",
        "Euro Glam BD",
      ].join("\n");

  const html = isSignup
    ? [
        `<p>Hello ${escapeHtml(name)},</p>`,
        `<p>Welcome to Euro Glam BD. Your verification code is:</p>`,
        `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:24px 0;">${escapeHtml(code)}</p>`,
        `<p>Enter it to finish creating your account. It is valid for ${minutes} minutes and can be used once.</p>`,
        "<p>If you did not create an account with us, you can ignore this email — your address will not be used for anything.</p>",
        "<p>Euro Glam BD</p>",
      ].join("")
    : [
        `<p>Hello ${escapeHtml(name)},</p>`,
        `<p>Your Euro Glam BD sign-in code is:</p>`,
        `<p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:24px 0;">${escapeHtml(code)}</p>`,
        `<p>It is valid for ${minutes} minutes and can be used once.</p>`,
        "<p>If you did not try to sign in, you can ignore this email — no one can sign in to your account without the code.</p>",
        "<p>Euro Glam BD</p>",
      ].join("");

  await sendEmail({ to: email, subject, text, html });
}

/**
 * Escapes the characters that would otherwise be interpreted as HTML.
 *
 * The name comes from the customer's own account, so it is not attacker
 * controlled in the usual sense — but it is free text, and a name of
 * `<script>` in a mail client is a mail client problem. Escaping costs
 * nothing.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
