import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { created } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { submitCustomerReview } from "@/lib/catalog/review-submission";
import { productIdSchema, submitReviewSchema } from "@/lib/validation/commerce";

/**
 * POST /api/products/[id]/reviews
 *
 * Submits a customer review for a product.
 *
 * ── The rules that govern this endpoint ──────────────────────────────────
 *
 * **1. A session is required.**
 *
 * A review is attributed to somebody. An anonymous review would be
 * unattributable, unmoderatable and impossible to verify — and the
 * product page's "Verified purchase" badge is computed from the order
 * history, which needs an account to look up.
 *
 * **2. The body carries no identity and no moderation state.**
 *
 * The `userId` comes from the session and the `isApproved` flag comes
 * from the database default. The body contains a rating, a comment and
 * nothing else that matters. See `submitReviewSchema`.
 *
 * **3. A submitted review is pending.**
 *
 * The response says so — `moderationStatus: "PENDING"` — and the form
 * tells the customer their review is waiting for the shop. A review
 * that silently disappears is indistinguishable from a bug.
 *
 * **4. The errors are specific.**
 *
 * "You have already reviewed this product" is a different problem from
 * "That product does not exist", and the customer can act on one of them
 * and not the other. A single "could not submit" would fail both.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const customer = await requireCustomer();

    // Next.js 16 delivers route params as a promise.
    const { id } = await context.params;

    const productId = productIdSchema.parse(id);

    let body: unknown;

    try {
      body = await request.json();
    } catch {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    const input = submitReviewSchema.parse(body);

    try {
      const result = await submitCustomerReview(productId, customer.id, {
        rating: input.rating,
        comment: input.comment,
      });

      // 201 — a review was created. It is pending moderation, and the
      // response says so, so the client never has to guess.
      return created(result);
    } catch (error) {
      // The service signals its refusals with sentinel errors rather
      // than a typed `ApiError`, because the service is also reachable
      // from places that are not route handlers. The mapping to HTTP
      // status codes happens here, at the boundary.
      if (error instanceof Error) {
        if (error.message === "PRODUCT_NOT_FOUND") {
          throw ApiError.notFound("That product does not exist.");
        }

        if (error.message === "ALREADY_REVIEWED") {
          throw ApiError.conflict(
            "You have already reviewed this product.",
            { productId },
          );
        }
      }

      throw error;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
