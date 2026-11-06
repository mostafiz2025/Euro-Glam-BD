"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The delete dialog for a discovery entity.
 *
 * ── Why one component serves all of them ──────────────────────────────────
 *
 * A category, a concern, a brand and a hero banner are deleted the
 * **same way**: the admin confirms, gives a reason, and the reason is
 * written to the audit log. Four copies of that would be four places for
 * the reason to become optional.
 *
 * ── Why the reason is mandatory ───────────────────────────────────────────
 *
 * A deletion is the one admin action that leaves nothing behind to
 * inspect. The reason is the only record of why it happened, and it is
 * stored alongside the admin's name — so the trail can answer the
 * question an admin asks after something has gone wrong.
 */
export function DiscoveryDeleteDialog({
  entity,
  id,
  name,
  endpoint,
  blockedReason,
}: {
  /**
   * Which kind of entity this is. Used in the copy.
   */
  readonly entity: "category" | "concern" | "brand" | "hero banner";
  /**
   * The entity's id.
   */
  readonly id: string;
  /**
   * The entity's name, shown in the copy.
   */
  readonly name: string;
  /**
   * The endpoint the delete is sent to.
   */
  readonly endpoint: string;
  /**
   * A reason the deletion is currently **impossible** — e.g. a category
   * that still holds products.
   *
   * When this is set, the button is disabled and the reason is shown, so
   * the admin learns *why* before they try rather than after.
   */
  readonly blockedReason?: string;
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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending) return;

    if (reason.trim().length === 0) {
      setError("Give a reason for the deletion.");
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`${endpoint}/${id}`, {
        method: "DELETE",
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

      // The list on the server is now stale. Re-render it.
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was changed.");
      setIsPending(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        disabled={Boolean(blockedReason)}
        title={blockedReason}
        className="inline-flex h-8 items-center rounded-full border border-red-300 bg-red-50 px-3 text-xs font-medium text-red-800 transition-colors hover:border-red-400 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      >
        Delete
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
        aria-label="Close the delete dialog"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="absolute inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="discovery-delete-title"
        className="relative w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="discovery-delete-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          Delete {entity}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          <span className="font-medium text-foreground">{name}</span> will be
          removed from the shop. This cannot be undone.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Reason <span className="text-red-600">*</span>
            </span>

            <input
              ref={inputRef}
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. the range was discontinued"
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
              disabled={isPending || reason.trim().length === 0}
              className="inline-flex h-9 items-center rounded-full bg-red-700 px-4 text-sm font-medium text-white transition-colors hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
            >
              {isPending ? "Deleting…" : `Delete ${entity}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
