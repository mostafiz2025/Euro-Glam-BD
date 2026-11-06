import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { created, ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import { createConcern, listAdminConcerns } from "@/lib/admin/concerns";
import { requireAdmin } from "@/lib/auth/guards";
import {
  adminConcernQuerySchema,
  concernCreateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/concerns
 *
 * The skin-concern list for the admin panel.
 *
 * Query parameters (all optional):
 *
 *   search    matches the concern's name, slug or ingredient tag
 *   page      1-based page number
 *   limit     rows per page (max 100)
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminConcernQuerySchema.parse(rawQuery);

    const result = await listAdminConcerns(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/admin/concerns
 *
 * Creates a skin concern.
 *
 * Body:
 *
 *   {
 *     name: string,
 *     slug: string,
 *     tag: string,
 *     relatedTags?: string[],
 *     image?: string | null,
 *     description?: string | null
 *   }
 *
 * `tag` is the **canonical ingredient ID** the concern filters on — the
 * same list the conflict engine compares — so a concern filter and a
 * conflict rule always agree about what "BHA" means.
 *
 * `image` is a **storage key**, not a URL — the admin form uploads the
 * file to `/api/admin/concerns/images` first and sends the key it gets
 * back. Absent or `null` means "no image", and the storefront falls back
 * to the plain chip presentation.
 *
 * The concern and its `CONCERN_CREATED` audit entry are written in
 * **one** transaction.
 *
 * Admin only.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const body = concernCreateSchema.parse(await request.json());

    const concern = await createConcern(toAuditActor(admin), body);

    return created({ concern });
  } catch (error) {
    return handleApiError(error);
  }
}
