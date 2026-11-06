import { connection } from "next/server";

import {
  getCustomerProfile,
  updateCustomerProfile,
} from "@/lib/account/profile";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { customerProfileUpdateSchema } from "@/lib/validation/account";

/**
 * GET /api/account/profile
 *
 * The signed-in customer's own profile.
 *
 * The id is taken from the **session**, not from the request. A profile
 * endpoint that accepted an id in the query string would let any customer
 * read any other customer's row — and this route's whole purpose is to
 * describe the caller.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    const customer = await requireCustomer();

    const profile = await getCustomerProfile(customer.id);

    return ok({ profile });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/account/profile
 *
 * A **partial** update: every field is optional, and a field that is
 * absent is left exactly as it was.
 *
 * The client sends only the fields the customer touched, so correcting a
 * typo in the name cannot silently blank the phone number the form
 * happened to be holding.
 *
 * ── What cannot be changed here ───────────────────────────────────────────
 *
 *   • The **email address** — that is the account's identity, and the
 *     shop owns a verification flow for it. The reasoning is in
 *     `src/lib/validation/account.ts`.
 *   • The **role** — a privilege grant is somebody else's decision.
 *   • The **SMS consent** — that is a decision about being messaged, not
 *     about what number to be messaged at.
 *
 * None of the three is in the request schema, so none of the three can
 * reach the service even if a client sends them.
 *
 * ── The password is not changed here either ───────────────────────────────
 *
 * It has its own route (`/api/account/password`), because a password
 * change has to ask for the current password and the shop has to hash
 * the new one. Folding it into the profile patch would mean the
 * "current password" field and the "new password" field would sit
 * beside the name and the phone number in one body, and a form that
 * held both would be a form that could save a password change it never
 * asked for.
 */
export async function PATCH(request: Request): Promise<Response> {
  await connection();

  try {
    const customer = await requireCustomer();

    const body: unknown = await request.json();
    const input = customerProfileUpdateSchema.parse(body);

    /*
     * Only the three editable fields are forwarded.
     *
     * The schema declares the forbidden keys so it can *refuse* them —
     * a Zod object that does not mention a key strips it in silence, and
     * a silently-stripped `email` would be a request that reported
     * success while changing nothing. So the parsed body carries them,
     * and the pick below is what makes sure they never reach the
     * service.
     */
    const patch: {
      name?: string;
      phone?: string | null;
      address?: {
        fullName: string;
        phone: string;
        addressLine1: string;
        addressLine2?: string;
        city: string;
        district: string;
        postalCode: string;
        isDefault: boolean;
      } | null;
    } = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined
        ? { phone: input.phone === "" ? null : input.phone }
        : {}),
      ...(input.address !== undefined
        ? { address: input.address === null ? null : input.address }
        : {}),
    };

    // An empty patch would write nothing. Refusing it is better than
    // returning a 200 that appears to have done something.
    if (Object.keys(patch).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const profile = await updateCustomerProfile(customer.id, patch);

    return ok({ profile });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
