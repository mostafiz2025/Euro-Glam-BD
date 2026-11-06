import Link from "next/link";

import { StatusBadge } from "@/components/admin/primitives";
import { ReviewModerationActions } from "@/components/admin/review-moderation-actions";
import { Rating } from "@/components/ui/rating";
import {
  reviewState,
  type AdminReviewSummary,
  type ReviewState,
} from "@/lib/admin/reviews";

/**
 * The review moderation table.
 *
 * ── Why a table and not a card list ───────────────────────────────────────
 *
 * The previous presentation was a vertical list of cards. It read well
 * for **one** review, but a moderation queue is a *scanning* task: an
 * admin wants to see many reviews at once, compare their ratings, spot
 * the ones that need a decision, and work down the list.
 *
 * A list of stacked cards makes that impossible — each review takes a
 * screen's worth of vertical space, so only three fit in view. A table
 * puts twenty on one screen, with the columns lined up so the eye can
 * run down a single column.
 *
 * The columns are the questions a moderator actually asks:
 *
 *   • **Product** — what is being reviewed? (links to the PDP)
 *   • **Customer** — who said it?
 *   • **Rating** — how good was it? (the first thing to look at)
 *   • **Comment** — what did they say?
 *   • **Submitted** — when?
 *   • **State** — where is it in the machine?
 *   • **Actions** — the one legal action for this state.
 *
 * ── What was NOT changed ─────────────────────────────────────────────────
 *
 * The service, the API route and the state machine are untouched. The
 * one-click actions come from the same `ReviewModerationActions` control
 * the previous page used, so the proven behaviour — including the
 * conditional update that makes two admins moderating the same review
 * safe — is exactly the behaviour this table gets.
 *
 * The comment cell truncates to a fixed number of lines. A customer who
 * writes four paragraphs should not push every other row off the
 * screen, and the full text is still one click away on the PDP.
 */
export function ReviewModerationTable({
  reviews,
}: {
  readonly reviews: readonly AdminReviewSummary[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wider text-foreground-muted">
            <th scope="col" className="px-4 py-3 font-medium">
              Product
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Customer
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Rating
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Comment
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Submitted
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              State
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-neutral-100">
          {reviews.map((review) => {
            const state = reviewState(review);

            return (
              <tr key={review.id} className="align-top">
                {/* ── The product ───────────────────────────────────── */}
                <td className="max-w-[200px] px-4 py-3">
                  <Link
                    href={`/products/${review.product.id}`}
                    className="block truncate font-medium text-foreground underline-offset-2 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                  >
                    {review.product.name}
                  </Link>
                </td>

                {/* ── The customer ─────────────────────────────────── */}
                <td className="max-w-[160px] px-4 py-3">
                  <span className="block truncate text-foreground-muted">
                    {review.user.name}
                  </span>
                </td>

                {/* ── The rating ───────────────────────────────────── */}
                <td className="px-4 py-3">
                  <Rating average={review.rating} showNumbers />
                </td>

                {/* ── The comment ──────────────────────────────────── */}
                <td className="max-w-[320px] px-4 py-3">
                  {review.comment ? (
                    <p className="line-clamp-3 text-foreground-muted">
                      {review.comment}
                    </p>
                  ) : (
                    <span className="text-xs text-foreground-muted">
                      No written comment
                    </span>
                  )}
                </td>

                {/* ── When it arrived ──────────────────────────────── */}
                <td className="whitespace-nowrap px-4 py-3 text-xs text-foreground-muted">
                  {formatDate(review.createdAt)}
                </td>

                {/* ── Where it sits ────────────────────────────────── */}
                <td className="px-4 py-3">
                  <StatusBadge status={state} />
                </td>

                {/* ── The one legal action ─────────────────────────── */}
                <td className="px-4 py-3">
                  <div className="w-56">
                    <ReviewModerationActions
                      reviewId={review.id}
                      state={state as ReviewState}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Formats a review's date.
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
