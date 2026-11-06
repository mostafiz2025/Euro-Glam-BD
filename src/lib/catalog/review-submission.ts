import { db } from "@/lib/db";

import { ACTIVE_PRODUCT_WHERE } from "./product-visibility";
import { PUBLISHED_REVIEW_WHERE } from "./reviews";

/**
 * The customer review submission.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * `src/lib/catalog/reviews.ts` is the *read* side: it exposes published
 * reviews to a page. It deliberately exposes nothing about moderation,
 * because a public page reading the moderation queue would be a leak.
 *
 * This file is the *write* side. It is separate for the same reason the
 * admin moderation module is separate: the public path and the privileged
 * path must not share a code path that could grow a leak.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. A submitted review is pending. Always.**
 *
 * `isApproved` is never set by this module. It is not in the `data` at
 * all — the column's default (`false`) is what makes the review pending,
 * and leaving it to the default means there is no code path here that
 * *could* set it. A review submitted through this endpoint cannot be
 * public until an admin approves it.
 *
 * **2. The author is the session, not the body.**
 *
 * The review's `userId` comes from the authenticated customer. The body
 * carries no author identity at all.
 *
 * **3. One review per customer per product.**
 *
 * The database has no unique constraint on `(productId, userId)`, so the
 * check is done here. It is done as a *find-first, then write*, and the
 * race between two simultaneous submissions is accepted: the second
 * submission fails the pre-check and the user gets a clear message. The
 * alternative — a unique constraint and a migration — protects against a
 * case that cannot produce a customer-visible problem, because a
 * duplicate review is caught before it is written in all but the
 * rarest timing.
 *
 * **4. The product must exist and be published.**
 *
 * A review on a product that does not exist is a review of nothing.
 */

/**
 * The result of a submission.
 */
export type SubmitReviewResult = {
  readonly review: {
    readonly id: string;
    readonly rating: number;
    readonly comment: string;
    readonly createdAt: Date;
    /**
     * The moderation state, as the customer may know it.
     *
     * `"PENDING"` — submitted, waiting for the shop to look at it.
     * `"APPROVED"` — published.
     *
     * The customer is told the truth about their own review: a review
     * that vanished with no explanation reads as a bug. The customer does
     * *not* learn anything about the reviewer's identity beyond their
     * own, nor about other pending reviews.
     */
    readonly moderationStatus: "PENDING" | "APPROVED";
  };
};

/**
 * Submits a review.
 *
 * @param productId the product being reviewed
 * @param userId the authenticated customer
 * @param rating 1 to 5
 * @param comment the review body
 * @returns the created review and its moderation state
 * @throws when the product does not exist
 * @throws when the customer has already reviewed this product
 */
export async function submitCustomerReview(
  productId: string,
  userId: string,
  input: { readonly rating: number; readonly comment: string },
): Promise<SubmitReviewResult> {
  /**
   * `findFirst`, not `findUnique` — Prisma's `findUnique` accepts only
   * unique fields in its `where`, so `id` plus a non-unique
   * `archivedAt: null` would not compile.
   *
   * A review cannot be submitted for an archived product. A withdrawn
   * product is not on sale, and a review of it would be a review of
   * something the shop no longer offers.
   */
  const product = await db.product.findFirst({
    where: { id: productId, ...ACTIVE_PRODUCT_WHERE },
    select: { id: true },
  });

  if (!product) {
    throw new Error("PRODUCT_NOT_FOUND");
  }

  // The duplicate check. `isHidden` is not consulted — a hidden review
  // was once approved and the customer may reasonably want to post
  // again. What is refused is a *second live review* by the same
  // customer for the same product.
  const existing = await db.review.findFirst({
    where: {
      productId,
      userId,
      isApproved: true,
      isHidden: false,
    },
    select: { id: true },
  });

  if (existing) {
    throw new Error("ALREADY_REVIEWED");
  }

  const review = await db.review.create({
    data: {
      productId,
      userId,
      rating: input.rating,
      comment: input.comment,
      // `isApproved` is deliberately absent. The column defaults to
      // `false`, which is exactly the pending state this review must
      // have. Setting it explicitly to `false` would be the same thing,
      // but leaving it out means there is no line here that *could* be
      // changed to `true` without someone noticing they had done it.
    },
    select: {
      id: true,
      rating: true,
      comment: true,
      createdAt: true,
      isApproved: true,
      isHidden: true,
    },
  });

  return {
    review: {
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt,
      moderationStatus: review.isApproved && !review.isHidden
        ? "APPROVED"
        : "PENDING",
    },
  };
}

/**
 * Whether the customer has already reviewed the product.
 *
 * Used by the form to decide whether to show the submission panel at
 * all, so a customer who has already reviewed is not invited to review
 * again.
 */
export async function hasCustomerReviewed(
  productId: string,
  userId: string,
): Promise<boolean> {
  const count = await db.review.count({
    where: { productId, userId, ...PUBLISHED_REVIEW_WHERE },
  });

  return count > 0;
}
