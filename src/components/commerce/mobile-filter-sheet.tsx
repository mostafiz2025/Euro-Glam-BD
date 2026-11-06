"use client";

import { useEffect, useState } from "react";

import { FilterPanel, useActiveFilterCount } from "@/components/commerce/filter-panel";
import { Button } from "@/components/ui/button";
import { CloseIcon, FilterIcon } from "@/components/ui/icons";
import type { CategorySummary, ConcernSummary } from "@/lib/format/types";

/**
 * The mobile filter sheet.
 *
 * ── Why the sheet stays open while filtering ─────────────────────────────
 *
 * The `FilterPanel` navigates as soon as a filter is toggled, because
 * the filter state lives in the URL. That is correct for a desktop
 * sidebar, where the results are visible beside the panel — but on a
 * phone the sheet is *covering* the results. A customer who taps "In
 * stock" and cannot see whether anything changed has no way to know
 * the filter worked.
 *
 * So the sheet stays open while the customer browses the filters, and
 * the "Show Results" button closes it. The sheet is a dialog: it closes
 * on Escape and on a backdrop tap, because a mobile sheet that cannot
 * be dismissed is a trap.
 *
 * ── The scroll lock ──────────────────────────────────────────────────────
 *
 * While the sheet is open, the page behind it does not scroll. Without
 * this, a touch-drag over the sheet's scrollable body scrolls the page
 * behind it on iOS, and the customer loses their position in the
 * results.
 */
export type MobileFilterSheetProps = {
  readonly categories: readonly CategorySummary[];
  /** The skin concerns offered by the panel. */
  readonly concerns?: readonly ConcernSummary[];
};

export function MobileFilterSheet({
  categories,
  concerns = [],
}: MobileFilterSheetProps) {
  const [isOpen, setIsOpen] = useState(false);

  // The badge reads the URL directly, so it stays correct after every
  // filter change without the page having to re-render with a new
  // count.
  const activeCount = useActiveFilterCount();

  // Close on Escape — a keyboard user must be able to dismiss the
  // sheet without reaching for the button.
  useEffect(() => {
    if (!isOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  // Lock the page behind the sheet.
  useEffect(() => {
    if (!isOpen) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={[
          "inline-flex items-center gap-2 rounded-full border border-border bg-surface",
          "px-4 py-2.5 text-sm font-medium text-foreground-muted",
          "transition-colors hover:border-brand-300 hover:text-brand-700",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          "lg:hidden",
        ].join(" ")}
      >
        <FilterIcon width={16} height={16} />
        Filters
        {activeCount > 0 ? (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1.5 text-[11px] font-bold text-white">
            {activeCount}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-[80] lg:hidden">
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 bg-neutral-900/40 backdrop-blur-sm"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
            className="absolute inset-x-0 bottom-0 flex max-h-[88vh] flex-col rounded-t-3xl bg-surface shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold text-foreground">
                Filters
              </h2>

              <button
                type="button"
                aria-label="Close filters"
                onClick={() => setIsOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <CloseIcon width={18} height={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5">
              <FilterPanel categories={categories} concerns={concerns} inSheet />
            </div>

            <div className="border-t border-border bg-surface px-5 py-3">
              <Button fullWidth onClick={() => setIsOpen(false)} variant="primary">
                Show Results
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
