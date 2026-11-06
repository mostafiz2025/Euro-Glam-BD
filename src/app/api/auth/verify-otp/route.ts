import { OtpPurpose } from "@prisma/client";
import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { signToken } from "@/lib/auth/jwt";
import { verifyOtp } from "@/lib/auth/otp";
import { setSessionCookie } from "@/lib/auth/session";
import { verifySignupOtp } from "@/lib/auth/verification";
import { db } from "@/lib/db";
import { verifyOtpSchema } from "@/lib/validation/otp";

/**
 * POST /api/auth/verify-otp
 *
 * Validates a one-time password and issues a session cookie.
 *
 * ── The rule that governs this route ──────────────────────────────────────
 *
 * **Every failure is the same failure.**
 *
 * A mistyped code, an expired code, a code that was never issued, a code
 * that has already been used, a code that has run out of attempts, and a
 * code issued for the *other* purpose all produce one answer: `401`, with
 * the same message, and no details.
 *
 * If they produced different answers, the endpoint would tell an attacker
 * how close they were. "This code exists but has expired" is a fact about
 * a customer's account; "this code has five attempts left" is an
 * invitation to try them. So the negative answer carries no reason, and
 * the code is deleted rather than flagged — a verified code is worth
 * nothing, and keeping it around only widens the window in which a
 * leaked hash is useful.
 *
 * ── Why the code is single-use ────────────────────────────────────────────
 *
 * The deletion that marks a code as used is **conditional**: it only
 * fires if the row is still there. Two concurrent requests carrying the
 * same valid code would otherwise both read the row, both match, and
 * both sign in. The conditional delete makes exactly one of them the
 * winner.
 *
 * ── The two purposes ──────────────────────────────────────────────────────
 *
 * The body carries a `purpose`, and the two are separate journeys:
 *
 *   • **SIGNUP** — the code proves the customer owns the inbox they
 *     registered with. The account is marked verified, and the session
 *     is issued. This is the step that turns a new account into a usable
 *     one.
 *
 *   • **SIGNIN** — the code replaces the password for an account that
 *     already exists and is already verified. Nothing about the account
 *     changes.
 *
 * A signup code is **not** a sign-in code. The lookup inside `verifyOtp`
 * filters on the purpose, so the row issued for the other journey is not
 * merely rejected — it is never read.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route writes a session cookie.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    const body = verifyOtpSchema.parse(await request.json());

    const purpose = body.purpose as OtpPurpose;

    /**
     * The two purposes are verified by different services.
     *
     * A signup code does two things: it proves the code is right, and it
     * marks the account verified. A sign-in code only does the first.
     * Running them through the same service would mean one of the two
     * behaviours was optional, and an optional behaviour is one that
     * eventually stops happening.
     */
    const result =
      purpose === OtpPurpose.SIGNUP
        ? await verifySignupOtp(body.email, body.code)
        : await verifyOtp(body.email, body.code, purpose);

    if (!result.ok) {
      throw ApiError.unauthenticated(
        "That code is not valid. Please request a new one.",
      );
    }

    /**
     * The account is re-read from the database.
     *
     * The token's claims must describe the account **as it is now** — the
     * customer may have been deleted, or had their name changed, between
     * the code being issued and the code being verified. The OTP row
     * carries a user id and nothing else; it is not a session.
     *
     * The verification state is read here too, and it is the **last**
     * check before a session is minted. A sign-in code is only ever
     * issued to a verified account, so an unverified account reaching
     * this point means something is wrong — and the session is refused
     * rather than issued.
     */
    const user = await db.user.findUnique({
      where: { id: result.userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        smsOptIn: true,
        emailVerifiedAt: true,
      },
    });

    if (!user) {
      throw ApiError.unauthenticated(
        "That code is not valid. Please request a new one.",
      );
    }

    /*
     * The final gate.
     *
     * A sign-in code for an unverified account is refused here, even
     * though the code itself was correct. The account has not proved it
     * owns the inbox, and a session for it would be a session for an
     * address the shop cannot reach.
     */
    if (user.emailVerifiedAt === null) {
      throw ApiError.forbidden(
        "Please verify your email address before you continue.",
      );
    }

    const token = await signToken({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });

    await setSessionCookie(token);

    return ok({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        smsOptIn: user.smsOptIn,
        emailVerified: true,
      },
      ...("firstVerification" in result && result.firstVerification
        ? { firstVerification: true }
        : {}),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
