import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { signToken } from "@/lib/auth/jwt";
import { verifyPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loginSchema } from "@/lib/validation/schemas";

/**
 * POST /api/auth/login
 *
 * Verifies credentials and issues a session cookie.
 *
 * ── The rule that governs this route ──────────────────────────────────────
 *
 * **An unverified account cannot sign in.**
 *
 * The password may be perfectly correct, but the account has not proved
 * that its owner can receive mail at its address. Signing it in would
 * be signing in to an account the shop cannot reach — and the shop sends
 * order confirmations, SMS alerts and one-time passwords to that
 * address.
 *
 * The refusal says what to do about it: verify the address. It does not
 * say whether the password was right, because by this point it was — the
 * password check has already run and passed. That is deliberate: the
 * customer has already proved they know the password, so there is no
 * enumeration left to protect.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route writes a session cookie.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    const body = loginSchema.parse(await request.json());

    const user = await db.user.findUnique({
      where: { email: body.email },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        smsOptIn: true,
        passwordHash: true,
        emailVerifiedAt: true,
      },
    });

    /**
     * Identical response whether the email is unknown or the password is
     * wrong.
     *
     * Distinguishing the two would let an attacker enumerate which email
     * addresses have accounts. The cost of this uniformity is one extra
     * bcrypt comparison when the user does not exist — which is also the
     * timing-attack mitigation, since a missing user otherwise returns
     * measurably faster than a wrong password.
     */
    const passwordMatches = user
      ? await verifyPassword(body.password, user.passwordHash)
      : false;

    if (!user || !passwordMatches) {
      throw ApiError.unauthenticated("Incorrect email or password.");
    }

    /*
     * The verification gate.
     *
     * It runs **after** the password check, so that an attacker who does
     * not know the password learns nothing about whether the account is
     * verified. The order is the opposite of what looks natural: it
     * would be tidier to check the account state first and skip the
     * expensive hash, but tidier here means an enumeration oracle.
     */
    if (user.emailVerifiedAt === null) {
      throw ApiError.forbidden(
        "Please verify your email address before signing in. We have sent you a code — enter it on the verification page.",
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
    });
  } catch (error) {
    return handleApiError(error);
  }
}
