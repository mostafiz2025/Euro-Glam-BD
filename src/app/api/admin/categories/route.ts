import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { created, ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import { createCategory, listAdminCategories } from "@/lib/admin/categories";
import { requireAdmin } from "@/lib/auth/guards";
import {
  adminCategoryQuerySchema,
  categoryCreateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/categories
 *
 * The category list for the admin panel.
 *
 * Query parameters (all optional):
 *
 *   search    matches the category's name or slug
 *   page      1-based page number
 *   limit     rows per page (max 100)
 *
 * Each row carries its **product count**, so the admin can see at a
 * glance that a category still holds stock — and therefore cannot be
 * deleted — without opening it.
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

    const query = adminCategoryQuerySchema.parse(rawQuery);

    const result = await listAdminCategories(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/admin/categories
 *
 * Creates a category.
 *
 * Body:
 *
 *   {
 *     name: string,
 *     slug: string,
 *     image?: string | null
 *   }
 *
 * `image` is a **storage key**, not a URL — the admin form uploads the
 * file to `/api/admin/categories/images` first and sends the key it gets
 * back. Absent or `null` means "no image", and the storefront falls back
 * to the SVG icon keyed by the slug.
 *
 * The category and its `CATEGORY_CREATED` audit entry are written in
 * **one** transaction — a category that exists with no record of who
 * added it is worse than one that was never added.
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

    const body = categoryCreateSchema.parse(await request.json());

    const category = await createCategory(toAuditActor(admin), body);

    return created({ category });
  } catch (error) {
    return handleApiError(error);
  }
}
