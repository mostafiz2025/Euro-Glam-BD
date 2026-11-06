import { OtpPurpose } from "@prisma/client";
import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requestOtp } from "@/lib/auth/otp";
import { EmailError } from "@/lib/email";
import { sendOtpSchema } from "@/lib/validation/otp";

/**
 * POST /api/auth/send-otp
 *
 * Issues a six-digit one-time password and mails it to the address.
 *
 * ── The rule that governs this route ──────────────────────────────────────
 *
 * **A missing mail configuration is a hard failure, and it is said out
 * loud.**
 *
 * The SMS gateway writes to a table instead of sending, so a developer
 * never messages a real customer by accident. That is the right default
 * for SMS and the wrong default for email, because the email carries
 * the one-time password. An email that is silently dropped is not a
 * degraded experience — it is a sign-in that appears to work and then
 * does not.
 *
 * So there is no mock driver. When the transport cannot be built, this
 * route answers `503` and says exactly that. A deployment that cannot
 * send email must not look healthy while delivering nothing.
 *
 * ── What the response says ────────────────────────────────────────────────
 *
 * The response distinguishes an address with an account from one
 * without, because a customer who asked for a code at an address the
 * shop does not know needs to be told so — otherwise they sit in front of
 * a form waiting for an email that will never arrive.
 *
 * The cost of that distinction is an enumeration oracle, and it is paid
 * down by the **rate limit**: one address may be probed once a minute,
 * and the limit is counted from the database so it holds across every
 * instance of the deployment.
 *
 * ── The two purposes ──────────────────────────────────────────────────────
 *
 * The body carries a `purpose`:
 *
 *   • `SIGNIN` (the default) — the customer is signing in to an account
 *     that already exists and has already been verified.
 *
 *   • `SIGNUP` — the customer has just registered and needs to prove
 *     they own the inbox they registered with.
 *
 * The two are separate credentials and the codes do not cross over. A
 * signup code is not a sign-in code, so the response for one is not
 * interchangeable with the response for the other.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route sends an email.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    const body = sendOtpSchema.parse(await request.json());

    const purpose = body.purpose as OtpPurpose;

    const outcome = await requestOtp(body.email, purpose);

    if (!outcome.sent && !outcome.knownAddress) {
      /**
       * No account at this address.
       *
       * A `404` rather than a `200` with a false promise: the customer
       * asked for a code, no code is coming, and silence would leave them
       * waiting. The rate limit is what keeps this answer from being a
       * cheap enumeration oracle.
       */
      throw ApiError.notFound(
        "We could not find an account with that email address.",
      );
    }

    if (!outcome.sent) {
      /*
       * The account exists, but this code cannot be issued for it.
       *
       * Two cases, and they need different words:
       *
       *   • A **signup** code for an account that is already verified.
       *     There is nothing to prove — the account proved it when it
       *     was created.
       *
       *   • A **sign-in** code for an account that has not been
       *     verified. The customer needs to finish verifying first; a
       *     sign-in code would be a key to a door that is not open.
       */
      if (purpose === OtpPurpose.SIGNUP) {
        throw ApiError.conflict(
          "That email address is already verified. You can sign in instead.",
        );
      }

      throw ApiError.conflict(
        "Please verify your email address before signing in.",
      );
    }

    return ok({
      sent: true,
      expiresInSeconds: Math.round(outcome.retryAfterMs / 1000),
    });
  } catch (error) {
    /**
     * The mail server is not configured, or the message was refused.
     *
     * This is translated into a `503` here rather than in `handleApiError`
     * because it is a **deployment** problem, not a request problem: the
     * request was fine, the shop is not. The client cannot fix it, and
     * saying so is more useful than a generic 500.
     *
     * Both codes are a `503`, and they are the same code for the client:
     *
     *   • `NOT_CONFIGURED` — the shop has no mail credentials. A
     *     configuration fault, and the operator needs to see it in the
     *     log.
     *
     *   • `SEND_FAILED` — the message was refused by the server. This
     *     one is transient and worth retrying, so the customer is told
     *     to try again shortly.
     *
     * They are not collapsed into a generic 500, because a 500 says
     * "the shop has a bug" and neither of these is a bug.
     */
    if (error instanceof EmailError) {
      console.error("[auth] The sign-in code could not be sent:", error);

      return handleApiError(
        new ApiError(
          "SERVICE_UNAVAILABLE",
          error.code === "NOT_CONFIGURED"
            ? "Sign-in by email is not available at the moment. Please try again later."
            : "The sign-in code could not be sent. Please try again shortly.",
        ),
      );
    }

    return handleApiError(error);
  }
}
