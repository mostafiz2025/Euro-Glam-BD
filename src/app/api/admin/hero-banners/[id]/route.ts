import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import {
  deleteHeroBanner,
  getAdminHeroBanner,
  updateHeroBanner,
} from "@/lib/admin/hero-banners";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import {
  heroBannerDeleteSchema,
  heroBannerUpdateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/hero-banners/[id]
 *
 * One banner, in full.
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

    const bannerId = entityIdSchema.parse(id);

    const banner = await getAdminHeroBanner(bannerId);

    return ok({ banner });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/hero-banners/[id]
 *
 * A **partial** update: a field that is absent is left exactly as it
 * was. An explicit `null` on `image` clears the artwork.
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

    const bannerId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const input = heroBannerUpdateSchema.parse(body);

    // An empty patch would change nothing and write nothing. Refusing it
    // is better than returning a 200 that appears to have done something.
    if (Object.keys(input).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const banner = await updateHeroBanner(toAuditActor(admin), bannerId, input);

    return ok({ banner });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}

/**
 * DELETE /api/admin/hero-banners/[id]
 *
 * Deletes a homepage hero banner.
 *
 * Body:
 *
 *   { reason: string }
 *
 * The **reason is mandatory** — a deletion leaves nothing behind to
 * inspect, so the record of why is the only thing that remains.
 *
 * The banner's artwork is removed with it, on a best-effort basis. The
 * banner is the only thing that references that file.
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

    const bannerId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const { reason } = heroBannerDeleteSchema.parse(body);

    await deleteHeroBanner(toAuditActor(admin), bannerId, reason);

    return ok({ deleted: true, id: bannerId });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
