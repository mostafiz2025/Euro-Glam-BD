import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import type { SessionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import type {
  AdminReviewQuery,
  ReviewAction,
  ReviewStatusFilter,
} from "@/lib/validation/admin";

import {
  REVIEW_ACTIONS,
  toAuditActor,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The review moderation service.
 *
 * ── The state machine ───────────────────────────────────────────────────
 *
 * A review has three states, derived from two flags:
 *
 *   | isApproved | isHidden | State     | Public? |
 *   |------------|----------|-----------|---------|
 *   | false      | false    | PENDING   | No      |
 *   | true       | false    | APPROVED  | Yes     |
 *   | true       | true     | HIDDEN    | No      |
 *
 * The transitions are:
 *
 *   PENDING  → APPROVED   (approve)
 *   APPROVED → HIDDEN     (hide)
 *   HIDDEN   → APPROVED   (unhide)
 *
 * Hiding a **pending** review is refused. There is nothing to withdraw
 * — it was never published — and silently setting `isHidden` on it would
 * produce a fourth, unreachable combination (`isApproved = false,
 * isHidden = true`) that no queue would ever show.
 *
 * ── Why the public predicate needs both flags ──────────────────────────
 *
 * A review is public when `isApproved = true AND isHidden = false`.
 *
 * `isApproved` alone is not enough: hiding sets `isHidden = true` and
 * leaves `isApproved = true` — because the review *was* approved, and
 * that history must not be lost. The catalogue's public review query
 * must therefore check both flags. A public query that checked only
 * `isApproved` would publish hidden reviews.
 */

/**
 * The review shape returned by the admin list endpoint.
 */
export type AdminReviewSummary = {
  id: string;
  rating: number;
  comment: string;
  videoUrl: string | null;
  isApproved: boolean;
  isHidden: boolean;
  moderatedAt: Date | null;
  createdAt: Date;
  product: { id: string; name: string };
  user: { id: string; name: string };
};

/**
 * The Prisma select for an admin review summary.
 */
const ADMIN_REVIEW_SELECT = {
  id: true,
  rating: true,
  comment: true,
  videoUrl: true,
  isApproved: true,
  isHidden: true,
  moderatedAt: true,
  createdAt: true,
  product: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
} satisfies Prisma.ReviewSelect;

/**
 * The moderation state of a review.
 */
export type ReviewState = "PENDING" | "APPROVED" | "HIDDEN";

/**
 * Derives the moderation state from the two flags.
 *
 * The `isApproved = false, isHidden = true` combination is unreachable
 * by construction (hiding a pending review is refused), so it is
 * reported as `PENDING` — the state the review is actually in.
 */
export function reviewState(review: {
  isApproved: boolean;
  isHidden: boolean;
}): ReviewState {
  if (review.isHidden && review.isApproved) return "HIDDEN";
  if (review.isApproved) return "APPROVED";
  return "PENDING";
}

/**
 * The public predicate for a review.
 *
 * **Both** flags must be satisfied. This is the single place the rule is
 * written, so the catalogue and the admin service cannot disagree.
 */
export function isPublicReview(review: {
  isApproved: boolean;
  isHidden: boolean;
}): boolean {
  return review.isApproved && !review.isHidden;
}

/**
 * Builds the `where` clause for a state filter.
 *
 * The same shape is used for the list, for the count, and for the
 * per-state counts. A filter that matched the list but not the count
 * would show "12 results" above a list of 0.
 */
export function reviewStateWhere(
  state: ReviewStatusFilter,
): Prisma.ReviewWhereInput {
  switch (state) {
    case "PENDING":
      return { isApproved: false, isHidden: false };
    case "APPROVED":
      return { isApproved: true, isHidden: false };
    case "HIDDEN":
      return { isApproved: true, isHidden: true };
    case "ALL":
      return {};
  }
}

/**
 * The result of a review list query.
 */
export type AdminReviewListResult = {
  reviews: AdminReviewSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  /**
   * The number of reviews in each moderation state.
   *
   * Computed from the **same** `where` shapes as the lists, so a filter
   * that matches nothing shows `0` in both places rather than looking
   * like an empty queue.
   */
  counts: {
    pending: number;
    approved: number;
    hidden: number;
    all: number;
  };
};

/**
 * Lists reviews for the moderation queue.
 */
export async function listAdminReviews(
  query: AdminReviewQuery,
): Promise<AdminReviewListResult> {
  const where: Prisma.ReviewWhereInput = {
    AND: [
      reviewStateWhere(query.status),
      ...(query.productId ? [{ productId: query.productId }] : []),
      ...(query.userId ? [{ userId: query.userId }] : []),
    ],
  };

  const skip = (query.page - 1) * query.limit;

  const [rows, total, pending, approved, hidden, all] = await Promise.all([
    db.review.findMany({
      where,
      select: ADMIN_REVIEW_SELECT,
      orderBy: { createdAt: "asc" },
      skip,
      take: query.limit,
    }),
    db.review.count({ where }),
    db.review.count({ where: reviewStateWhere("PENDING") }),
    db.review.count({ where: reviewStateWhere("APPROVED") }),
    db.review.count({ where: reviewStateWhere("HIDDEN") }),
    db.review.count({ where: reviewStateWhere("ALL") }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    reviews: rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    counts: { pending, approved, hidden, all },
  };
}

/**
 * Loads a single review for the admin detail view.
 *
 * @throws ApiError 404 when the review does not exist.
 */
export async function getAdminReview(
  reviewId: string,
): Promise<AdminReviewSummary> {
  const review = await db.review.findUnique({
    where: { id: reviewId },
    select: ADMIN_REVIEW_SELECT,
  });

  if (!review) {
    throw ApiError.notFound("That review does not exist.");
  }

  return review;
}

/**
 * The target flags for a moderation action, given the current state.
 *
 * Returns `null` when the action is not legal from the current state —
 * the caller turns that into a 409.
 */
export function moderationTarget(
  current: { isApproved: boolean; isHidden: boolean },
  action: ReviewAction,
): { isApproved: boolean; isHidden: boolean } | null {
  const state = reviewState(current);

  switch (action) {
    case "APPROVE":
      // Approving a pending review publishes it. Approving an already
      // approved review is a no-op that would only add audit noise.
      if (state !== "PENDING") return null;
      return { isApproved: true, isHidden: false };

    case "HIDE":
      // Only a published review can be withdrawn.
      if (state !== "APPROVED") return null;
      return { isApproved: true, isHidden: true };

    case "UNHIDE":
      // Only a hidden review can be restored.
      if (state !== "HIDDEN") return null;
      return { isApproved: true, isHidden: false };
  }
}

/**
 * The audit action for a moderation action.
 */
function auditActionFor(action: ReviewAction) {
  switch (action) {
    case "APPROVE":
      return REVIEW_ACTIONS.approve;
    case "HIDE":
      return REVIEW_ACTIONS.hide;
    case "UNHIDE":
      return REVIEW_ACTIONS.unhide;
  }
}

/**
 * Moderates one review.
 *
 * ── The atomicity ──────────────────────────────────────────────────────
 *
 * The status change and its audit entry are written in **one**
 * transaction. A moderation without an audit trail is worse than no
 * audit trail, because it looks complete.
 *
 * The update is a **conditional** `updateMany` on the *current* flags.
 * Two admins moderating the same review at the same time race here, and
 * exactly one wins — the loser's `updateMany` matches zero rows and
 * gets a 409 rather than silently overwriting the winner's decision.
 *
 * @param actor   - The admin doing the moderation.
 * @param reviewId - The review to moderate.
 * @param action  - What to do.
 * @param reason  - An optional note, stored on the audit entry.
 *
 * @throws ApiError 404 when the review does not exist.
 * @throws ApiError 409 when the action is illegal from the current state,
 *         or when another admin moderated the review first.
 */
export async function moderateReview(
  actor: AuditActor,
  reviewId: string,
  action: ReviewAction,
  reason?: string,
): Promise<AdminReviewSummary> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.review.findUnique({
        where: { id: reviewId },
        select: { isApproved: true, isHidden: true },
      });

      if (!current) {
        throw ApiError.notFound("That review does not exist.");
      }

      const target = moderationTarget(current, action);

      if (!target) {
        throw ApiError.conflict(
          conflictMessage(reviewState(current), action),
          {
            currentState: reviewState(current),
            action,
          },
        );
      }

      const before = {
        isApproved: current.isApproved,
        isHidden: current.isHidden,
        state: reviewState(current),
      };

      const after = {
        isApproved: target.isApproved,
        isHidden: target.isHidden,
        state: reviewState(target),
      };

      // The conditional update. Every condition is the state the read
      // observed, so a concurrent moderator's write makes this one match
      // zero rows.
      const updated = await tx.review.updateMany({
        where: {
          id: reviewId,
          isApproved: current.isApproved,
          isHidden: current.isHidden,
        },
        data: {
          isApproved: target.isApproved,
          isHidden: target.isHidden,
          moderatedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "That review was moderated by someone else. Reload and try again.",
        );
      }

      await writeAuditEntry(tx, {
        actor,
        action: auditActionFor(action),
        entityType: "review",
        entityId: reviewId,
        before,
        after,
        reason: reason ?? null,
      });

      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: ADMIN_REVIEW_SELECT,
      });

      if (!review) {
        throw ApiError.notFound("That review does not exist.");
      }

      return review;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Explains why a moderation action is not legal.
 *
 * A 409 that says only "conflict" is a support ticket. A 409 that says
 * "this review is already approved" is a fix.
 */
function conflictMessage(state: ReviewState, action: ReviewAction): string {
  switch (action) {
    case "APPROVE":
      return `That review is already ${state.toLowerCase()}. Only a pending review can be approved.`;
    case "HIDE":
      return `A ${state.toLowerCase()} review cannot be hidden — only a published review can be withdrawn.`;
    case "UNHIDE":
      return `A ${state.toLowerCase()} review cannot be restored — only a hidden review can be unhidden.`;
  }
}

/**
 * Convenience wrapper that moderates a review on behalf of a session user.
 */
export async function moderateReviewAsUser(
  user: SessionUser,
  reviewId: string,
  action: ReviewAction,
  reason?: string,
): Promise<AdminReviewSummary> {
  return moderateReview(toAuditActor(user), reviewId, action, reason);
}
