"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  SearchIcon,
  SortIcon,
} from "@/components/ui/icons";

/**
 * The order action bar.
 *
 * ── What is in it ──────────────────────────────────────────────────────────
 *
 * Four things, in the order an operator reaches for them:
 *
 *   1. **Global search** — find an order by number, customer name or
 *      email.
 *   2. **Filter & Sort** — the two axes that are not the fulfilment
 *      status (payment status, payment method) plus the sort order.
 *   3. **Create New Order** — the primary action.
 *   4. **Export** — the orders out of the shop, as a CSV.
 *
 * ── The rules that shape it ───────────────────────────────────────────────
 *
 * **1. The server remains the authority.**
 *
 * Every control here is a **URL change**. The client does not filter,
 * sort or search anything itself — it navigates, and the server reads
 * the query parameters. So a filtered list can be reproduced by copying
 * the URL, the back button steps through the filters that were applied,
 * and the counts on the status pills describe the **whole** table rather
 * than the filtered page.
 *
 * **2. Changing a filter never silently drops another.**
 *
 * Every navigation carries the **whole current filter set** forward and
 * replaces only the one key that changed.
 *
 * **3. Changing a filter resets the page.**
 *
 * Page 7 of the old result set is not page 7 of the new one.
 *
 * **4. The search box is debounced.**
 *
 * Typing a customer name should not fire a request per keystroke.
 *
 * **5. The primary action is the only filled button on the page.**
 *
 * One filled button means one obvious next step. An admin bar with
 * three equally-weighted buttons has no hierarchy at all.
 */

/**
 * One option in a dropdown.
 */
type ActionOption = {
  readonly value: string;
  readonly label: string;
  readonly count?: number;
};

/**
 * The props for the bar.
 */
export type AdminOrderActionBarProps = {
  readonly paymentStatusOptions: readonly ActionOption[];
  readonly paymentMethodOptions: readonly ActionOption[];
  /** The sort orders offered. */
  readonly sortOptions: readonly ActionOption[];
  /** The number of orders matching the current filter. */
  readonly matchingCount: number;
  /** The number of orders in the whole table. */
  readonly totalCount: number;
};

/**
 * The action bar.
 */
export function AdminOrderActionBar({
  paymentStatusOptions,
  paymentMethodOptions,
  sortOptions,
  matchingCount,
  totalCount,
}: AdminOrderActionBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const paymentStatus = searchParams.get("paymentStatus") ?? "";
  const paymentMethod = searchParams.get("paymentMethod") ?? "";
  const sort = searchParams.get("sort") ?? "";
  const search = searchParams.get("search") ?? "";

  /**
   * Navigates to the same page with a different filter set.
   *
   * `changes` is the set of keys to replace. Every other key is
   * carried forward untouched, and `page` is always reset.
   */
  function navigate(changes: Record<string, string>): void {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(changes)) {
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
    }

    params.delete("page");

    const query = params.toString();

    router.push(query ? `/admin/orders?${query}` : "/admin/orders");
  }

  /**
   * The export URL.
   *
   * A plain link to the export endpoint, carrying the **current**
   * filters — so "export" means "export what I am looking at", not
   * "export everything and filter it in a spreadsheet afterwards".
   */
  const exportHref = (() => {
    const params = new URLSearchParams(searchParams.toString());

    params.delete("page");

    const query = params.toString();

    return query ? `/api/admin/orders/export?${query}` : "/api/admin/orders/export";
  })();

  const hasFilters = paymentStatus !== "" || paymentMethod !== "" || search !== "";

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        {/*
          The search box.

          First in the DOM, so a keyboard user tabbing into the bar
          reaches search before the filters — it is the control most
          likely to be used, and the only one that takes free text.
        */}
        <div className="relative w-full xl:max-w-sm">
          <label htmlFor="order-global-search" className="sr-only">
            Search orders by number, customer name or email
          </label>

          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted"
          >
            <SearchIcon width={16} height={16} />
          </span>

          <SearchInput
            defaultValue={search}
            onSubmit={(value) => {
              navigate({ search: value });
            }}
          />
        </div>

        {/*
          The action cluster.

          The filters sit next to each other, and the primary action
          sits at the far end — separated by a margin so it reads as a
          different kind of thing from a filter.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <FilterDropdown
            label="Payment status"
            value={paymentStatus}
            options={paymentStatusOptions}
            onChange={(value) => {
              navigate({ paymentStatus: value });
            }}
          />

          <FilterDropdown
            label="Payment method"
            value={paymentMethod}
            options={paymentMethodOptions}
            onChange={(value) => {
              navigate({ paymentMethod: value });
            }}
          />

          <SortDropdown
            value={sort}
            options={sortOptions}
            onChange={(value) => {
              navigate({ sort: value });
            }}
          />

          {hasFilters ? (
            <button
              type="button"
              onClick={() => {
                router.push("/admin/orders");
              }}
              className="inline-flex h-9 items-center rounded-full px-3 text-xs font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              Clear
            </button>
          ) : null}

          <span
            aria-hidden="true"
            className="hidden h-6 w-px bg-border sm:block"
          />

          <Link
            href={exportHref}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 text-xs font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Export
          </Link>

          {/*
            The primary action.

            The only filled button on the page, so "create an order" is
            the one thing the eye lands on.
          */}
          <Link
            href="/admin/orders/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-neutral-900 px-4 text-xs font-semibold text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <PlusIcon width={14} height={14} />
            Create New Order
          </Link>
        </div>
      </div>

      {/*
        The count summary.

        It says how many orders match the current filter, and — when a
        filter is narrowing the list — how many there are in total. The
        admin can therefore tell at a glance whether the filter is
        doing what they meant it to do.
      */}
      <p className="mt-3 text-xs text-foreground-muted">
        {matchingCount === totalCount ? (
          <>
            <span className="font-semibold tabular-nums text-foreground">
              {totalCount}
            </span>{" "}
            order{totalCount === 1 ? "" : "s"} in total
          </>
        ) : (
          <>
            <span className="font-semibold tabular-nums text-foreground">
              {matchingCount}
            </span>{" "}
            order{matchingCount === 1 ? "" : "s"} match this filter, out of{" "}
            <span className="font-semibold tabular-nums text-foreground">
              {totalCount}
            </span>{" "}
            in total
          </>
        )}
      </p>
    </div>
  );
}

/**
 * The search input.
 *
 * Debounced: the value is only committed after a pause in typing, or
 * immediately on `Enter`. `⌘↵` and `Ctrl↵` commit too, for the admin
 * who already knows what they are looking for.
 */
function SearchInput({
  defaultValue,
  onSubmit,
}: {
  readonly defaultValue: string;
  readonly onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Clear the pending timeout on unmount.
   *
   * Without this, an admin who types and immediately navigates away
   * would still fire the timer, and the router would push a filter
   * onto a page they had already left.
   */
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  function commit(next: string): void {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    onSubmit(next.trim());
  }

  function schedule(next: string): void {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      onSubmit(next.trim());
    }, 350);
  }

  return (
    <input
      id="order-global-search"
      type="search"
      defaultValue={defaultValue}
      onChange={(event) => {
        setValue(event.target.value);
        schedule(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit(value);
        }
      }}
      onBlur={() => {
        commit(value);
      }}
      placeholder="Search order, name or email…"
      maxLength={120}
      className="h-10 w-full rounded-full border border-border bg-surface pl-10 pr-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
    />
  );
}

/**
 * A filter dropdown.
 *
 * A listbox rather than a native `<select>`, for the same reason the
 * order status dropdown is one: a native select renders its popup with
 * the operating system's own chrome, which cannot be themed — so it
 * would be the one control on the page that ignores the dark mode.
 *
 * It closes on `Escape` (returning focus to the trigger), on an
 * outside click, and on a choice.
 */
function FilterDropdown({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly ActionOption[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <DropdownShell
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      icon={<FilterGlyph />}
    />
  );
}

/**
 * The sort dropdown.
 *
 * Separate from the filter dropdown because the sort control has a
 * different icon and a different vocabulary — it says "arrange", not
 * "narrow".
 */
function SortDropdown({
  value,
  options,
  onChange,
}: {
  readonly value: string;
  readonly options: readonly ActionOption[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <DropdownShell
      label="Sort"
      value={value}
      options={options}
      onChange={onChange}
      icon={<SortIcon width={13} height={13} />}
    />
  );
}

/**
 * The filter glyph.
 *
 * A funnel, drawn inline rather than imported, because the icon set has
 * a funnel-less filter entry that reads as a "settings sliders" glyph.
 */
function FilterGlyph() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />
    </svg>
  );
}

/**
 * The shared dropdown shell.
 *
 * One implementation for both the filter and the sort dropdowns, so
 * the open/close behaviour — Escape, outside click, focus return — is
 * written once and cannot drift.
 */
function DropdownShell({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly ActionOption[];
  readonly onChange: (value: string) => void;
  readonly icon: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  /**
   * The label of the active option.
   *
   * The trigger says what is currently selected, not the generic
   * label — so an applied filter is visible on the control itself.
   */
  const active = options.find((option) => option.value === value);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className={[
          "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-medium",
          "transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          value
            ? "border-brand-300 bg-brand-50 text-brand-800"
            : "border-border bg-surface text-foreground-muted hover:border-brand-200 hover:bg-brand-50/40",
        ].join(" ")}
      >
        {icon}

        <span className="max-w-32 truncate">
          {value ? active?.label : label}
        </span>

        <ChevronDownIcon width={13} height={13} />
      </button>

      {isOpen ? (
        <ul
          role="listbox"
          aria-label={label}
          className="absolute right-0 z-40 mt-1 min-w-56 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          <li role="none">
            <button
              type="button"
              role="option"
              aria-selected={value === ""}
              onClick={() => {
                setIsOpen(false);
                onChange("");
              }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:bg-surface-muted"
            >
              <span>{label === "Sort" ? "Default" : "All"}</span>

              {value === "" ? (
                <span aria-hidden="true" className="text-brand-600">
                  <CheckIcon width={13} height={13} />
                </span>
              ) : null}
            </button>
          </li>

          {options.map((option) => (
            <li key={option.value} role="none">
              <button
                type="button"
                role="option"
                aria-selected={value === option.value}
                onClick={() => {
                  setIsOpen(false);
                  onChange(option.value);
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:bg-surface-muted"
              >
                <span>{option.label}</span>

                <span className="flex items-center gap-2">
                  {option.count !== undefined ? (
                    <span className="text-[10px] tabular-nums text-foreground-muted">
                      {option.count}
                    </span>
                  ) : null}

                  {value === option.value ? (
                    <span aria-hidden="true" className="text-brand-600">
                      <CheckIcon width={13} height={13} />
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
