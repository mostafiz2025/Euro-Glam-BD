"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { StarInput } from "@/components/commerce/star-input";
import { Button } from "@/components/ui/button";
import { CheckIcon, WarningIcon } from "@/components/ui/icons";

/**
 * The review submission form.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The customer is told the truth about what happens next.**
 *
 * A submitted review is *pending* — an admin has to approve it. The
 * form says so after a successful submission, in those words, rather
 * than showing a success toast that implies the review is already
 * public. A review that vanishes with no explanation is
 * indistinguishable from a bug, and the customer's most likely reaction
 * is to assume the shop ignored them.
 *
 * **2. The envelope is checked, not assumed.**
 *
 * Every response discriminates on `ok` first. A client that reads
 * `result.review` without checking will throw a `TypeError` on an
 * error response, and the customer will see "cannot read properties of
 * undefined" instead of the reason their review was refused.
 *
 * **3. The field errors come from the server.**
 *
 * The server's Zod messages are shown verbatim, keyed by field. The
 * client does not re-implement the rules — a second implementation of
 * the rating bounds would eventually disagree with the first.
 *
 * **4. The button cannot be double-fired.**
 *
 * `isPending` is the single source of truth, so a double-tap produces
 * one request. Two reviews from one tap would be caught by the
 * duplicate check on the server, but the customer would see a confusing
 * "you have already reviewed this" error for a review they never
 * managed to write twice.
 */
export type ReviewFormProps = {
  /** The product being reviewed. */
  readonly productId: string;
  /** The product's name, for the confirmation message. */
  readonly productName: string;
  /** Whether the customer already has a published review. */
  readonly hasReviewed: boolean;
};

export function ReviewForm({
  productId,
  productName,
  hasReviewed,
}: ReviewFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [purchased, setPurchased] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);

  /**
   * Submits the review.
   */
  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    // A rating of zero is not a rating. It is caught here as well as on
    // the server, because the customer should learn it immediately
    // rather than after a round-trip.
    if (rating < 1) {
      setFieldErrors({ rating: "Choose a rating from 1 to 5 stars." });
      return;
    }

    startTransition(async () => {
      setError(null);
      setFieldErrors({});

      try {
        const response = await fetch(`/api/products/${productId}/reviews`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rating, comment, purchased }),
        });

        const result = (await response.json()) as {
          ok: boolean;
          data?: {
            review?: { id: string; moderationStatus: "PENDING" | "APPROVED" };
          };
          error?: {
            message: string;
            details?: { fieldErrors?: Record<string, string[]> };
          };
        };

        if (!result.ok) {
          setError(result.error?.message ?? "We could not save your review.");

          const details = result.error?.details;

          if (details?.fieldErrors) {
            setFieldErrors(
              Object.fromEntries(
                Object.entries(details.fieldErrors).map(([key, messages]) => [
                  key,
                  messages?.[0] ?? "This value is not valid.",
                ]),
              ),
            );
          }

          return;
        }

        // The review is in. The page is refreshed so the summary and
        // the list reflect the new state.
        setSubmitted(true);
        setRating(0);
        setComment("");
        setPurchased(false);
        router.refresh();
      } catch {
        setError(
          "We could not reach the shop. Please check your connection and try again.",
        );
      }
    });
  }

  // ── The confirmation ───────────────────────────────────────────────────
  if (submitted) {
    return (
      <div
        role="status"
        className="rounded-[var(--radius-card)] border border-emerald-200 bg-emerald-50 p-5"
      >
        <p className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
          <CheckIcon width={16} height={16} />
          Thank you — your review is in.
        </p>

        <p className="mt-2 text-xs leading-relaxed text-emerald-700">
          Every review is read by our team before it appears on the page, so
          yours is <strong>waiting for approval</strong>. It will show up on
          the {productName} page once it has been checked — usually within a
          day.
        </p>

        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSubmitted(false);
            }}
          >
            Write another review
          </Button>
        </div>
      </div>
    );
  }

  // ── The already-reviewed state ─────────────────────────────────────────
  if (hasReviewed) {
    return (
      <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5">
        <p className="text-sm font-semibold text-foreground">
          You have already reviewed this product
        </p>

        <p className="mt-1.5 text-xs leading-relaxed text-foreground-muted">
          Thank you — your review is already published below. Only one
          review per customer per product can be published.
        </p>
      </div>
    );
  }

  // ── The form ───────────────────────────────────────────────────────────
  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]"
    >
      <h3 className="text-sm font-bold text-foreground">
        Write a review
      </h3>

      <p className="mt-1 text-xs text-foreground-muted">
        Reviews are read by our team before they appear on the page.
      </p>

      <div className="mt-4 space-y-4">
        {/* ── The rating ────────────────────────────────────────────── */}
        <div>
          <span className="block text-xs font-semibold text-foreground-muted">
            Your rating
          </span>

          <div className="mt-1.5">
            <StarInput
              name="rating"
              value={rating}
              onChange={(value) => {
                setRating(value);
                setFieldErrors((current) => {
                  const next = { ...current };
                  delete next.rating;
                  return next;
                });
              }}
              error={fieldErrors.rating}
              disabled={isPending}
            />
          </div>
        </div>

        {/* ── The comment ───────────────────────────────────────────── */}
        <div>
          <label
            htmlFor="review-comment"
            className="block text-xs font-semibold text-foreground-muted"
          >
            Your review
          </label>

          <textarea
            id="review-comment"
            name="comment"
            rows={4}
            maxLength={2000}
            required
            value={comment}
            disabled={isPending}
            onChange={(event) => {
              setComment(event.target.value);
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.comment;
                return next;
              });
            }}
            aria-invalid={fieldErrors.comment ? true : undefined}
            aria-describedby={
              fieldErrors.comment ? "review-comment-error" : "review-comment-hint"
            }
            placeholder="How did it work for your skin? What did you like or dislike?"
            className={[
              "mt-1.5 w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm text-foreground",
              "transition-colors placeholder:text-foreground-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              "disabled:opacity-60",
              fieldErrors.comment
                ? "border-red-300 focus-visible:ring-red-400"
                : "border-border focus-visible:border-brand-400",
            ].join(" ")}
          />

          {fieldErrors.comment ? (
            <p
              id="review-comment-error"
              role="alert"
              className="mt-1.5 text-xs text-red-600"
            >
              {fieldErrors.comment}
            </p>
          ) : (
            <p id="review-comment-hint" className="mt-1.5 text-[11px] text-foreground-muted">
              {comment.length}/2000 characters. At least 10.
            </p>
          )}
        </div>

        {/* ── The purchase claim ────────────────────────────────────── */}
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={purchased}
            disabled={isPending}
            onChange={(event) => setPurchased(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
          <span className="text-xs leading-relaxed text-foreground-muted">
            I bought this product. (We check this against our order records
            before marking a review as a verified purchase.)
          </span>
        </label>

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 text-xs text-red-600"
          >
            <WarningIcon width={14} height={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>

      <div className="mt-5">
        <Button type="submit" variant="primary" size="md" disabled={isPending}>
          {isPending ? "Submitting…" : "Submit review"}
        </Button>
      </div>
    </form>
  );
}
