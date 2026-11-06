import { z } from "zod";

/**
 * The email sign-in vocabulary.
 *
 * ── Why a separate file ───────────────────────────────────────────────────
 *
 * The OTP flow is a **public** sign-in path: it is reached by people who
 * are not yet signed in, and it is the only way in for a customer who has
 * no password. It is validated at a different boundary than the rest of
 * the auth vocabulary, and it carries constraints that only make sense
 * for a credential that is mailed out.
 *
 * ── The rule that governs this file ───────────────────────────────────────
 *
 * **A code that is issued is a credential, and it is bounded tightly.**
 *
 * The endpoint is public and it is a **search** over a space of a
 * million six-digit codes. So the code is short-lived, attempt-limited,
 * and the *issuing* endpoint is rate-limited separately from the
 * *verifying* one. The limits are constants rather than configuration,
 * because a limit that an operator can turn off by editing an environment
 * variable is not a limit.
 */

/**
 * The number of digits in a one-time password.
 *
 * Six is the number that customers already recognise from every other
 * bank and OTP in the world, and it is short enough to type on a phone
 * without a keyboard. It is also long enough that the space is a million
 * values — which is only safe because of the attempt limit, the expiry,
 * and the resend cooldown.
 */
export const OTP_LENGTH = 6;

/**
 * How long a code stays valid, in milliseconds.
 *
 * Ten minutes. Long enough for a customer to finish checking their other
 * messages, to find the email, and to type the code; short enough that a
 * code sitting unread in an inbox is not useful much later.
 *
 * The expiry is stored as an absolute instant on the row, so it survives
 * a restart and cannot drift if this constant is ever changed.
 */
export const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * How many wrong guesses a single code tolerates.
 *
 * Five. A million possible codes, five guesses, ten minutes: a brute
 * force has a success probability of one in two hundred thousand per
 * code, and the code is gone after ten minutes anyway.
 *
 * The counter lives on the row rather than in memory, so it is shared
 * across every instance of the deployment — a process-local counter
 * would be reset on every restart and would not be shared between
 * instances, which is exactly when a cap is needed.
 */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * The shortest gap between two codes sent to the same address.
 *
 * Sixty seconds. It stops the endpoint being used to mail the shop's
 * address a hundred messages a minute — which is both a way to annoy a
 * customer and a way to get the shop's mail domain suspended.
 *
 * It is also the right shape for the customer: a code that arrives while
 * the previous one is still in the inbox is a code the customer cannot
 * tell apart from the previous one.
 */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * How many codes one address may have outstanding.
 *
 * One. Issuing a new code invalidates the old one, so a customer never
 * has two live codes for the same address and never has to work out
 * which of the two emails in their inbox is the current one.
 */
export const OTP_MAX_OUTSTANDING_PER_EMAIL = 1;

/**
 * The email address a code is requested for.
 *
 * The same normalisation as the rest of the application — trimmed and
 * lowercased — so that "User@Example.com" and "user@example.com" cannot
 * become two different mailboxes with two different codes.
 */
export const otpEmailSchema = z
  .string()
  .trim()
  .min(1, "Email is required.")
  .max(255, "Email is too long.")
  .email("Enter a valid email address.")
  .transform((value) => value.toLowerCase());

/**
 * The code, as the customer types it.
 *
 * Digits only. The pattern is deliberately loose about *how* it is typed:
 * spaces are stripped by the transform, because a code copied out of an
 * email often comes with a space in it, and a customer who is told
 * "invalid code" for a code they typed correctly will be left unable to
 * sign in.
 *
 * The length is fixed, and the character class is digits — nothing else
 * can be accepted, because the code is compared against a hash of six
 * digits and anything else is a guaranteed failure.
 *
 * The shape is checked with `refine` rather than `regex` because the
 * transform that strips the spaces runs first, and `regex` is not
 * available on the pipe a transform produces.
 */
export const otpCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s+/g, ""))
  .refine(
    (value) => /^\d{6}$/.test(value),
    "Enter the six-digit code from the email.",
  );

/**
 * What a code is for.
 *
 * ── Why this is part of the request rather than implied by it ─────────────
 *
 * The shop mails a six-digit code for two different jobs, and they are
 * different credentials:
 *
 *   • **SIGNUP** — proving the person registering owns the inbox they
 *     registered with. The account is created unverified and becomes
 *     usable when the code comes back.
 *
 *   • **SIGNIN** — letting an existing customer sign in without a
 *     password.
 *
 * A code issued for one must not work for the other, or an intercepted
 * verification mail becomes a valid sign-in code for an account that was
 * never verified.
 *
 * The purpose is therefore carried on the request and stored on the row,
 * and the verification only ever reads the row whose purpose matches.
 *
 * ── Why it has a default ──────────────────────────────────────────────────
 *
 * The sign-in flow is the one that existed first, and the one a
 * bookmarked or shared link is most likely to be. Defaulting to `SIGNIN`
 * means an older client that does not send the field still works, and
 * still gets a sign-in code — never a signup code, which would be the
 * dangerous direction to fall back to.
 *
 * `SIGNUP` is only reachable by asking for it explicitly.
 */
export const otpPurposeSchema = z
  .enum(["SIGNUP", "SIGNIN"])
  .default("SIGNIN");

/**
 * The body of a request to send a code.
 */
export const sendOtpSchema = z.object({
  email: otpEmailSchema,
  purpose: otpPurposeSchema,
});

/**
 * The body of a request to verify a code.
 */
export const verifyOtpSchema = z.object({
  email: otpEmailSchema,
  code: otpCodeSchema,
  purpose: otpPurposeSchema,
});

export type SendOtpInput = z.infer<typeof sendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type OtpPurposeInput = z.infer<typeof otpPurposeSchema>;
