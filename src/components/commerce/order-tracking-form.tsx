"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { CheckIcon, WarningIcon } from "@/components/ui/icons";
import {
  ORDER_STATUS_LABELS,
  ORDER_TIMELINE_STEPS,
  orderStatusNote,
  orderStatusTone,
  paymentStatusLabel,
  paymentStatusTone,
} from "@/lib/format/order-status";
import { formatPaisa } from "@/lib/format/money";
import { paymentMethodLabel } from "@/lib/format/payment";

/**
 * The guest order-tracking form.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The envelope is checked, not assumed.**
 *
 * Every response discriminates on `ok` first. A client that reads
 * `result.order` without checking will throw a `TypeError` on an error
 * response, and the customer will see "cannot read properties of
 * undefined" instead of the reason their order was not found.
 *
 * **2. The order's status is shown in words, not codes.**
 *
 * `PROCESSING` is what the database calls it. "Preparing" is what it
 * means. The vocabulary lives in `src/lib/format/order-status.ts`, which
 * is the one place it is defined — the same way the storefront's other
 * order surfaces read it, so a customer who checks their order here and
 * then signs in to their account sees the same words.
 *
 * **3. The timeline shows where the order is, and what is still to come.**
 *
 * A journey of four steps, with the current one marked. It is the same
 * shape the signed-in order page uses, because it is the same journey.
 *
 * **4. The failure is honest and does not leak.**
 *
 * The server answers a wrong order number and a wrong contact detail
 * with the same message, and the form shows that message verbatim. The
 * form does not try to work out which of the two was wrong, because the
 * server does not know either — and a form that guesses would tell an
 * attacker which half of the guess to keep.
 *
 * **5. The button cannot be double-fired.**
 *
 * `isPending` is the single source of truth, so a double-tap produces
 * one request. Ten failed attempts are the hourly limit, and a customer
 * who taps twice would burn two of them for one question.
 */

/**
 * The order, as the tracking endpoint returns it.
 *
 * Declared here rather than imported from the service so the **client
 * bundle** does not pull the service — and with it Prisma — into the
 * browser. The shape is the contract, and the contract is what the
 * browser needs.
 */
type TrackedOrder = {
  readonly orderNumber: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly paymentMethod: string;
  readonly totalAmountPaisa: number;
  readonly totalQuantity: number;
  readonly placedAt: string;
  readonly items: ReadonlyArray<{
    readonly name: string;
    readonly quantity: number;
    readonly pricePaisa: number;
  }>;
};

/**
 * The form's props.
 */
export type OrderTrackingFormProps = {
  /**
   * The shop's support email, if it has one.
   *
   * Shown beside the "not found" message, because a customer whose order
   * number has been mislaid needs a way to reach a human — and the
   * tracking page is exactly where they will look for one.
   */
  readonly supportEmail?: string;
};

export function OrderTrackingForm({ supportEmail }: OrderTrackingFormProps) {
  const [isPending, startTransition] = useTransition();

  const [orderNumber, setOrderNumber] = useState("");
  const [contact, setContact] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TrackedOrder | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    startTransition(async () => {
      setError(null);
      setFieldErrors({});
      setResult(null);

      try {
        const response = await fetch("/api/order-tracking", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orderNumber, contact }),
        });

        const payload = (await response.json()) as {
          ok: boolean;
          data?: { order?: TrackedOrder };
          error?: {
            message?: string;
            details?: { fieldErrors?: Record<string, string[]> };
          };
        };

        if (!payload.ok) {
          setError(
            payload.error?.message ??
              "We could not look that order up. Please try again in a moment.",
          );

          const details = payload.error?.details?.fieldErrors;

          if (details) {
            setFieldErrors(
              Object.fromEntries(
                Object.entries(details).map(([key, messages]) => [
                  key,
                  messages?.[0] ?? "This value is not valid.",
                ]),
              ),
            );
          }

          return;
        }

        const order = payload.data?.order;

        if (!order) {
          setError(
            "We could not look that order up. Please try again in a moment.",
          );

          return;
        }

        setResult(order);
      } catch {
        setError(
          "We could not reach the shop. Please check your connection and try again.",
        );
      }
    });
  }

  // ── The result ──────────────────────────────────────────────────────────
  if (result) {
    return (
      <div className="space-y-5">
        <TrackingResult order={result} />

        <div>
          <Button
            variant="outline"
            size="md"
            onClick={() => {
              setResult(null);
            }}
          >
            Track another order
          </Button>
        </div>
      </div>
    );
  }

  // ── The form ────────────────────────────────────────────────────────────
  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6"
    >
      <h2 className="font-serif text-lg font-bold tracking-tight text-foreground">
        Find your order
      </h2>

      <p className="mt-1.5 text-xs leading-relaxed text-foreground-muted">
        Enter the order number from your confirmation, together with the email
        address or phone number on the order. We need both so we know the order
        is yours.
      </p>

      <div className="mt-5 space-y-4">
        {/* ── The order number ─────────────────────────────────────── */}
        <div>
          <label
            htmlFor="tracking-order-number"
            className="block text-xs font-semibold text-foreground-muted"
          >
            Order number
          </label>

          <input
            id="tracking-order-number"
            name="orderNumber"
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            value={orderNumber}
            disabled={isPending}
            onChange={(event) => {
              setOrderNumber(event.target.value);
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.orderNumber;
                return next;
              });
            }}
            aria-invalid={fieldErrors.orderNumber ? true : undefined}
            aria-describedby={
              fieldErrors.orderNumber
                ? "tracking-order-number-error"
                : "tracking-order-number-hint"
            }
            placeholder="EGB-20261027-A1B2C3"
            className={[
              "mt-1.5 w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm text-foreground",
              "transition-colors placeholder:text-foreground-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              "disabled:opacity-60",
              fieldErrors.orderNumber
                ? "border-red-300 focus-visible:ring-red-400"
                : "border-border focus-visible:border-brand-400",
            ].join(" ")}
          />

          {fieldErrors.orderNumber ? (
            <p
              id="tracking-order-number-error"
              role="alert"
              className="mt-1.5 text-xs text-red-600"
            >
              {fieldErrors.orderNumber}
            </p>
          ) : (
            <p
              id="tracking-order-number-hint"
              className="mt-1.5 text-[11px] text-foreground-muted"
            >
              It is in your confirmation message, and on the label on your parcel.
            </p>
          )}
        </div>

        {/* ── The contact detail ───────────────────────────────────── */}
        <div>
          <label
            htmlFor="tracking-contact"
            className="block text-xs font-semibold text-foreground-muted"
          >
            Email address or phone number
          </label>

          <input
            id="tracking-contact"
            name="contact"
            type="text"
            required
            autoComplete="email"
            value={contact}
            disabled={isPending}
            onChange={(event) => {
              setContact(event.target.value);
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.contact;
                return next;
              });
            }}
            aria-invalid={fieldErrors.contact ? true : undefined}
            aria-describedby={
              fieldErrors.contact ? "tracking-contact-error" : undefined
            }
            placeholder="you@example.com or 01712345678"
            className={[
              "mt-1.5 w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm text-foreground",
              "transition-colors placeholder:text-foreground-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              "disabled:opacity-60",
              fieldErrors.contact
                ? "border-red-300 focus-visible:ring-red-400"
                : "border-border focus-visible:border-brand-400",
            ].join(" ")}
          />

          {fieldErrors.contact ? (
            <p
              id="tracking-contact-error"
              role="alert"
              className="mt-1.5 text-xs text-red-600"
            >
              {fieldErrors.contact}
            </p>
          ) : null}
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
          >
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-800">
              <WarningIcon
                width={14}
                height={14}
                className="mt-0.5 shrink-0"
              />
              <span>
                {error}
                {supportEmail ? (
                  <>
                    {" "}
                    If it still will not find it, write to us at{" "}
                    <a
                      href={`mailto:${supportEmail}`}
                      className="font-medium underline underline-offset-2 transition-colors hover:text-amber-900"
                    >
                      {supportEmail}
                    </a>
                    .
                  </>
                ) : null}
              </span>
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-5">
        <Button type="submit" variant="primary" size="md" disabled={isPending}>
          {isPending ? "Looking up…" : "Track my order"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The tracking result.
 *
 * The status, the timeline, the items and the total — everything a
 * customer needs to know, and nothing they do not.
 */
function TrackingResult({ order }: { readonly order: TrackedOrder }) {
  const steps = ORDER_TIMELINE_STEPS;
  const currentIndex = steps.findIndex((step) => step.key === order.status);
  const cancelled = order.status === "CANCELLED";

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
      {/* ── The heading ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-brand-600">
            Order {order.orderNumber}
          </p>

          <h2 className="mt-1.5 font-serif text-xl font-bold tracking-tight text-foreground">
            {ORDER_STATUS_LABELS[order.status] ?? order.status}
          </h2>

          <p className="mt-1 text-sm leading-relaxed text-foreground-muted">
            {orderStatusNote(order.status)}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span
            className={[
              "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
              orderStatusTone(order.status),
            ].join(" ")}
          >
            {ORDER_STATUS_LABELS[order.status] ?? order.status}
          </span>

          <span
            className={[
              "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
              paymentStatusTone(order.paymentStatus),
            ].join(" ")}
          >
            {paymentStatusLabel(order.paymentStatus)}
          </span>
        </div>
      </div>

      {/* ── The timeline ───────────────────────────────────────────── */}
      {!cancelled ? (
        <ol className="mt-6 space-y-3">
          {steps.map((step, index) => {
            const done = currentIndex >= 0 && index < currentIndex;
            const current = index === currentIndex;

            return (
              <li key={step.key} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className={[
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                    done
                      ? "border-brand-600 bg-brand-600 text-white"
                      : current
                        ? "border-brand-600 bg-brand-50 text-brand-700"
                        : "border-border bg-surface-muted text-foreground-muted",
                  ].join(" ")}
                >
                  {done ? <CheckIcon width={12} height={12} /> : index + 1}
                </span>

                <div className="min-w-0">
                  <p
                    className={[
                      "text-sm font-semibold",
                      current
                        ? "text-foreground"
                        : done
                          ? "text-foreground"
                          : "text-foreground-muted",
                    ].join(" ")}
                  >
                    {step.label}
                  </p>

                  <p className="text-xs leading-relaxed text-foreground-muted">
                    {step.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {/* ── The items ──────────────────────────────────────────────── */}
      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
          What you ordered
        </h3>

        <ul className="mt-2.5 space-y-1.5">
          {order.items.map((item, index) => (
            <li
              key={`${item.name}-${index}`}
              className="flex items-baseline justify-between gap-4 text-sm"
            >
              <span className="min-w-0 text-foreground">
                {item.name}
                {item.quantity > 1 ? (
                  <span className="text-foreground-muted">
                    {" "}
                    × {item.quantity}
                  </span>
                ) : null}
              </span>

              <span className="shrink-0 tabular-nums text-foreground-muted">
                {formatPaisa(item.pricePaisa * item.quantity)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex items-baseline justify-between gap-4 border-t border-border pt-3 text-sm">
          <span className="font-semibold text-foreground">Total</span>

          <span className="font-semibold tabular-nums text-foreground">
            {formatPaisa(order.totalAmountPaisa)}
          </span>
        </div>

        <p className="mt-2 text-[11px] text-foreground-muted">
          {paymentMethodLabel(order.paymentMethod)} ·{" "}
          {order.totalQuantity} item{order.totalQuantity === 1 ? "" : "s"} ·
          placed{" "}
          {new Date(order.placedAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </p>
      </div>
    </div>
  );
}
