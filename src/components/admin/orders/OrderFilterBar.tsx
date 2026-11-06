"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * The fulfilment status pills.
 *
 * ── What this is, and what it is not ─────────────────────────────────────
 *
 * This bar is the **fulfilment axis** and nothing else. The order's
 * place in the pipeline is the filter an admin reaches for most often,
 * and it has the most meaningful buckets, so it gets **pills** — visible,
 * one click, with a live count on each.
 *
 * The narrower axes — payment status and payment method — get
 * dropdowns, and they live in the action bar above. A dropdown says
 * "you are filtering by something" in a way a seventh pill does not.
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. Changing a filter never silently drops another.**
 *
 * Every navigation carries the **whole current filter set** forward and
 * replaces only the one key that changed. A link that dropped the
 * other filters would make "filter by bKash, then by paid" impossible
 * without noticing that the first filter had been thrown away.
 *
 * **2. Changing a filter resets the page.**
 *
 * Page 7 of the old result set is not page 7 of the new one. Every
 * filter change drops `page` back to 1, so the admin never lands on an
 * empty page 7 because their filter now matches three orders.
 *
 * **3. The counts come from the server, over the whole table.**
 *
 * So "14 pending" means fourteen pending orders, whether or not the
 * current filter is hiding some of them. The pills are a map of the
 * desk, not a summary of the page.
 */

/**
 * One filter option.
 */
type FilterOption = {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
};

/**
 * The props for the bar.
 */
export type OrderFilterBarProps = {
  /** The fulfilment options, with their counts. */
  readonly statusOptions: readonly FilterOption[];
  /** The payment-status options, with their counts. */
  readonly paymentStatusOptions: readonly FilterOption[];
  /** The payment-method options, with their counts. */
  readonly paymentMethodOptions: readonly FilterOption[];
};

/**
 * The pill bar.
 */
export function OrderFilterBar({
  statusOptions,
  paymentStatusOptions,
  paymentMethodOptions,
}: OrderFilterBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * The current fulfilment filter, read from the URL.
   *
   * The URL is the source of truth — not local state. That means the
   * bar is always in step with the table below it, including after a
   * back navigation or a refresh.
   */
  const status = searchParams.get("status") ?? "";

  /**
   * Navigates to the same page with a different fulfilment filter.
   *
   * Every other key is carried forward untouched, and `page` is always
   * dropped.
   */
  function navigate(value: string): void {
    const params = new URLSearchParams(searchParams.toString());

    if (value) {
      params.set("status", value);
    } else {
      params.delete("status");
    }

    params.delete("page");

    const query = params.toString();

    router.push(query ? `/admin/orders?${query}` : "/admin/orders");
  }

  return (
    <nav
      aria-label="Filter by fulfilment status"
      className="mt-4 rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5"
    >
      <ul className="flex flex-wrap gap-2">
        {statusOptions.map((option) => {
          const isActive = status === option.value;

          return (
            <li key={option.value || "ALL"}>
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  navigate(option.value);
                }}
                className={[
                  "inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium",
                  "transition-all duration-200",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                  isActive
                    ? "bg-neutral-900 text-white shadow-sm"
                    : "bg-surface text-foreground-muted ring-1 ring-border hover:bg-surface-muted hover:text-foreground",
                ].join(" ")}
              >
                {option.label}

                {option.count !== undefined ? (
                  <span
                    className={[
                      "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                      isActive
                        ? "bg-white/15 text-white"
                        : "bg-surface-muted text-foreground-muted",
                    ].join(" ")}
                  >
                    {option.count}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        The two dropdown axes, collapsed behind a disclosure.

        They are here rather than in the action bar so that the pill bar
        is self-contained: an admin who lands on the page with the
        action bar collapsed still has every filter within reach.
      */}
      <details className="group mt-3">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2">
          More filters
          <span
            aria-hidden="true"
            className="transition-transform duration-200 group-open:rotate-180"
          >
            ▾
          </span>
        </summary>

        <div className="mt-3 flex flex-wrap gap-2">
          <AxisDropdown
            label="Payment status"
            options={paymentStatusOptions}
          />

          <AxisDropdown
            label="Payment method"
            options={paymentMethodOptions}
          />
        </div>
      </details>
    </nav>
  );
}

/**
 * One of the narrower axes, as a dropdown.
 */
function AxisDropdown({
  label,
  options,
}: {
  readonly label: string;
  readonly options: readonly FilterOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const key = label === "Payment status" ? "paymentStatus" : "paymentMethod";
  const value = searchParams.get(key) ?? "";

  function navigate(next: string): void {
    const params = new URLSearchParams(searchParams.toString());

    if (next) {
      params.set(key, next);
    } else {
      params.delete(key);
    }

    params.delete("page");

    const query = params.toString();

    router.push(query ? `/admin/orders?${query}` : "/admin/orders");
  }

  const active = options.find((option) => option.value === value);

  return (
    <div className="relative">
      <label className="sr-only" htmlFor={`order-axis-${key}`}>
        {label}
      </label>

      <select
        id={`order-axis-${key}`}
        value={value}
        onChange={(event) => {
          navigate(event.target.value);
        }}
        className="h-9 rounded-full border border-border bg-surface px-3.5 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-200 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
      >
        <option value="">{label}: All</option>

        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {value === option.value && active
              ? option.label
              : `${option.label} (${option.count ?? 0})`}
          </option>
        ))}
      </select>
    </div>
  );
}
