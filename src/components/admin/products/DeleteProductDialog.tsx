"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The product delete dialog.
 *
 * ── Why "delete" means archive ───────────────────────────────────────────
 *
 * `OrderItem.productId` is `onDelete: Restrict`, and the order line
 * snapshots the product's name and price *precisely so that history
 * survives*. So a product that has ever been ordered cannot be removed
 * from the database without destroying the record of that sale.
 *
 * So this dialog has **two** modes, and archive is the default:
 *
 *   • **Archive** — withdraws the product. It disappears from every
 *     storefront query, and the order history survives. It can be
 *     restored later. This is almost always the right answer.
 *   • **Delete outright** — removes the row. Possible only for a
 *     product with no order items, no cart items and no reviews. The
 *     server refuses it otherwise, and says why.
 *
 * ── Why the confirmation is typed ────────────────────────────────────────
 *
 * A destructive action with one click is a destructive action somebody
 * will do by accident. Typing the product's name is the standard
 * confirmation for "this exact thing" — it is unambiguous, and it
 * cannot be satisfied by a stray keystroke.
 *
 * ── Why the reason is mandatory ──────────────────────────────────────────
 *
 * A deletion is the one admin action that leaves nothing behind to
 * inspect, so the record of why is the only thing that remains.
 */
export function DeleteProductDialog({
  productId,
  productName,
  isArchived,
  canHardDelete,
}: {
  readonly productId: string;
  readonly productName: string;
  /**
   * Whether the product is already archived.
   */
  readonly isArchived: boolean;
  /**
   * Whether a hard delete is possible at all — that is, whether the
   * product has no order items, no cart items and no reviews.
   */
  readonly canHardDelete: boolean;
}) {
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<"archive" | "hard">("archive");
  const [confirmName, setConfirmName] = useState("");
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

  const nameMatches = confirmName.trim() === productName.trim();

  /**
   * Restores the product to the storefront.
   *
   * Restoration is a **commercial decision**, exactly like archiving, so
   * it asks for a reason and writes its own audit entry. It does not
   * ask for the typed name — nothing is being destroyed.
   */
  async function handleRestore() {
    if (isPending) return;

    if (reason.trim().length === 0) {
      setError("Give a reason for putting the product back on sale.");
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/products/${productId}/restore`, {
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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending) return;

    if (isArchived) {
      await handleRestore();
      return;
    }

    if (!nameMatches) {
      setError("Type the product's name exactly to confirm.");
      return;
    }

    if (reason.trim().length === 0) {
      setError("Give a reason — it is the only thing left behind.");
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/products/${productId}`, {
        method: "DELETE",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          confirmName: confirmName.trim(),
          reason: reason.trim(),
          mode,
        }),
      });

      const envelope = (await response.json()) as ApiEnvelope<unknown>;

      if (!envelope.ok) {
        setError(envelope.error.message);
        setIsPending(false);
        return;
      }

      setIsPending(false);
      setIsOpen(false);
      setConfirmName("");
      setReason("");

      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was changed.");
      setIsPending(false);
    }
  }

  if (!isOpen) {
    if (isArchived) {
      return (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="inline-flex h-8 items-center rounded-full border border-border bg-surface px-3 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Archived
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-8 items-center rounded-full border border-red-300 bg-red-50 px-3 text-xs font-medium text-red-800 transition-colors hover:border-red-400 hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
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
        aria-labelledby="delete-product-title"
        className="relative w-full max-w-md rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="delete-product-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isArchived ? "Product is archived" : "Delete product"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isArchived ? (
            <>
              <span className="font-medium text-foreground">{productName}</span>{" "}
              is withdrawn from the storefront. You can put it back on sale.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{productName}</span>{" "}
              will be removed from the catalogue.
            </>
          )}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {!isArchived ? (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-foreground-muted">
                How should it be removed?
              </legend>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-border p-3 has-checked:border-brand-300 has-checked:bg-brand-50">
                <input
                  type="radio"
                  name="mode"
                  value="archive"
                  checked={mode === "archive"}
                  onChange={() => setMode("archive")}
                  className="mt-0.5 h-4 w-4 text-brand-600 focus:ring-brand-400"
                />

                <span>
                  <span className="block text-sm font-medium text-foreground">
                    Archive it
                  </span>
                  <span className="block text-xs text-foreground-muted">
                    Withdrawn from the storefront, kept in the database so the
                    order history survives. It can be restored.
                  </span>
                </span>
              </label>

              <label
                className={[
                  "flex items-start gap-2.5 rounded-2xl border p-3",
                  canHardDelete
                    ? "cursor-pointer border-border has-checked:border-red-300 has-checked:bg-red-50"
                    : "border-border opacity-60",
                ].join(" ")}
              >
                <input
                  type="radio"
                  name="mode"
                  value="hard"
                  checked={mode === "hard"}
                  onChange={() => setMode("hard")}
                  disabled={!canHardDelete}
                  className="mt-0.5 h-4 w-4 text-red-600 focus:ring-red-400"
                />

                <span>
                  <span className="block text-sm font-medium text-foreground">
                    Delete it outright
                  </span>
                  <span className="block text-xs text-foreground-muted">
                    {canHardDelete
                      ? "Removes the row from the database. The order history for it is gone for good."
                      : "Not possible — this product has been ordered, carted or reviewed. Archive it instead."}
                  </span>
                </span>
              </label>
            </fieldset>
          ) : null}

          {!isArchived ? (
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Type the product&apos;s name to confirm
              </span>

              <input
                ref={inputRef}
                type="text"
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                placeholder={productName}
                autoComplete="off"
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />

              {confirmName.length > 0 && !nameMatches ? (
                <span className="mt-1 block text-xs text-red-700">
                  That does not match the product&apos;s name.
                </span>
              ) : null}
            </label>
          ) : null}

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Reason <span className="text-red-600">*</span>
            </span>

            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                isArchived
                  ? "e.g. the supplier has restocked it"
                  : "e.g. discontinued by the supplier"
              }
              maxLength={500}
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p className="text-xs text-foreground-muted">
            {isArchived
              ? "The reason is recorded in the audit log alongside your name."
              : "The reason is recorded in the audit log alongside your name. It is the only thing left behind."}
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
              disabled={
                isPending ||
                reason.trim().length === 0 ||
                (!isArchived && !nameMatches)
              }
              className={[
                "inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60",
                isArchived
                  ? "bg-neutral-900 hover:bg-neutral-800 focus-visible:ring-neutral-900"
                  : "bg-red-700 hover:bg-red-800 focus-visible:ring-red-600",
              ].join(" ")}
            >
              {isPending
                ? "Working…"
                : isArchived
                  ? "Put back on sale"
                  : mode === "hard"
                    ? "Delete for good"
                    : "Archive product"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
