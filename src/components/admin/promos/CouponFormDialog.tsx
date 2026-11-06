"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The coupon create / edit dialog.
 *
 * ── Why the discount is one field, not two ─────────────────────────────────
 *
 * The database stores the discount in **two mutually-exclusive columns**
 * — `percentOff` and `amountOffPaisa`, one of which is always null. The
 * form mirrors that: it shows **one** value input, whose unit follows the
 * discount type. A form with two inputs would let an admin fill in both
 * and then have the server reject the combination — the server is right
 * to reject it, but the form should never produce a combination the
 * server will refuse.
 *
 * ── Why a change of terms needs a reason ──────────────────────────────────
 *
 * The terms are a price reduction. "percentOff 10 → 20" with no reason
 * cannot answer "why", and the reason is the whole point of the trail.
 * The server refuses a terms change without one; this form asks for it up
 * front, so the admin is never surprised by a 400.
 *
 * Switching a coupon **on or off** is not a change to what it is worth,
 * so it does not need a reason — matching the server's rule exactly.
 */
export function CouponFormDialog({
  coupon,
}: {
  /**
   * The coupon being edited. `null` for an add.
   */
  readonly coupon?: {
    readonly id: string;
    readonly code: string;
    readonly description: string | null;
    readonly discountType: "PERCENTAGE" | "FIXED";
    readonly percentOff: number | null;
    readonly amountOffPaisa: number | null;
    readonly expiresAt: Date;
    readonly usageLimit: number | null;
  } | null;
}) {
  const router = useRouter();

  const isEdit = Boolean(coupon);

  const [isOpen, setIsOpen] = useState(false);
  const [code, setCode] = useState(coupon?.code ?? "");
  const [description, setDescription] = useState(coupon?.description ?? "");
  const [discountType, setDiscountType] = useState<
    "PERCENTAGE" | "FIXED"
  >(coupon?.discountType ?? "PERCENTAGE");
  const [value, setValue] = useState(() => {
    if (!coupon) return "";

    return coupon.discountType === "PERCENTAGE"
      ? String(coupon.percentOff ?? "")
      : String((coupon.amountOffPaisa ?? 0) / 100);
  });
  const [expiresAt, setExpiresAt] = useState(() =>
    coupon ? toDateInputValue(coupon.expiresAt) : defaultExpiry(),
  );
  const [usageLimit, setUsageLimit] = useState(
    coupon?.usageLimit != null ? String(coupon.usageLimit) : "",
  );
  const [reason, setReason] = useState("");

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    codeRef.current?.focus();
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
   * Whether this edit changes what the coupon is worth.
   *
   * Mirrors the server's rule **exactly**, because a form that asks for
   * a reason the server does not need is an annoyance, and a form that
   * does not ask for a reason the server *does* need is a 400 the admin
   * could not have anticipated.
   *
   * The server treats a change to the **usage limit** as a change to
   * what the coupon is worth: the limit decides how many times the
   * discount can be taken, so changing it changes the value of the
   * campaign. The expiry and the description are not part of that.
   */
  const termsChanged = (() => {
    if (!coupon) return false;

    if (discountType !== coupon.discountType) return true;

    if (discountType === "PERCENTAGE") {
      const next = parseInt(value, 10);

      if (Number.isFinite(next) && next !== coupon.percentOff) return true;
    } else {
      const next = toPaisa(value);

      if (next !== null && next !== coupon.amountOffPaisa) return true;
    }

    // The usage limit is part of the terms.
    const nextLimit = usageLimit.trim() === "" ? null : parseInt(usageLimit, 10);

    return nextLimit !== coupon.usageLimit;
  })();

  const reasonRequired = !isEdit || termsChanged;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending) return;

    const trimmedCode = code.trim();

    if (trimmedCode.length < 3) {
      setError("The code needs at least three characters.");
      return;
    }

    if (discountType === "PERCENTAGE") {
      const percent = parseInt(value, 10);

      if (!Number.isFinite(percent) || percent < 1 || percent > 100) {
        setError("The percentage must be a whole number from 1 to 100.");
        return;
      }
    } else {
      const amount = toPaisa(value);

      if (amount === null || amount <= 0) {
        setError("Enter an amount of taka greater than zero.");
        return;
      }
    }

    if (expiresAt.trim().length === 0) {
      setError("Choose an expiry date.");
      return;
    }

    const expiry = new Date(`${expiresAt}T23:59:59`);

    if (Number.isNaN(expiry.getTime())) {
      setError("That expiry date is not a valid date.");
      return;
    }

    if (expiry.getTime() <= Date.now()) {
      setError("The expiry date must be in the future.");
      return;
    }

    if (usageLimit.trim() !== "") {
      const limit = parseInt(usageLimit, 10);

      if (!Number.isFinite(limit) || limit < 1) {
        setError("The usage limit must be 1 or more — or leave it empty for no limit.");
        return;
      }
    }

    if (reasonRequired && reason.trim().length === 0) {
      setError(
        isEdit
          ? "Give a reason for the change to the discount — it is recorded in the audit log."
          : "Give a reason for creating this coupon — it is recorded in the audit log.",
      );
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        description: description.trim() || null,
        discountType,
        expiresAt: expiry.toISOString(),
        usageLimit:
          usageLimit.trim() === "" ? null : parseInt(usageLimit, 10),
      };

      if (discountType === "PERCENTAGE") {
        body.percentOff = parseInt(value, 10);
      } else {
        body.amountOffPaisa = toPaisa(value);
      }

      if (reason.trim().length > 0) body.reason = reason.trim();

      if (coupon) {
        const response = await fetch(`/api/admin/coupons/${coupon.id}`, {
          method: "PATCH",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const envelope = (await response.json()) as ApiEnvelope<unknown>;

        if (!envelope.ok) {
          setError(envelope.error.message);
          setIsPending(false);
          return;
        }
      } else {
        body.code = trimmedCode.toUpperCase();

        const response = await fetch("/api/admin/coupons", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const envelope = (await response.json()) as ApiEnvelope<unknown>;

        if (!envelope.ok) {
          setError(envelope.error.message);
          setIsPending(false);
          return;
        }
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
        className="inline-flex h-9 items-center rounded-full bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
      >
        {isEdit ? "Edit" : "Add coupon"}
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close the coupon form"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="fixed inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="coupon-form-title"
        className="relative my-8 w-full max-w-xl rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="coupon-form-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isEdit ? "Edit coupon" : "Add coupon"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isEdit
            ? "Only the fields you change are saved. A change to what the coupon is worth needs a reason."
            : "The code goes live as soon as you save it."}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">Code</span>

            <input
              ref={codeRef}
              type="text"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={40}
              required
              readOnly={isEdit}
              aria-describedby="coupon-code-hint"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm uppercase tracking-wide text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200 read-only:bg-surface-muted"
            />
          </label>

          <p id="coupon-code-hint" className="text-xs text-foreground-muted">
            {isEdit
              ? "The code cannot be changed — a code customers already hold has to keep working."
              : "Letters, numbers, dashes and underscores. Stored in uppercase, so EID2026 and eid2026 are the same coupon."}
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Description
            </span>

            <input
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={200}
              placeholder="e.g. Eid collection launch"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Discount type
              </span>

              <select
                value={discountType}
                onChange={(event) => {
                  setDiscountType(
                    event.target.value === "FIXED" ? "FIXED" : "PERCENTAGE",
                  );
                  // The value's unit changes with the type, so the old
                  // number is meaningless under the new one.
                  setValue("");
                }}
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                <option value="PERCENTAGE">Percentage off</option>
                <option value="FIXED">Fixed amount off</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                {discountType === "PERCENTAGE" ? "Percent off" : "Amount off (BDT)"}
              </span>

              <input
                type="number"
                inputMode={discountType === "PERCENTAGE" ? "numeric" : "decimal"}
                step={discountType === "PERCENTAGE" ? 1 : 0.01}
                min={discountType === "PERCENTAGE" ? 1 : 0.01}
                max={discountType === "PERCENTAGE" ? 100 : undefined}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
                placeholder={discountType === "PERCENTAGE" ? "20" : "150"}
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm tabular-nums text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Expires on
              </span>

              <input
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                required
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Usage limit
              </span>

              <input
                type="number"
                inputMode="numeric"
                step={1}
                min={1}
                value={usageLimit}
                onChange={(event) => setUsageLimit(event.target.value)}
                placeholder="No limit"
                aria-describedby="coupon-usage-hint"
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm tabular-nums text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </label>
          </div>

          <p id="coupon-usage-hint" className="text-xs text-foreground-muted">
            How many times the code may be redeemed. Leave it empty for no
            limit.
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Reason{" "}
              {reasonRequired ? (
                <span className="text-red-600">*</span>
              ) : (
                <span className="font-normal">(optional)</span>
              )}
            </span>

            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                isEdit
                  ? "e.g. matching the Eid campaign"
                  : "e.g. Eid collection launch"
              }
              maxLength={500}
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

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
              disabled={isPending}
              className="inline-flex h-9 items-center rounded-full bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
            >
              {isPending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Add coupon"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Converts a taka string to poisha.
 *
 * `null` when the input is not a number. The API works in poisha — an
 * integer — and the conversion happens here, at the edge, so the integer
 * money type never has to survive a `parseFloat`.
 */
function toPaisa(value: string): number | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) return null;

  const parsed = Number.parseFloat(trimmed);

  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return Math.round(parsed * 100);
}

/**
 * Formats a date for a `<input type="date">`.
 *
 * The `YYYY-MM-DD` shape, in **local** time. `toISOString()` would
 * convert to UTC, which can shift the day backwards for anyone east of
 * Greenwich — and a coupon that expires "on the 30th" must not quietly
 * become the 29th.
 */
function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * The default expiry — 30 days out.
 *
 * A coupon with no expiry is a coupon that never ends, which is almost
 * never what an admin means when they add one. Thirty days is the
 * longest sensible default for a campaign.
 */
function defaultExpiry(): string {
  const date = new Date();

  date.setDate(date.getDate() + 30);

  return toDateInputValue(date);
}
