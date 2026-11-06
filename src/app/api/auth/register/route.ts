import { OtpPurpose, UserRole } from "@prisma/client";
import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { created } from "@/lib/api/respond";
import { hashPassword } from "@/lib/auth/password";
import { requestOtp } from "@/lib/auth/otp";
import { db } from "@/lib/db";
import { registerSchema } from "@/lib/validation/schemas";

/**
 * POST /api/auth/register
 *
 * Creates a customer account and mails a verification code.
 *
 * ── The rule that governs this route ──────────────────────────────────────
 *
 * **Registration does not sign you in. Verification does.**
 *
 * The account is created with `emailVerifiedAt: null`, a six-digit code
 * is mailed to the address, and the response says the account is waiting
 * for that code. No session cookie is issued.
 *
 * The reason is that registration proves almost nothing. It proves the
 * person typing can reach an inbox — but only if they can read the mail
 * that is about to arrive. A mistyped address, an address belonging to
 * somebody else, an address harvested from a forum: each of those
 * produces an account that receives the customer's order confirmations
 * and their one-time passwords, and none of them is the customer.
 *
 * Issuing a session here would make the shop believe it can reach the
 * customer when it cannot. The verification step is where that belief is
 * earned.
 *
 * ── Why the account is created even when the mail fails ───────────────────
 *
 * If the mail cannot be sent, the account still exists, and the customer
 * is told to try again. The alternative — deleting the account when the
 * mail fails — would mean a customer whose mail server had a bad minute
 * loses their account and their address, and has to start again.
 *
 * The account is inert without verification, so leaving it in place costs
 * nothing and saves the customer the trouble.
 *
 * ── Why the role is never read from the request ───────────────────────────
 *
 * The new user is ALWAYS created with the CUSTOMER role. The role is not
 * accepted from the request body — otherwise anyone could self-register as
 * an admin by posting `{"role": "ADMIN"}`.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route writes to the database.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    const body = registerSchema.parse(await request.json());

    // Reject a duplicate email before doing the expensive hash. The unique
    // index is the real guarantee; this check just avoids wasted work and
    // gives a clearer error.
    const existing = await db.user.findUnique({
      where: { email: body.email },
      select: { id: true },
    });

    if (existing) {
      throw ApiError.conflict(
        "An account with that email already exists.",
      );
    }

    const passwordHash = await hashPassword(body.password);

    const user = await db.user.create({
      data: {
        name: body.name,
        email: body.email,
        phone: body.phone ?? null,
        passwordHash,
        role: UserRole.CUSTOMER,
        smsOptIn: body.smsOptIn,
        // The account is unverified. The verification code is what sets
        // this, and only a code mailed to this address can set it.
        emailVerifiedAt: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        smsOptIn: true,
      },
    });

    // Create an empty skin profile so the advisor has somewhere to write.
    await db.userSkinProfile.create({
      data: { userId: user.id },
    });

    /*
     * The verification code.
     *
     * It is issued *after* the account exists, because the code is a
     * row that points at the account. The order cannot be reversed — an
     * account has to exist before there is anything to verify.
     *
     * A failure here does not undo the registration. The account is
     * inert until it is verified, so a customer whose mail server had a
     * bad minute can simply ask for another code, rather than having
     * lost their account and their address.
     */
    let verificationSent = false;

    try {
      const outcome = await requestOtp(user.email, OtpPurpose.SIGNUP);

      verificationSent = outcome.sent;
    } catch (error) {
      console.error(
        "[auth] The verification code could not be sent for a new account:",
        error,
      );
    }

    /*
     * No session cookie is set.
     *
     * The account exists and is waiting for a code. The client shows the
     * code entry step, and the session is issued by `verify-otp` once
     * the code comes back.
     */
    return created({
      user: {
        ...user,
        emailVerified: false,
      },
      verificationSent,
      /**
       * The client is told to go and verify, and where.
       *
       * It is told the *email*, so the code box can show the customer
       * which inbox to look in. The address is the customer's own — it
       * is the one they just typed — so saying it back is not a leak.
       */
      message:
        "Your account has been created. Enter the six-digit code we emailed you to finish setting it up.",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
