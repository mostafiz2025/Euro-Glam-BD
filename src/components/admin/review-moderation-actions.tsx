"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The review moderation control.
 *
 * ── What the admin can do ────────────────────────────────────────────────
 *
 * The three actions map exactly onto the review state machine, and the
 * control offers **only** the legal ones:
 *
 *   PENDING  → APPROVE
 *   APPROVED → HIDE
 *   HIDDEN   → UNHIDE
 *
 * The buttons are derived from the review's current state, not from a
 * fixed list. A pending review has no "Hide" button, because hiding a
 * pending review is refused by the server — the review was never
 * published, so there is nothing to withdraw.
 *
 * Offering an action that will be refused is worse than not offering it:
 * the admin clicks, waits, and reads a conflict message that tells them
 * nothing they could not have been told by the button not being there.
 *
 * The server still enforces the same rules. The client-side gating is
 * a courtesy, not a control — the authoritative check is the
 * conditional `updateMany` in the service, which is what makes two
 * admins moderating the same review safe.
 */
export function ReviewModerationActions({
  reviewId,
  state,
}: {
  readonly reviewId: string;
  readonly state: "PENDING" | "APPROVED" | "HIDDEN";
}) {
  const router = useRouter();

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");

  async function moderate(action: "APPROVE" | "HIDE" | "UNHIDE") {
    if (isPending) return;

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/reviews/${reviewId}`, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action,
          reason: reason.trim() || undefined,
        }),
      });

      const payload = (await response.json()) as ApiEnvelope<unknown>;

      if (!payload.ok) {
        setError(payload.error.message);
        setIsPending(false);
        return;
      }

      setShowReason(false);
      setReason("");
      setIsPending(false);

      // The queue is now stale. Re-render it.
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was changed.");
      setIsPending(false);
    }
  }

  const actions =
    state === "PENDING"
      ? ([{ action: "APPROVE", label: "Approve", tone: "primary" }] as const)
      : state === "APPROVED"
        ? ([{ action: "HIDE", label: "Hide", tone: "outline" }] as const)
        : ([{ action: "UNHIDE", label: "Restore", tone: "primary" }] as const);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((entry) => (
          <button
            key={entry.action}
            type="button"
            onClick={() => moderate(entry.action)}
            disabled={isPending}
            className={[
              "inline-flex h-8 items-center rounded-full px-3.5 text-xs font-medium",
              "transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-60",
              entry.tone === "primary"
                ? "bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-600"
                : "border border-border bg-surface text-foreground-muted hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus-visible:ring-brand-500",
            ].join(" ")}
          >
            {isPending ? "Working…" : entry.label}
          </button>
        ))}

        {/*
          The reason is optional, but it is what makes the audit trail
          useful. So it is offered — just not required, and not in the
          way.
        */}
        <button
          type="button"
          onClick={() => setShowReason((value) => !value)}
          className="inline-flex h-8 items-center rounded-full px-2.5 text-xs font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
        >
          {showReason ? "Hide reason" : "Add reason"}
        </button>
      </div>

      {showReason ? (
        <label className="block">
          <span className="sr-only">Reason for the moderation</span>
          <input
            type="text"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why? (stored on the audit entry)"
            maxLength={500}
            className="h-9 w-full rounded-full border border-border bg-surface px-3 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
