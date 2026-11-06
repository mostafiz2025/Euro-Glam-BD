import { connection } from "next/server";

import { listAdminUsers } from "@/lib/admin/users";
import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { adminUserQuerySchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/users
 *
 * The admin user list.
 *
 * ── Read-only, on purpose ────────────────────────────────────────────────
 *
 * There is no `PUT` or `PATCH` here, and there is deliberately no
 * `role` filter either. Every mutating admin action in this codebase is
 * audited; a user-edit path would be the only un-audited mutation, and
 * it would carry obvious abuse potential:
 *
 *   • **Role elevation.** Promoting a customer to `ADMIN` is a
 *     privilege grant, and privilege grants are exactly what an audit
 *     trail exists to record.
 *   • **Consent flipping.** `User.smsOptIn` is the *only* flag that
 *     authorises an SMS send. An admin who could flip it could message
 *     a customer who never consented.
 *   • **Contact harvesting.** A phone number is personal data.
 *
 * So the Users page reports. If editing is wanted later, it is a
 * separate, audited decision — not a side effect of a "Users" page.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    await requireAdmin();

    const url = new URL(request.url);

    // An unrecognised filter is an error, not a default — see the note
    // at the top of `src/lib/validation/admin.ts`.
    const query = adminUserQuerySchema.parse(
      Object.fromEntries(url.searchParams.entries()),
    );

    const result = await listAdminUsers(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
