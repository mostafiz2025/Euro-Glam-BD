import { connection } from "next/server";

import { toAuditActor } from "@/lib/admin/audit";
import {
  deleteConcern,
  getAdminConcern,
  updateConcern,
} from "@/lib/admin/concerns";
import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import {
  concernDeleteSchema,
  concernUpdateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/concerns/[id]
 *
 * One concern, in full.
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

    const concernId = entityIdSchema.parse(id);

    const concern = await getAdminConcern(concernId);

    return ok({ concern });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/concerns/[id]
 *
 * A **partial** update: a field that is absent is left exactly as it
 * was. An explicit `null` on `image` clears the card image.
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

    const concernId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const input = concernUpdateSchema.parse(body);

    // An empty patch would change nothing and write nothing. Refusing it
    // is better than returning a 200 that appears to have done something.
    if (Object.keys(input).length === 0) {
      throw ApiError.validation("There is nothing to update.");
    }

    const concern = await updateConcern(toAuditActor(admin), concernId, input);

    return ok({ concern });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}

/**
 * DELETE /api/admin/concerns/[id]
 *
 * Deletes a skin concern.
 *
 * Body:
 *
 *   { reason: string }
 *
 * The **reason is mandatory** — a deletion leaves nothing behind to
 * inspect, so the record of why is the only thing that remains.
 *
 * Deleting a concern does **not** touch the products that carry the
 * concern's ingredient tag. It only removes the shop's way of
 * *featuring* it.
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

    const concernId = entityIdSchema.parse(id);

    const body: unknown = await request.json();

    const { reason } = concernDeleteSchema.parse(body);

    await deleteConcern(toAuditActor(admin), concernId, reason);

    return ok({ deleted: true, id: concernId });
  } catch (error) {
    if (error instanceof Error && error.name === "SyntaxError") {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
