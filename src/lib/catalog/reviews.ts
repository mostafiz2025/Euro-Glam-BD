import { db } from "@/lib/db";

/**
 * The public review listing.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * The product detail page needs to show customer reviews, and the
 * catalogue service only returns a *summary* — the average and the
 * count. A summary is not a review section: the customer wants to read
 * what other people said, not just a number.
 *
 * The admin review module is the wrong source for this. It is built
 * around moderation — it shows pending reviews, it exposes the
 * moderation state, and it is authorised for admins. A public page
 * reading from the moderation queue would be a leak waiting to happen.
 *
 * So this is a separate, deliberately small module with one rule:
 *
 *   **Only published reviews are readable, and only what a reader
 *   needs is exposed.**
 *
 * ── The published predicate ──────────────────────────────────────────────
 *
 * `isApproved: true AND isHidden: false`. Both flags, always.
 *
 * `isApproved` alone is not enough. A hidden review is still
 * `isApproved: true` — `isHidden` is what an admin sets when
 * withdrawing a review that was already public. Filtering on
 * `isApproved` alone would keep serving a review the shop has
 * deliberately taken down.
 *
 * The same predicate is used by `getProductById` for the rating
 * average. Two places, one rule — and both are stated in the same
 * words, so a future change updates both.
 */

/**
 * A public review.
 *
 * Only the fields a reader needs. There is no `userId`, no email, no
 * moderation state — a review is a name, a rating, a comment and a
 * date.
 */
export type PublicReview = {
  readonly id: string;
  readonly rating: number;
  readonly comment: string;
  readonly videoUrl: string | null;
  readonly createdAt: Date;
  /** The reviewer's display name. */
  readonly authorName: string;
  /**
   * Whether the reviewer has a completed order.
   *
   * "Verified" must mean something. A review from someone who actually
   * bought the product is evidence; a review from anyone is not. The
   * flag is computed from the reviewer's order history, not stored, so
   * it stays true when it should be.
   */
  readonly isVerifiedBuyer: boolean;
};

/**
 * The result of a review listing.
 */
export type PublicReviewList = {
  readonly reviews: PublicReview[];
  /** The total number of published reviews. */
  readonly total: number;
  /** The number of published reviews. An alias for `total`. */
  readonly count: number;
  /** The average rating across all published reviews. */
  readonly average: number;
  /** The number of published reviews per star, 1 to 5. */
  readonly distribution: Record<1 | 2 | 3 | 4 | 5, number>;
};

/**
 * The published-review predicate.
 *
 * Exported so the catalogue service and any future reader use the
 * identical rule.
 */
export const PUBLISHED_REVIEW_WHERE = {
  isApproved: true,
  isHidden: false,
} as const;

/**
 * The number of reviews returned per page.
 */
const REVIEW_PAGE_SIZE = 10;

/**
 * Lists the published reviews for a product.
 *
 * Never throws — a failed review query must not take the product page
 * down. It returns an empty list and an error message instead.
 */
export async function listPublicReviews(
  productId: string,
  options: { readonly limit?: number; readonly offset?: number } = {},
): Promise<PublicReviewList & { readonly error: string | null }> {
  const limit = Math.min(Math.max(options.limit ?? REVIEW_PAGE_SIZE, 1), 50);
  const offset = Math.max(options.offset ?? 0, 0);

  try {
    const [reviews, aggregate, counts] = await Promise.all([
      db.review.findMany({
        where: { productId, ...PUBLISHED_REVIEW_WHERE },
        select: {
          id: true,
          rating: true,
          comment: true,
          videoUrl: true,
          createdAt: true,
          user: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: "desc" }],
        take: limit,
        skip: offset,
      }),

      db.review.aggregate({
        where: { productId, ...PUBLISHED_REVIEW_WHERE },
        _avg: { rating: true },
        _count: { _all: true },
      }),

      db.review.groupBy({
        by: ["rating"],
        where: { productId, ...PUBLISHED_REVIEW_WHERE },
        _count: { _all: true },
      }),
    ]);

    const distribution = buildDistribution(counts);

    // The "verified" flag: the reviewer has at least one order that
    // contains this product. The link is `User → Order → OrderItem`, so
    // the filter has to go through the order — there is no direct
    // `User.orderItems` relation.
    const reviewers = await db.user.findMany({
      where: {
        id: { in: reviews.map((review) => review.user.id) },
        orders: {
          some: {
            items: {
              some: { productId },
            },
          },
        },
      },
      select: { id: true },
    });

    const verifiedIds = new Set(reviewers.map((reviewer) => reviewer.id));

    return {
      reviews: reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        videoUrl: review.videoUrl,
        createdAt: review.createdAt,
        authorName: review.user.name,
        isVerifiedBuyer: verifiedIds.has(review.user.id),
      })),
      total: aggregate._count._all,
      count: aggregate._count._all,
      average:
        aggregate._avg.rating !== null
          ? Math.round(aggregate._avg.rating * 10) / 10
          : 0,
      distribution,
      error: null,
    };
  } catch (error) {
    console.error("[storefront] Review list failed:", error);

    return {
      reviews: [],
      total: 0,
      count: 0,
      average: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      error: "We could not load reviews.",
    };
  }
}

/**
 * Builds the star distribution from the grouped counts.
 *
 * Every star is present, even the ones with no reviews — a missing key
 * would render as `undefined` in the bar chart, and a bar chart with a
 * missing bar is a broken bar chart.
 */
function buildDistribution(
  counts: readonly { rating: number; _count: { _all: number } }[],
): Record<1 | 2 | 3 | 4 | 5, number> {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };

  for (const entry of counts) {
    if (entry.rating >= 1 && entry.rating <= 5) {
      distribution[entry.rating as 1 | 2 | 3 | 4 | 5] = entry._count._all;
    }
  }

  return distribution;
}
