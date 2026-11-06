"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The order status dropdown.
 *
 * ── What this adds to the existing buttons ───────────────────────────────
 *
 * The order row already offers the legal moves as buttons. The dropdown
 * is the same moves, presented as a **single control** — which is what
 * an operator moving a batch of orders actually wants: one target per
 * order, chosen from a list, rather than a row of two or three buttons
 * that differ from order to order.
 *
 * The two presentations are not redundant. A row of buttons answers
 * "what can I do here?" at a glance. A dropdown answers "put this one
 * order into X" with one click and one target. Both stay.
 *
 * ── Only the legal moves are in the list ──────────────────────────────────
 *
 * The list is built from `permittedStatuses`, which the server derives
 * from the closed transition table. An admin is never offered a move the
 * server will refuse.
 *
 * And the server still enforces it. The authoritative check is the
 * conditional `updateMany` in the service — the one that makes two
 * admins moving the same order safe. The dropdown is a convenience; the
 * service is the guard.
 *
 * ── Why it is a listbox and not a `<select>` ──────────────────────────────
 *
 * A native `<select>` cannot say "no further changes" for a terminal
 * order without being disabled, and it cannot show the cancellation
 * warning. A native `<select>` also renders its popup with the operating
 * system's own chrome, which cannot be themed — so it would be the one
 * control on the page that ignores the dark mode.
 *
 * The listbox below is keyboard-operable, closes on `Escape`, closes on an
 * outside click, and is themed.
 */
export function OrderStatusSelect({
  orderId,
  status,
  permittedStatuses,
  onSelect,
}: {
  readonly orderId: string;
  readonly status: string;
  readonly permittedStatuses: readonly string[];
  readonly onSelect: (
    orderId: string,
    target: string,
    reason: string,
  ) => Promise<void>;
}) {
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on an outside click.
  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target;

      if (!(target instanceof Node)) return;

      if (containerRef.current?.contains(target)) return;

      setIsOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [isOpen]);

  // Close on `Escape`, and return the focus to the trigger — which is
  // where a keyboard user expects it to be when they cancel.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      setIsOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  if (permittedStatuses.length === 0) {
    return (
      <span className="text-xs text-foreground-muted">No further changes</span>
    );
  }

  async function choose(target: string) {
    if (isPending) return;

    setIsPending(true);
    setError(null);
    setIsOpen(false);

    try {
      await onSelect(orderId, target, "");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not reach the server. Nothing was changed.",
      );
      setIsPending(false);
    }
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        disabled={isPending}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={[
          "inline-flex h-8 items-center gap-1.5 rounded-full border border-border",
          "bg-surface px-3 text-xs font-medium text-foreground-muted",
          "transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          "disabled:pointer-events-none disabled:opacity-60",
        ].join(" ")}
      >
        {isPending ? "Working…" : "Move to"}

        <span aria-hidden="true" className="text-[10px]">
          ▾
        </span>
      </button>

      {isOpen ? (
        <ul
          role="listbox"
          aria-label="Choose the new fulfilment status"
          className="absolute left-0 z-30 mt-1 min-w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          {permittedStatuses.map((target) => (
            <li key={target} role="none">
              <button
                type="button"
                role="option"
                aria-selected={target === status}
                onClick={() => choose(target)}
                className={[
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs",
                  "transition-colors hover:bg-surface-muted",
                  "focus-visible:outline-none focus-visible:bg-surface-muted",
                  target === "CANCELLED"
                    ? "text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/10"
                    : "text-foreground",
                ].join(" ")}
              >
                <span>{target.replace(/_/g, " ").toLowerCase()}</span>

                {target === status ? (
                  <span aria-hidden="true" className="text-foreground-muted">
                    ✓
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p role="alert" className="absolute left-0 top-full mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The envelope shape the order API returns.
 */
export type OrderStatusEnvelope = ApiEnvelope<unknown>;
