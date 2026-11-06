"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { OrderStatusSelect } from "@/components/admin/orders/OrderStatusSelect";

import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The order status controls.
 *
 * ── Only the legal moves are offered ─────────────────────────────────────
 *
 * The order's fulfilment status moves **forward only**, through a closed
 * table:
 *
 *   PENDING    → PROCESSING, CANCELLED
 *   PROCESSING → SHIPPED, CANCELLED
 *   SHIPPED    → DELIVERED
 *   DELIVERED  → (terminal)
 *   CANCELLED  → (terminal)
 *
 * `SHIPPED → CANCELLED` is deliberately **absent**. The goods have left
 * the warehouse; a cancellation would be a lie, and the refund is a
 * separate operation with its own audit trail.
 *
 * The control derives its buttons from that table, so an admin is never
 * offered a move the server will refuse. The server still enforces it —
 * the authoritative check is the conditional `updateMany` in the
 * service, which is what makes two admins moving the same order safe.
 *
 * ── Why cancelling restores stock ────────────────────────────────────────
 *
 * Every permitted cancellation is pre-dispatch — `PENDING` or
 * `PROCESSING` — so the goods are still on the shelf, and putting them
 * back is correct. The missing `SHIPPED → CANCELLED` edge is exactly
 * what makes that rule safe. The restoration and the status change share
 * one transaction, so an order cannot be cancelled without the stock
 * coming back.
 *
 * ── Payment moves independently ──────────────────────────────────────────
 *
 * A cash-on-delivery order can be `SHIPPED` while the payment is still
 * `PENDING`, because the cash is collected on delivery. So the payment
 * axis has its own control, with its own transitions, and its own audit
 * action.
 *
 * ── Two components, one axis each ────────────────────────────────────────
 *
 * The two axes are rendered as **separate components** rather than one
 * component with two sections, because the order card lays them out
 * side by side in two columns — one column per axis. A single component
 * could not do that without the card reaching inside it.
 *
 * They share the mutation logic through `useOrderMutation`, so the
 * request, the pending state and the error handling are written once
 * and cannot drift apart.
 */

/**
 * The shared mutation hook.
 *
 * One place that knows how to PATCH an order, so the fulfilment and
 * payment controls cannot disagree about the request shape, the pending
 * state, or what happens when the server refuses.
 *
 * The pending key is the **axis** being written to, so the control that
 * was pressed shows its own spinner and the other one is left alone.
 */
function useOrderMutation() {
  const router = useRouter();

  const [pendingAxis, setPendingAxis] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  /**
   * The request.
   *
   * @param endpoint - `status` for fulfilment, `payment` for payment.
   * @param body     - The field to change.
   * @param reason   - The optional note for the audit entry.
   */
  async function mutate(
    orderId: string,
    endpoint: "status" | "payment",
    body: Record<string, string>,
    reason: string,
  ): Promise<void> {
    const response = await fetch(`/api/admin/orders/${orderId}/${endpoint}`, {
      method: "PATCH",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        reason: reason.trim() || undefined,
      }),
    });

    const payload = (await response.json()) as ApiEnvelope<unknown>;

    if (!payload.ok) {
      throw new Error(payload.error.message);
    }
  }

  return {
    pendingAxis,
    error,
    reason,
    setReason,
    setError,
    setPendingAxis,
    mutate,
    router,
  };
}

/**
 * The fulfilment controls.
 *
 * One axis: the order's place in the fulfilment pipeline.
 */
export function FulfilmentActions({
  orderId,
  status,
  permittedStatuses,
}: {
  readonly orderId: string;
  readonly status: string;
  readonly permittedStatuses: readonly string[];
}) {
  const {
    pendingAxis,
    error,
    reason,
    setReason,
    setError,
    setPendingAxis,
    mutate,
    router,
  } = useOrderMutation();

  const canCancel = status === "PENDING" || status === "PROCESSING";

  async function update(target: string): Promise<void> {
    setPendingAxis("status");
    setError(null);

    try {
      await mutate(orderId, "status", { status: target }, reason);
      setReason("");
      setPendingAxis(null);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not reach the server. Nothing was changed.",
      );
      setPendingAxis(null);
    }
  }

  /**
   * The dropdown's submit path.
   *
   * It goes through the **same** endpoint and the same reason field as
   * the buttons, so a change made from the dropdown is audited exactly
   * as a change made from a button — same action, same actor, same
   * before-and-after.
   */
  async function selectStatus(
    targetOrderId: string,
    target: string,
    targetReason: string,
  ): Promise<void> {
    await mutate(targetOrderId, "status", { status: target }, targetReason);

    setReason("");
  }

  if (permittedStatuses.length === 0) {
    return (
      <p className="text-xs text-foreground-muted">
        No further changes — this order is complete.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {/*
          The dropdown — one control, one target. This is what an
          operator moving a batch of orders reaches for.
        */}
        <OrderStatusSelect
          orderId={orderId}
          status={status}
          permittedStatuses={permittedStatuses}
          onSelect={selectStatus}
        />

        {/*
          The buttons — every legal move, visible at a glance.
          They answer "what can I do here?"; the dropdown answers
          "put this one order into X". Both stay.
        */}
        {permittedStatuses.map((target) => (
          <button
            key={target}
            type="button"
            onClick={() => {
              void update(target);
            }}
            disabled={pendingAxis !== null}
            className={[
              "inline-flex h-8 items-center rounded-full px-3 text-xs font-medium",
              "transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
              "disabled:pointer-events-none disabled:opacity-60",
              target === "CANCELLED"
                ? "border border-border bg-surface text-foreground-muted hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus-visible:ring-brand-500"
                : "bg-neutral-900 text-white hover:bg-neutral-800 focus-visible:ring-neutral-900",
            ].join(" ")}
          >
            {pendingAxis === "status" && target === status
              ? "Working…"
              : target.replace(/_/g, " ").toLowerCase()}
          </button>
        ))}
      </div>

      <ReasonField value={reason} onChange={setReason} />

      {canCancel ? (
        <p className="text-[11px] leading-relaxed text-foreground-muted">
          Cancelling before dispatch returns the reserved stock to the shelf.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The payment controls.
 *
 * One axis: where the money is.
 */
export function PaymentActions({
  orderId,
  permittedPaymentStatuses,
}: {
  readonly orderId: string;
  readonly permittedPaymentStatuses: readonly string[];
}) {
  const {
    pendingAxis,
    error,
    reason,
    setReason,
    setError,
    setPendingAxis,
    mutate,
    router,
  } = useOrderMutation();

  async function update(target: string): Promise<void> {
    setPendingAxis("payment");
    setError(null);

    try {
      await mutate(orderId, "payment", { paymentStatus: target }, reason);
      setReason("");
      setPendingAxis(null);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not reach the server. Nothing was changed.",
      );
      setPendingAxis(null);
    }
  }

  if (permittedPaymentStatuses.length === 0) {
    return (
      <p className="text-xs text-foreground-muted">
        No further changes — this payment is settled.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {permittedPaymentStatuses.map((target) => (
          <button
            key={target}
            type="button"
            onClick={() => {
              void update(target);
            }}
            disabled={pendingAxis !== null}
            className="inline-flex h-8 items-center rounded-full border border-border bg-surface px-3 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
          >
            {pendingAxis === "payment" ? "Working…" : null}

            {pendingAxis === "payment" ? null : (
              target.replace(/_/g, " ").toLowerCase()
            )}
          </button>
        ))}
      </div>

      <ReasonField value={reason} onChange={setReason} />

      {error ? (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The optional reason for a change.
 *
 * It sits under the buttons it applies to, and it is **shared by the
 * axis** — the fulfilment buttons and the payment buttons each have
 * their own, so a reason typed for one is never sent with the other.
 */
function ReasonField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="sr-only">Reason for the change</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Reason (optional)"
        maxLength={500}
        className="h-8 w-full max-w-xs rounded-full border border-border bg-surface px-3 text-xs text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
    </label>
  );
}
