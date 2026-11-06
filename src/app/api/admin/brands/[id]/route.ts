import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import {
  deleteBrand,
  getAdminBrand,
  updateBrand,
} from "@/lib/admin/brands";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import {
  brandDeleteSchema,
  brandUpdateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/brands/[id]
 *
 * One brand, in full.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    await requireAdmin();

    const { id } = await context.params;

    const brandId = entityIdSchema.parse(id);

    const brand = await getAdminBrand(brandId);

    return ok({ brand });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/brands/[id]
 *
 * A **partial** update: a field that is absent is left exactly as it
 * was. An explicit `null` on `logo` clears the logo — which puts the
 * brand back on its monogram fallback.
 *
 * The update is **conditional on the values the admin saw** — one
 * winner, one 409.
 *
 * Admin only.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const { id } = await context.params;

    const brandId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const input = brandUpdateSchema.parse(body);

    // An empty patch would change nothing and write nothing. Refusing it
    // is better than returning a 200 that appears to have done something.
    if (Object.keys(input).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const brand = await updateBrand(toAuditActor(admin), brandId, input);

    return ok({ brand });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}

/**
 * DELETE /api/admin/brands/[id]
 *
 * Deletes a brand.
 *
 * Body:
 *
 *   { reason: string }
 *
 * The **reason is mandatory** — a deletion leaves nothing behind to
 * inspect, so the record of why is the only thing that remains.
 *
 * Deleting a brand does **not** touch the products that carry it.
 * `Product.brand` is a plain string, not a foreign key, so those
 * products keep their brand name — they simply have no logo to show,
 * because the storefront falls back to the monogram. A brand deletion is
 * never destructive to the catalogue.
 *
 * Admin only.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const { id } = await context.params;

    const brandId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const { reason } = brandDeleteSchema.parse(body);

    await deleteBrand(toAuditActor(admin), brandId, reason);

    return ok({ deleted: true, id: brandId });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
