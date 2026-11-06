import { connection } from "next/server";

import { getAdminProfile, updateAdminProfile } from "@/lib/admin/profile";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { adminProfileUpdateSchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/settings/profile
 *
 * The signed-in administrator's own profile.
 *
 * The id is taken from the **session**, not from the request. A profile
 * endpoint that accepted an id in the query string would let any admin
 * read any other admin's row — and this route's whole purpose is to
 * describe the caller.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // `connection()` MUST be called outside the try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const profile = await getAdminProfile(admin.id);

    return ok({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/settings/profile
 *
 * A **partial** update: every field is optional, and a field that is
 * absent is left exactly as it was.
 *
 * The client sends only the fields the admin touched, so correcting a
 * typo in the name cannot silently blank the phone number the form
 * happened to be holding.
 *
 * ── What cannot be changed here ───────────────────────────────────────────
 *
 *   • The **email address** — that is the account's identity, and the
 *     shop owns a verification flow for it. The reasoning is in
 *     `src/lib/admin/profile.ts`.
 *   • The **role** — a privilege grant is somebody else's decision.
 *   • The **SMS consent** — that is a decision about being messaged, not
 *     about what number to be messaged at.
 *
 * None of the three is in the request schema, so none of the three can
 * reach the service even if a client sends them.
 */
export async function PATCH(request: Request): Promise<Response> {
  await connection();

  try {
    const admin = await requireAdmin();

    const body: unknown = await request.json();
    const input = adminProfileUpdateSchema.parse(body);

    /*
     * Only the two editable fields are forwarded.
     *
     * The schema declares the forbidden keys so it can *refuse* them —
     * a Zod object that does not mention a key strips it in silence, and
     * a silently-stripped `role` would be a request that reported
     * success while changing nothing. So the parsed body carries them,
     * and the pick below is what makes sure they never reach the
     * service.
     */
    const patch: {
      name?: string;
      phone?: string | null;
    } = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined
        ? { phone: input.phone === "" ? null : input.phone }
        : {}),
    };

    // An empty patch would write nothing. Refusing it is better than
    // returning a 200 that appears to have done something.
    if (Object.keys(patch).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const profile = await updateAdminProfile(
      { id: admin.id, name: admin.name, email: admin.email },
      patch,
    );

    return ok({ profile });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
