import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { getAdminReview, moderateReviewAsUser } from "@/lib/admin/reviews";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { reviewModerationSchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/reviews/[id]
 *
 * One review, for the moderation detail view.
 *
 * The id is validated before it reaches the database, so a malformed id
 * is a 400 rather than a database error.
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

    const reviewId = entityIdSchema.parse(id);

    const review = await getAdminReview(reviewId);

    return ok({ review });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/reviews/[id]
 *
 * Moderates one review.
 *
 * Body:
 *
 *   { action: "APPROVE" | "HIDE" | "UNHIDE", reason?: string }
 *
 * The moderation and its audit entry are written in **one** transaction.
 * An illegal transition is a 409 and writes nothing at all — no status
 * change and no audit entry.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    const admin = await requireAdmin();

    const { id } = await context.params;

    const reviewId = entityIdSchema.parse(id);

    const body = reviewModerationSchema.parse(await request.json());

    const review = await moderateReviewAsUser(
      admin,
      reviewId,
      body.action,
      body.reason,
    );

    return ok({ review });
  } catch (error) {
    return handleApiError(error);
  }
}
