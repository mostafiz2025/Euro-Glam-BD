import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import { getAiConfig, updateAiConfig } from "@/lib/admin/ai-config";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { aiConfigUpdateSchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/settings/ai-config
 *
 * The Settings page's read.
 *
 * Returns the advisor configuration, or `null` when the row has never
 * been created. `null` is a meaningful answer — it means "no
 * configuration has been saved yet" — and the Settings page shows the
 * hardcoded fallback in that case, exactly as the advisor itself does.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // `connection()` MUST be called outside the try block: its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    await requireAdmin();

    const config = await getAiConfig();

    return ok({ config });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/settings/ai-config
 *
 * A **partial** update: every field is optional, and a field that is
 * absent is left exactly as it was.
 *
 * That matters more here than anywhere else. The disclaimer is
 * compliance text, and a form that sent the whole configuration on
 * every save would overwrite the disclaimer with a stale copy whenever
 * the admin edited the product allow-list. So the client sends only
 * what it changed, and the service writes only what it was given.
 *
 * `disclaimerVersion` is not accepted. It is a stamp the service
 * increments when the text changes, not a value a client sets.
 */
export async function PATCH(request: Request): Promise<Response> {
  await connection();

  try {
    const admin = await requireAdmin();

    const body: unknown = await request.json();
    const input = aiConfigUpdateSchema.parse(body);

    // An empty patch would bump nothing and write nothing. Refusing it
    // is better than returning a 200 that appears to have done
    // something.
    if (Object.keys(input).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

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

    return ok({ config, disclaimerChanged });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
