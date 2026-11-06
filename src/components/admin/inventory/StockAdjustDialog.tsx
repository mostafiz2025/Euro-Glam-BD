"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The stock adjustment dialog.
 *
 * ── Why a modal, and why a signed delta ──────────────────────────────────
 *
 * The inventory list is a **table**. An inline "adjust" control on every
 * row puts a form on every row, which makes the table unreadable and
 * gives every row a chance to be submitted by accident.
 *
 * So the adjustment happens in a dialog: one control per row that opens
 * a focused form, with the product named, the current quantity shown,
 * and a single number to type.
 *
 * The number is a **signed delta** — "+10" to add ten, "-3" to remove
 * three — never "set to 42". See the note at the top of
 * `src/components/admin/stock-adjustment-form.tsx` for why: the stock
 * number is a *derived* value, and a concurrent checkout's deduction
 * would be silently destroyed by an absolute write.
 *
 * ── Why the client refuses a negative result, but the server still checks ──
 *
 * The dialog will not submit an adjustment that would drive the stock
 * below zero. That is a **courtesy**, not the guard: the server refuses
 * it too, and the server's refusal is the one that counts. A client-side
 * check can be bypassed; a conditional `updateMany` cannot.
 *
 * ── The reason is mandatory ──────────────────────────────────────────────
 *
 * The reason lands on the audit entry. An audit entry that says "stock
 * changed" with no reason cannot answer "why is this number different
 * from the count?", and the answer is the whole point of the trail.
 */
export function StockAdjustDialog({
  productId,
  productName,
  currentQuantity,
}: {
  readonly productId: string;
  readonly productName: string;
  readonly currentQuantity: number;
}) {
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when the dialog opens, so the admin can type
  // straight away.
  useEffect(() => {
    if (!isOpen) return;

    inputRef.current?.focus();
  }, [isOpen]);

  // Close on `Escape`.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      setIsOpen(false);
      setError(null);
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  /**
   * The quantity the adjustment would leave behind.
   *
   * `null` when the input is not a number yet.
   */
  const projected = (() => {
    const parsed = Number.parseInt(delta, 10);

    if (!Number.isFinite(parsed) || delta.trim().length === 0) return null;

    return currentQuantity + parsed;
  })();

  const wouldGoNegative = projected !== null && projected < 0;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending) return;

    const parsed = Number.parseInt(delta, 10);

    if (!Number.isFinite(parsed) || parsed === 0) {
      setError("Enter how many units to add or remove — for example 10 or -3.");
      return;
    }

    if (currentQuantity + parsed < 0) {
      setError(
        `That adjustment would leave the stock at ${currentQuantity + parsed}. The stock cannot go below zero.`,
      );
      return;
    }

    if (reason.trim().length === 0) {
      setError("Give a reason for the adjustment — it is recorded in the audit log.");
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/products/${productId}/stock`, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          delta: parsed,
          reason: reason.trim(),
        }),
      });

      const payload = (await response.json()) as ApiEnvelope<{
        product: { stockQuantity: number };
        previousQuantity: number;
        newQuantity: number;
      }>;

      if (!payload.ok) {
        // The server's message is the useful part — it names the
        // constraint that was hit. It is surfaced verbatim.
        setError(payload.error.message);
        setIsPending(false);
        return;
      }

      setDelta("");
      setReason("");
      setIsPending(false);
      setIsOpen(false);

      // The list on the server is now stale. Re-render it.
      router.refresh();
    } catch {
      setError("We could not reach the server. The stock is unchanged.");
      setIsPending(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-8 items-center rounded-full border border-border bg-surface px-3 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      >
        Adjust
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      {/* The scrim. Clicking it closes the dialog — the same affordance
       * as `Escape`, so there are two ways out and neither traps the
       * user. */}
      <button
        type="button"
        aria-label="Close the stock adjustment"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="absolute inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`stock-dialog-title-${productId}`}
        className="relative w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id={`stock-dialog-title-${productId}`}
          className="font-serif text-lg font-bold text-foreground"
        >
          Adjust stock
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          <span className="font-medium text-foreground">{productName}</span> —
          currently {currentQuantity} unit{currentQuantity === 1 ? "" : "s"}.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Change by
            </span>

            <input
              ref={inputRef}
              type="number"
              inputMode="numeric"
              step={1}
              value={delta}
              onChange={(event) => setDelta(event.target.value)}
              placeholder="+10 or -3"
              aria-describedby={`stock-dialog-hint-${productId}`}
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm tabular-nums text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p
            id={`stock-dialog-hint-${productId}`}
            className="text-xs text-foreground-muted"
          >
            {projected === null ? (
              "Type a signed number. Positive adds units, negative removes them."
            ) : wouldGoNegative ? (
              <span className="text-red-700">
                That would leave the stock at {projected}. The stock cannot go
                below zero.
              </span>
            ) : (
              `The stock would become ${projected}.`
            )}
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Reason <span className="text-red-600">*</span>
            </span>

            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. supplier delivery, damaged units"
              maxLength={500}
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p className="text-xs text-foreground-muted">
            The reason is recorded in the audit log alongside your name.
          </p>

          {error ? (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setError(null);
              }}
              className="inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isPending || wouldGoNegative}
              className="inline-flex h-9 items-center rounded-full bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
            >
              {isPending ? "Saving…" : "Save adjustment"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
