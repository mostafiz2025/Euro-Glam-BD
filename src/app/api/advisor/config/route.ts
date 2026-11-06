import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireUser } from "@/lib/auth/guards";
import { loadDisclaimer } from "@/lib/ai/disclaimer";

/**
 * GET /api/advisor/config
 *
 * The disclaimer the client must show, plus the metadata the chat UI
 * needs before the first message arrives.
 *
 * ── Why this route exists ────────────────────────────────────────────────
 *
 * The disclaimer is **non-dismissible** and must be visible during the
 * chat session (PRD §3.A). The client needs it *before* the first
 * message, so the banner can render on the empty state — not only once
 * an answer arrives. That is what this route is for.
 *
 * The disclaimer is loaded through `loadDisclaimer()`, which is the same
 * function the service layer uses. There is exactly one source of truth:
 * the admin-managed text when it exists, the hardcoded fallback when it
 * does not. A second, separate lookup here would be a place for the
 * banner and the message to disagree.
 */
export async function GET(): Promise<Response> {
  await connection();

  try {
    // A session is required — the advisor is a signed-in feature. But no
    // admin role: this is the customer's own view of the disclaimer.
    const user = await requireUser();

    const disclaimer = await loadDisclaimer();

    return ok({
      disclaimer,
      user: { id: user.id, name: user.name },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
