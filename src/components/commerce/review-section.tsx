import { CheckIcon, StarIcon } from "@/components/ui/icons";
import { Rating } from "@/components/ui/rating";
import type { PublicReviewList } from "@/lib/catalog/reviews";

/**
 * The customer review section.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. "Verified" is a claim the shop can back.**
 *
 * The badge is rendered only when the reviewer has a real order
 * containing this product. It is not a decoration and it is not
 * "verified" in the sense of "we read it" — it means "this person
 * bought this". A review system that badges every review is a badge
 * that means nothing.
 *
 * **2. The summary is honest about the absence of reviews.**
 *
 * A product with no reviews says so, plainly. It does not show "0.0"
 * with five empty stars, which reads as "everyone hated this".
 *
 * **3. The distribution bar is proportional and always present.**
 *
 * Every star from 1 to 5 is rendered, even the ones with no reviews. A
 * missing bar is a broken bar chart, and "1 star: 0" is information.
 *
 * The bar's width is the percentage of reviews at that star, computed
 * against the total — so the bars add up to the whole.
 */

/**
 * The props for the review section.
 */
export type ReviewSectionProps = {
  readonly reviews: PublicReviewList;
  /** The error message, when the review query failed. */
  readonly error?: string | null;
  /**
   * The submission form, or nothing.
   *
   * The form is a client component and it needs to know whether the
   * customer is signed in and whether they have already reviewed. Both
   * are read on the server, so the *server* decides what to render here
   * and the client component is passed in as a slot.
   *
   * A signed-out visitor gets nothing — not a disabled form, not a
   * prompt to sign in. A review needs an account, and the page already
   * says so in the form's place of a submit button.
   */
  readonly form?: React.ReactNode;
  /**
   * The prompt shown to a signed-out visitor.
   *
   * A review needs an account — it is attributed, it is moderated, and
   * the "verified purchase" badge is computed from the order history.
   * A signed-out visitor is told that plainly and given the way in,
   * rather than being shown a form that would fail on submit.
   */
  readonly signedOutPrompt?: React.ReactNode;
};

export function ReviewSection({
  reviews,
  error,
  form,
  signedOutPrompt,
}: ReviewSectionProps) {
  const { average, count, distribution } = reviews;

  if (error) {
    return (
      <section aria-labelledby="reviews-heading" className="mt-14">
        <h2
          id="reviews-heading"
          className="text-lg font-bold tracking-tight text-foreground sm:text-xl"
        >
          Customer Reviews
        </h2>

        <p
          role="status"
          className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {error}
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="reviews-heading" className="mt-14">
      <h2
        id="reviews-heading"
        className="text-lg font-bold tracking-tight text-foreground sm:text-xl"
      >
        Customer Reviews
      </h2>

      {/* ── The submission form ──────────────────────────────────────── */}
      {form ? <div className="mt-5">{form}</div> : null}
      {!form && signedOutPrompt ? (
        <div className="mt-5">{signedOutPrompt}</div>
      ) : null}

      {count === 0 ? (
        <div className="mt-5 rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-12 text-center">
          <div className="flex justify-center text-neutral-300">
            <StarIcon width={32} height={32} />
          </div>

          <p className="mt-3 text-sm font-medium text-foreground">
            No reviews yet
          </p>

          <p className="mx-auto mt-1 max-w-xs text-sm text-foreground-muted">
            Be the first to tell other shoppers what you think of this
            product.
          </p>
        </div>
      ) : (
        <div className="mt-5 grid gap-8 lg:grid-cols-[280px_1fr]">

          {/* ── The summary ──────────────────────────────────────────── */}
          <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)] lg:self-start">
            <div className="flex items-end gap-3">
              <span className="font-serif text-5xl font-bold leading-none text-foreground">
                {average.toFixed(1)}
              </span>

              <div className="pb-1">
                <Rating average={average} size="md" />
                <p className="mt-1 text-xs text-foreground-muted">
                  {count} {count === 1 ? "review" : "reviews"}
                </p>
              </div>
            </div>

            <ul className="mt-5 space-y-1.5">
              {[5, 4, 3, 2, 1].map((star) => {
                const starCount = distribution[star as 1 | 2 | 3 | 4 | 5];
                const percent = count > 0 ? (starCount / count) * 100 : 0;

                return (
                  <li key={star} className="flex items-center gap-2.5">
                    <span className="w-8 shrink-0 text-xs text-foreground-muted">
                      {star} star
                    </span>

                    <span
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted"
                      role="img"
                      aria-label={`${star} star: ${starCount} ${
                        starCount === 1 ? "review" : "reviews"
                      }`}
                    >
                      <span
                        className="block h-full rounded-full bg-brand-500 transition-[width] duration-500 ease-[var(--ease-out-soft)]"
                        style={{ width: `${percent}%` }}
                      />
                    </span>

                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-foreground-muted">
                      {starCount}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ── The reviews ──────────────────────────────────────────── */}
          <ul className="space-y-4">
            {reviews.reviews.map((review) => (
              <li
                key={review.id}
                className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {review.authorName}
                    </p>

                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Rating average={review.rating} size="sm" />

                      {review.isVerifiedBuyer ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          <CheckIcon width={11} height={11} />
                          Verified purchase
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <time
                    dateTime={review.createdAt.toISOString()}
                    className="shrink-0 text-xs text-foreground-muted"
                  >
                    {formatDate(review.createdAt)}
                  </time>
                </div>

                <p className="mt-3 text-sm leading-relaxed text-foreground-muted">
                  {review.comment}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Formats a date for display.
 *
 * Fixed to `en-BD` so the server and the client agree on the string —
 * a locale-dependent default would produce a hydration mismatch on a
 * machine set to a different region.
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-BD", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
