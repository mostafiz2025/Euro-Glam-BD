"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

/**
 * The sort control.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **Sorting is a navigation, not a mutation.**
 *
 * Changing the sort order changes which products the *server* returns and
 * in what order, so the sort is a search parameter, exactly like every
 * other filter. Selecting "Price: low to high" navigates to a new URL;
 * the server re-renders the page with the new order.
 *
 * The alternative — sorting the current page in the browser — is the
 * classic catalogue bug: a customer on page 3 of 40 sorts by price and
 * sees the cheapest of the *eight products on this page*, not the
 * cheapest of the catalogue. The result is not a sorted catalogue; it is
 * a sorted fragment, and it looks like the site is broken.
 *
 * So the control reads the current `sort` from the URL, and selecting a
 * new one writes it back.
 */

/**
 * The sort options.
 *
 * These mirror the `sort` values the catalogue API accepts. The labels
 * are the customer's words; the values are the API's.
 */
export const SORT_OPTIONS: readonly {
  readonly value: string;
  readonly label: string;
}[] = [
  { value: "newest", label: "Newest first" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "name-asc", label: "Name: A to Z" },
  { value: "oldest", label: "Oldest first" },
];

/**
 * The props for the sort control.
 */
export type SortSelectProps = {
  /** The number of results, shown beside the control. */
  readonly total: number;
};

export function SortSelect({ total }: SortSelectProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const current = searchParams.get("sort") ?? "newest";

  const change = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());

      if (value === "newest") {
        params.delete("sort");
      } else {
        params.set("sort", value);
      }

      // A sort change that leaves the page at 7 lands the customer on
      // an empty page, because the new order has fewer pages.
      params.set("page", "1");

      const query = params.toString();

      startTransition(() => {
        router.push(query ? `/products?${query}` : "/products");
      });
    },
    [router, searchParams],
  );

  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor="sort-select"
        className="shrink-0 text-xs font-medium uppercase tracking-wider text-foreground-muted"
      >
        Sort
      </label>

      <div className="relative">
        <select
          id="sort-select"
          value={current}
          disabled={isPending}
          onChange={(event) => change(event.target.value)}
          className={[
            "h-9 appearance-none rounded-full border border-border bg-surface",
            "pl-3.5 pr-8 text-sm text-foreground-muted",
            "transition-colors hover:border-brand-300",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            "disabled:opacity-60",
            isPending ? "opacity-60" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </div>

      <span className="hidden text-xs text-foreground-muted sm:inline">
        {total} {total === 1 ? "product" : "products"}
      </span>
    </div>
  );
}
