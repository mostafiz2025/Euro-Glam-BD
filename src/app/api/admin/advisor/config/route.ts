import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { getAiConfig, updateAiConfig } from "@/lib/admin/ai-config";
import { toAuditActor } from "@/lib/admin/audit";
import { updateAdvisorConfigSchema } from "@/lib/validation/advisor";

/**
 * GET /api/admin/advisor/config
 *
 * A minimal admin-only route. It exists to prove the authorisation chain
 * end to end: an unauthenticated request is rejected at the middleware,
 * a customer is rejected with 403, and an admin gets the data.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    // The proxy already rejected non-admins, but the guard re-checks
    // against the database. Never rely on the proxy alone.
    const admin = await requireAdmin();

    const config = await getAiConfig();

    return ok({
      admin: { id: admin.id, email: admin.email },
      config,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PUT /api/admin/advisor/config
 *
 * Updates the advisor configuration: the disclaimer, the product
 * allow-list, the system prompt override, and the cart-conflict switch.
 *
 * ── The write is audited, in the same transaction as the change ─────────
 *
 * This route used to call a bare `upsert`. It was the only mutating
 * admin action in the codebase with no audit trail, and the thing it
 * changes is *compliance text* — the advisor's disclaimer, shown to
 * every customer during a conversation. "Who changed it, from what, to
 * what" is exactly the question an audit exists to answer.
 *
 * The write now lives in `src/lib/admin/ai-config.ts`, where it shares
 * a transaction with its `AI_CONFIG_UPDATED` entry. That service also
 * owns `disclaimerVersion`: the client cannot send it, and it is bumped
 * only when the disclaimer text actually changed.
 */
export async function PUT(request: Request): Promise<Response> {
  await connection();

  try {
    const admin = await requireAdmin();

    const body: unknown = await request.json();
    const input = updateAdvisorConfigSchema.parse(body);

    const { config, disclaimerChanged } = await updateAiConfig(
      toAuditActor(admin),
      {
        ...(input.disclaimerText !== undefined
          ? { disclaimerText: input.disclaimerText }
          : {}),
        ...(input.aiProductIds !== undefined
          ? { aiProductIds: input.aiProductIds }
          : {}),
        ...(input.systemPrompt !== undefined
          ? { systemPrompt: input.systemPrompt }
          : {}),
        ...(input.enforceCartConflicts !== undefined
          ? { enforceCartConflicts: input.enforceCartConflicts }
          : {}),
      },
    );

    return ok({
      admin: { id: admin.id, email: admin.email },
      config,
      disclaimerChanged,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
