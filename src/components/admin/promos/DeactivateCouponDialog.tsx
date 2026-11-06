"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The coupon deactivation dialog.
 *
 * ── Why "deactivate" and not "delete" ─────────────────────────────────────
 *
 * A coupon that has been redeemed has **history**. Deleting the row
 * would erase the record of the campaign — how many times it ran, when
 * it ran, what it was worth — and the orders that used it would point at
 * a code that no longer exists.
 *
 * So the ordinary path is "switch it off". The row stays, the audit entry
 * says it was deactivated, and the redemption count is preserved. This
 * is the same rule the product catalogue follows with archiving.
 *
 * ── Why the reason is mandatory ──────────────────────────────────────────
 *
 * Deactivating a coupon stops an advertised discount working, and a
 * customer holding that code is entitled to an explanation. The reason
 * is recorded in the audit log alongside the admin's name.
 */
export function DeactivateCouponDialog({
  couponId,
  couponCode,
  isActive,
}: {
  readonly couponId: string;
  readonly couponCode: string;
  /**
   * Whether the coupon is currently switched on.
   */
  readonly isActive: boolean;
}) {
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

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
   * Switches a coupon back on.
   *
   * Reactivating is **not** a change to what the coupon is worth, so it
   * does not need a reason — the same distinction the server draws.
   */
  async function handleReactivate() {
    if (isPending) return;

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/coupons/${couponId}`, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ isActive: true }),
      });

      const envelope = (await response.json()) as ApiEnvelope<unknown>;

      if (!envelope.ok) {
        setError(envelope.error.message);
        setIsPending(false);
        return;
      }

      setIsPending(false);
      setIsOpen(false);

      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was changed.");
      setIsPending(false);
    }
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending) return;

    if (!isActive) {
      await handleReactivate();
      return;
    }

    if (reason.trim().length === 0) {
      setError("Give a reason for deactivating the coupon.");
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/coupons/${couponId}/deactivate`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: reason.trim() }),
      });

      const envelope = (await response.json()) as ApiEnvelope<unknown>;

      if (!envelope.ok) {
        setError(envelope.error.message);
        setIsPending(false);
        return;
      }

      setIsPending(false);
      setIsOpen(false);
      setReason("");

      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was changed.");
      setIsPending(false);
    }
  }

  if (!isOpen) {
    if (!isActive) {
      return (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="inline-flex h-8 items-center rounded-full border border-border bg-surface px-3 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Switch off
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-8 items-center rounded-full border border-red-300 bg-red-50 px-3 text-xs font-medium text-red-800 transition-colors hover:border-red-400 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
      >
        Deactivate
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close the deactivation dialog"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="absolute inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="deactivate-coupon-title"
        className="relative w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="deactivate-coupon-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isActive ? "Deactivate coupon" : "Coupon is switched off"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isActive ? (
            <>
              <span className="font-medium uppercase text-foreground">
                {couponCode}
              </span>{" "}
              will stop working at checkout. The code and its redemption count
              are kept.
            </>
          ) : (
            <>
              <span className="font-medium uppercase text-foreground">
                {couponCode}
              </span>{" "}
              is switched off. You can put it back on.
            </>
          )}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {isActive ? (
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Reason <span className="text-red-600">*</span>
              </span>

              <input
                ref={inputRef}
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. the campaign ended early"
                maxLength={500}
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </label>
          ) : null}

          <p className="text-xs text-foreground-muted">
            {isActive
              ? "The reason is recorded in the audit log alongside your name."
              : "Switching a coupon back on does not change what it is worth, so it does not need a reason."}
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
              disabled={isPending || (isActive && reason.trim().length === 0)}
              className={[
                "inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60",
                isActive
                  ? "bg-red-700 hover:bg-red-800 focus-visible:ring-red-600"
                  : "bg-neutral-900 hover:bg-neutral-800 focus-visible:ring-neutral-900",
              ].join(" ")}
            >
              {isPending
                ? "Working…"
                : isActive
                  ? "Deactivate coupon"
                  : "Switch it back on"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
