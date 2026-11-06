import { connection } from "next/server";

import { changeCustomerPassword } from "@/lib/account/profile";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { customerPasswordChangeSchema } from "@/lib/validation/account";

/**
 * POST /api/account/password
 *
 * Changes the signed-in customer's password.
 *
 * ── Why this is a POST and not a PATCH ────────────────────────────────────
 *
 * Because it is not a **partial update of the profile** — it is an
 * action with its own preconditions and its own failure mode. It has to
 * be tried against the stored hash, and it can fail in a way a profile
 * patch cannot ("your current password is not correct"). Folding it into
 * `PATCH /api/account/profile` would mean a body carrying `currentPassword`
 * and `newPassword` sat beside `name` and `phone`, and a form that held
 * both would be a form that could save a password change it never asked
 * for.
 *
 * ── Why the current password is required ──────────────────────────────────
 *
 * A password change that does not ask for the current password lets
 * anybody who walks up to an unlocked device change the password and
 * lock the real owner out. The current password is the proof that the
 * person making the request is the person who owns the account — and it
 * is what stops a shared shop counter or a family laptop from being a
 * permanent takeover.
 *
 * ── What the route will not do ─────────────────────────────────────────────
 *
 * It will not change the password of anybody else. The id comes from the
 * session, and the schema refuses an `id`, an `email` or a `userId` in
 * the body.
 *
 * ── What it deliberately does not do ──────────────────────────────────────
 *
 * It does not sign the customer out of the device they are using. They
 * are already signed in there, and changing their own password is a
 * deliberate act on their own account; signing them out of the very
 * screen they are using would be an odd reward for a security action.
 *
 * It also does not email anybody. The shop has no "your password was
 * changed" notification, and adding one would be a new feature with a
 * new failure mode — a mail that fails to send on a password change is
 * a good way to make a customer think their account was attacked.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  try {
    const customer = await requireCustomer();

    const body: unknown = await request.json();
    const input = customerPasswordChangeSchema.parse(body);

    await changeCustomerPassword(
      customer.id,
      input.currentPassword,
      input.newPassword,
    );

    return ok({
      changed: true,
      message: "Your password has been changed.",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
