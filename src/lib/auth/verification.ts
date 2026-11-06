import { OtpPurpose } from "@prisma/client";

import { db } from "@/lib/db";
import { verifyOtp } from "@/lib/auth/otp";

/**
 * The account-verification service.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * A new account is created **unverified**. The customer is mailed a
 * six-digit code, and the account becomes usable when the code comes
 * back.
 *
 * ── The rule that governs this file ───────────────────────────────────────
 *
 * **An account may only be used once its inbox is proved.**
 *
 * The whole point of the verification step is that the shop can reach
 * the customer. An account registered at somebody else's address — a
 * typo, or an address harvested from a forum — would receive the
 * customer's order confirmations, their SMS alerts, and their one-time
 * passwords. Verification is what makes those channels safe to open.
 *
 * So an unverified account is not merely "not yet signed in". It is an
 * account that **does not work**: it cannot sign in with a password, it
 * cannot sign in with a code, and it cannot place an order. The check
 * is made at the point where the session is issued — the password login
 * route and the OTP verification route both refuse to mint a session
 * for an account whose `emailVerifiedAt` is still null — which is the
 * only place that matters, because a session that was never issued
 * cannot be used.
 *
 * ── The rule that governs the order of operations ─────────────────────────
 *
 * **The account is marked verified before the session is minted.**
 *
 * The code is verified first (the credential is checked), then the
 * account is marked verified, then the caller mints the session. If the
 * verification write fails, no session is issued — so there is never a
 * live session for an account the database still believes is
 * unverified.
 *
 * The reverse order would be the bug: marking the account verified and
 * *then* failing to write the session cookie would leave a customer
 * whose account says "verified" but who is still locked out, with no
 * way to tell the shop about it.
 */

/**
 * The outcome of a verification attempt.
 */
export type VerificationOutcome =
  | {
      readonly ok: true;
      readonly userId: string;
      /** True when this verification is what made the account usable. */
      readonly firstVerification: boolean;
    }
  | { readonly ok: false };

/**
 * Verifies a signup code and marks the account verified.
 *
 * ── Why this is separate from `verifyOtp` ─────────────────────────────────
 *
 * `verifyOtp` answers "is this code correct?". This answers "is this
 * code correct **and** is it the code that verifies this account?".
 *
 * The second question matters. A signup code that is correct but belongs
 * to an account that is *already* verified would otherwise be a way to
 * re-verify an account — which sounds harmless, but it would also issue
 * a session to whoever presented the code, and the code may have been
 * intercepted weeks ago.
 *
 * @param email - The normalised address the code was sent to.
 * @param code  - The six digits the customer typed.
 *
 * @returns The result. The negative outcome is **flat**, for the same
 *         reason every other verification failure is flat: a reason
 *         would be a fact about the account.
 */
export async function verifySignupOtp(
  email: string,
  code: string,
): Promise<VerificationOutcome> {
  const result = await verifyOtp(email, code, OtpPurpose.SIGNUP);

  if (!result.ok) {
    return { ok: false };
  }

  /*
   * The account is re-read.
   *
   * Between the code being issued and the code being verified, the
   * account may have been deleted, or — more likely — already verified
   * by another request carrying the same code. The conditional write
   * below is what settles that race: only one request can be the one
   * that sets the timestamp.
   */
  const user = await db.user.findUnique({
    where: { id: result.userId },
    select: { id: true, emailVerifiedAt: true },
  });

  if (!user) {
    return { ok: false };
  }

  /*
   * An already-verified account is not re-verified.
   *
   * The session is still issued — the customer proved they own the
   * inbox, and they are signing in, which is a legitimate thing to do.
   * But the account's state is not touched, and the answer says so, so
   * the caller can tell "you just verified this account" from "this
   * account was already verified".
   */
  if (user.emailVerifiedAt !== null) {
    return { ok: true, userId: user.id, firstVerification: false };
  }

  /*
   * The conditional write.
   *
   * `emailVerifiedAt: null` in the `where` clause means "only if it is
   * still null". Two concurrent requests carrying the same valid code
   * would otherwise both find the account unverified and both write a
   * timestamp. The conditional update makes exactly one of them the
   * writer; the other finds nothing to update and is told the account
   * was already verified.
   *
   * It is the same shape as the conditional delete that marks a code as
   * used, and for the same reason: the credential is single-use, and the
   * database is the only place that can enforce that under concurrency.
   */
  const updated = await db.user.updateMany({
    where: { id: user.id, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });

  if (updated.count === 0) {
    // Somebody else verified it between the read and the write.
    return { ok: true, userId: user.id, firstVerification: false };
  }

  return { ok: true, userId: user.id, firstVerification: true };
}
