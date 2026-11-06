import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import {
  deleteCategory,
  getAdminCategory,
  updateCategory,
} from "@/lib/admin/categories";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import {
  categoryDeleteSchema,
  categoryUpdateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/categories/[id]
 *
 * One category, in full.
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

    const categoryId = entityIdSchema.parse(id);

    const category = await getAdminCategory(categoryId);

    return ok({ category });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/categories/[id]
 *
 * A **partial** update: a field that is absent is left exactly as it
 * was. An explicit `null` on `image` clears the card image — which puts
 * the category back on its SVG icon fallback.
 *
 * The update is **conditional on the values the admin saw**. If another
 * admin changed the name in the window between the page load and the
 * save, the update matches zero rows and the second admin is told to
 * reload. One winner, one 409.
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

    const categoryId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const input = categoryUpdateSchema.parse(body);

    // An empty patch would change nothing and write nothing. Refusing it
    // is better than returning a 200 that appears to have done something.
    if (Object.keys(input).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const category = await updateCategory(toAuditActor(admin), categoryId, input);

    return ok({ category });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}

/**
 * DELETE /api/admin/categories/[id]
 *
 * Deletes a category.
 *
 * Body:
 *
 *   { reason: string }
 *
 * The **reason is mandatory** — a deletion is the one admin action that
 * leaves nothing behind to inspect, so the record of why is the only
 * thing that remains.
 *
 * A category that still holds products **cannot** be deleted. The
 * products reference it and the database refuses, but the service checks
 * the count first and reports it: *"This category still has 9 products.
 * Move them to another category first."*
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

    const categoryId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const { reason } = categoryDeleteSchema.parse(body);

    await deleteCategory(toAuditActor(admin), categoryId, reason);

    return ok({ deleted: true, id: categoryId });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
