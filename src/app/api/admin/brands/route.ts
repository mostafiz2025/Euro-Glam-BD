import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { created, ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import { createBrand, listAdminBrands } from "@/lib/admin/brands";
import { requireAdmin } from "@/lib/auth/guards";
import {
  adminBrandQuerySchema,
  brandCreateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/brands
 *
 * The brand list for the admin panel.
 *
 * Query parameters (all optional):
 *
 *   search    matches the brand's name or slug
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

    const query = adminBrandQuerySchema.parse(rawQuery);

    const result = await listAdminBrands(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/admin/brands
 *
 * Creates a brand.
 *
 * Body:
 *
 *   {
 *     name: string,
 *     slug: string,
 *     monogram: string,
 *     logo?: string | null,
 *     description?: string | null,
 *     sortOrder?: number
 *   }
 *
 * `name` is the string `Product.brand` holds, so it is **canonicalised**
 * to its registry spelling: "cerave" and "CeraVe" cannot become two
 * brands, one of which has no products and one of which has all of them.
 *
 * `logo` is a **storage key**, not a URL — the admin form uploads the
 * file to `/api/admin/brands/images` first and sends the key it gets
 * back. Absent or `null` means "no logo", and the storefront falls back
 * to the **monogram** — which is the fallback, not a removed feature.
 *
 * Shipping a trademarked logo requires permission. The admin form says
 * so, and the shop is responsible for holding it; the code cannot
 * verify a licence.
 *
 * The brand and its `BRAND_CREATED` audit entry are written in **one**
 * transaction.
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

    const body = brandCreateSchema.parse(await request.json());

    const brand = await createBrand(toAuditActor(admin), body);

    return created({ brand });
  } catch (error) {
    return handleApiError(error);
  }
}
