"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { CheckIcon, TagIcon } from "@/components/ui/icons";
import { formatPaisa } from "@/lib/format/money";
import type { AppliedCoupon, PublicCoupon } from "@/lib/format/types";

/**
 * The discount-code helper.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The client never computes the discount.**
 *
 * The component sends a **code** and the server answers with the cart and
 * the coupon's worth. The figure shown here is the one the server sent —
 * the same number the checkout will charge. A client that re-derived the
 * discount would be a second implementation of a pricing rule, and the
 * two would drift.
 *
 * **2. A failed apply leaves the cart exactly as it was.**
 *
 * The same rule the cart's own mutations follow: the client never
 * optimistically removes a discount it has not been given. An optimistic
 * removal that the server rejects leaves the customer looking at a
 * discount they do not have.
 *
 * **3. The active codes are listed.**
 *
 * A customer who has been told about a code should be able to find it
 * without remembering it. The list is the codes that are live right now,
 * each one a button that fills the field.
 *
 * **4. The applied code can always be taken off.**
 *
 * A customer who applied a code by mistake must be able to remove it
 * without asking a shop assistant. That is not a nicety — it is the
 * difference between a promotion and a trap.
 */
export type CouponBoxProps = {
  /**
   * The code currently applied to the cart, or `null`.
   *
   * `null` covers both "no code" and "a code that has become unusable
   * since it was applied" — the second resolves to `null` on the server
   * too, and the customer is told why.
   */
  readonly applied: AppliedCoupon | null;

  /**
   * The codes that are live right now.
   *
   * The shop floor's list — the same list the announcement bar shows.
   */
  readonly available: readonly PublicCoupon[];

  /**
   * A code to pre-fill the field with.
   *
   * This is how the announcement bar's links work: they carry the code
   * in the query string, and the helper opens with it already in the
   * field. The customer presses apply.
   */
  readonly suggestedCode?: string | null;
};

/**
 * The discount-code helper.
 */
export function CouponBox({
  applied,
  available,
  suggestedCode,
}: CouponBoxProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [code, setCode] = useState(suggestedCode ?? "");
  const [error, setError] = useState<string | null>(null);

  /**
   * Sends the code to the server.
   *
   * The server has the authority on what a code is worth, so the page is
   * refreshed from it rather than patched locally. The whole cart is
   * replaced, because applying a code changes the totals and can change
   * the free-shipping threshold.
   */
  function applyCode(): void {
    const trimmed = code.trim();

    if (trimmed.length === 0) {
      setError("Enter a discount code.");
      return;
    }

    startTransition(async () => {
      setError(null);

      try {
        const response = await fetch("/api/cart/coupon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: trimmed }),
        });

        const result = (await response.json()) as {
          ok: boolean;
          error?: { message: string };
        };

        if (!result.ok) {
          setError(result.error?.message ?? "That code could not be applied.");
          return;
        }

        setCode("");
        router.refresh();
      } catch {
        setError("We could not reach the server. Your cart is unchanged.");
      }
    });
  }

  /**
   * Takes the code off the cart.
   *
   * Always allowed — a customer who applied a code by mistake must be
   * able to remove it themselves.
   */
  function removeCode(): void {
    startTransition(async () => {
      setError(null);

      try {
        const response = await fetch("/api/cart/coupon", { method: "DELETE" });

        const result = (await response.json()) as {
          ok: boolean;
          error?: { message: string };
        };

        if (!result.ok) {
          setError(result.error?.message ?? "That code could not be removed.");
          return;
        }

        router.refresh();
      } catch {
        setError("We could not reach the server. Your cart is unchanged.");
      }
    });
  }

  return (
    <div className="mt-5 rounded-2xl border border-border bg-surface-muted/50 p-4">
      <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-foreground">
        <TagIcon width={14} height={14} />
        Discount code
      </h3>

      {/* ── The applied code ────────────────────────────────────────── */}
      {applied ? (
        <div className="mt-3 rounded-xl border border-brand-300 bg-brand-50 p-3 dark:border-brand-700 dark:bg-brand-950/50">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 font-mono text-sm font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                <CheckIcon width={14} height={14} />
                {applied.code}
              </p>

              <p className="mt-1 text-xs text-foreground-muted">
                {applied.label} · you save{" "}
                <span className="font-semibold text-brand-700 dark:text-brand-300">
                  {formatPaisa(applied.discountPaisa)}
                </span>
              </p>
            </div>

            <button
              type="button"
              onClick={removeCode}
              disabled={isPending}
              className="shrink-0 text-[11px] font-medium text-foreground-muted underline underline-offset-2 transition-colors hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ── The entry field ─────────────────────────────────────── */}
          <div className="mt-3 flex gap-2">
            <label htmlFor="coupon-code" className="sr-only">
              Discount code
            </label>

            <input
              id="coupon-code"
              name="couponCode"
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyCode();
                }
              }}
              placeholder="Enter code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-describedby={error ? "coupon-error" : undefined}
              aria-invalid={error ? true : undefined}
              className={[
                "h-10 min-w-0 flex-1 rounded-xl border bg-surface px-3 font-mono text-sm uppercase tracking-wide text-foreground",
                "transition-colors placeholder:font-sans placeholder:normal-case placeholder:tracking-normal placeholder:text-foreground-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                error ? "border-red-300" : "border-border focus-visible:border-brand-400",
              ].join(" ")}
            />

            <Button
              type="button"
              variant="outline"
              size="md"
              onClick={applyCode}
              disabled={isPending}
            >
              {isPending ? "Applying…" : "Apply"}
            </Button>
          </div>

          {error ? (
            <p id="coupon-error" role="alert" className="mt-2 text-xs text-red-600">
              {error}
            </p>
          ) : null}
        </>
      )}

      {/* ── The live codes ──────────────────────────────────────────── */}
      {available.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-foreground-muted">
            Available offers
          </p>

          <ul className="mt-2 space-y-1.5">
            {available.map((coupon) => (
              <li key={coupon.code}>
                <button
                  type="button"
                  onClick={() => {
                    setCode(coupon.code);
                    setError(null);
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <span className="min-w-0">
                    <span className="font-mono text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-300">
                      {coupon.code}
                    </span>
                    <span className="ml-2 text-xs text-foreground-muted">
                      {coupon.label}
                    </span>
                  </span>

                  <span className="shrink-0 text-[11px] font-medium text-foreground-muted">
                    Use code
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
