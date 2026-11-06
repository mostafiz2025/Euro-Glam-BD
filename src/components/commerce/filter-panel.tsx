"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { CheckIcon, CloseIcon } from "@/components/ui/icons";
import type { CategorySummary, ConcernSummary } from "@/lib/format/types";
import { PRICE_BANDS } from "@/lib/format/taxonomy";

/**
 * The filter panel.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **The filter state lives in the URL, not in React state.**
 *
 * Every filter is a search parameter. That gives three things for free:
 *
 *   1. **Shareable links.** A customer can send someone "the retinol
 *      under ৳2,500" and it works.
 *   2. **The back button works.** Filters are navigations, so the
 *      browser's back arrow undoes the last filter change — which is
 *      what every customer expects and almost no filter UI gets right.
 *   3. **The server renders the filtered result.** No client-side
 *      filtering of a partial list, and therefore no "42 results" that
 *      is really "8 results from the first page".
 *
 * The component reads the current parameters, computes the next URL, and
 * navigates to it. The server page then re-renders with the new filter
 * applied. `useTransition` keeps the interaction smooth while the new
 * page loads.
 *
 * ── The price bands ─────────────────────────────────────────────────────
 *
 * A band is converted into `minPricePaisa` / `maxPricePaisa` — the two
 * parameters the catalogue API actually understands. The bands are a
 * convenience layer over the real filter; the API never sees a band id.
 */

/**
 * The props for the filter panel.
 */
export type FilterPanelProps = {
  readonly categories: readonly CategorySummary[];
  /**
   * The skin concerns offered by the panel.
   *
   * A prop, not a static import — the concerns are admin-managed now, so
   * the panel renders whatever the database holds.
   */
  readonly concerns?: readonly ConcernSummary[];
  /** Whether the panel renders inside the mobile sheet. */
  readonly inSheet?: boolean;
  /** Called when the sheet should close, on mobile. */
  readonly onClose?: () => void;
};

/**
 * The count of the active filters — shown on the mobile filter button.
 */
export function useActiveFilterCount(): number {
  const searchParams = useSearchParams();

  const keys = [
    "category",
    "ingredient",
    "concern",
    "search",
    "minPricePaisa",
    "maxPricePaisa",
    "isBestSeller",
    "isNewArrival",
    "inStock",
  ];

  return keys.filter((key) => searchParams.get(key) !== null).length;
}

/**
 * The filter panel.
 */
export function FilterPanel({
  categories,
  concerns = [],
  inSheet = false,
  onClose,
}: FilterPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const activeCategory = searchParams.get("category");
  const activeIngredient = searchParams.get("ingredient");
  const activeConcern = searchParams.get("concern");
  const activeSearch = searchParams.get("search");
  const activeMinPrice = searchParams.get("minPricePaisa");
  const activeMaxPrice = searchParams.get("maxPricePaisa");
  const onlyInStock = searchParams.get("inStock") === "true";
  const onlyBestSellers = searchParams.get("isBestSeller") === "true";
  const onlyNewArrivals = searchParams.get("isNewArrival") === "true";

  /**
   * Navigates to a new set of parameters.
   *
   * The current parameters are copied, the change is applied, and the
   * `page` is reset to 1 — a filter change that left the page at 7
   * would land the customer on an empty page.
   */
  const navigate = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());

      mutate(params);

      if (!params.has("page")) {
        params.set("page", "1");
      }

      const query = params.toString();

      startTransition(() => {
        router.push(query ? `/products?${query}` : "/products");
      });
    },
    [router, searchParams],
  );

  /**
   * Toggles a boolean filter.
   */
  const toggleBoolean = useCallback(
    (key: string, current: boolean) => {
      navigate((params) => {
        if (current) {
          params.delete(key);
        } else {
          params.set(key, "true");
        }
      });
    },
    [navigate],
  );

  /**
   * Clears every filter.
   */
  const clearAll = useCallback(() => {
    startTransition(() => {
      router.push("/products");
    });
  }, [router]);

  // The sheet is closed by the *caller* — `MobileFilterSheet` owns its
  // open state, because the customer closes it explicitly with "Show
  // Results". Closing it here instead would mean the sheet vanishes
  // the moment a filter is tapped, before the customer has seen the
  // result they asked for.

  const hasFilters =
    activeCategory !== null ||
    activeIngredient !== null ||
    activeConcern !== null ||
    activeSearch !== null ||
    activeMinPrice !== null ||
    activeMaxPrice !== null ||
    onlyInStock ||
    onlyBestSellers ||
    onlyNewArrivals;

  const body = (
    <div className={["space-y-6", isPending ? "opacity-60" : ""].join(" ")}>
      {/* ── Active filters ──────────────────────────────────────────── */}
      {hasFilters ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground-muted">
            Active
          </span>

          {activeCategory ? (
            <FilterChip
              label={categories.find((c) => c.slug === activeCategory)?.name ?? activeCategory}
              onRemove={() =>
                navigate((params) => params.delete("category"))
              }
            />
          ) : null}

          {activeIngredient ? (
            <FilterChip
              label={activeIngredient}
              onRemove={() =>
                navigate((params) => params.delete("ingredient"))
              }
            />
          ) : null}

          {/*
            The concern chip.

            It shows the concern's **name**, not its slug — the shopper
            picked "Fine Lines", not "fine-lines". The slug is only
            resolved to a name when the concern is one the shop still
            has; a stale slug (a concern the admin deleted) falls back
            to the slug itself, which is honest rather than blank.
          */}
          {activeConcern ? (
            <FilterChip
              label={
                concerns.find((c) => c.slug === activeConcern)?.name ??
                activeConcern
              }
              onRemove={() => navigate((params) => params.delete("concern"))}
            />
          ) : null}

          {activeSearch ? (
            <FilterChip
              label={`“${activeSearch}”`}
              onRemove={() => navigate((params) => params.delete("search"))}
            />
          ) : null}

          {activeMinPrice || activeMaxPrice ? (
            <FilterChip
              label={
                activeMinPrice && activeMaxPrice
                  ? `৳${(Number(activeMinPrice) / 100).toLocaleString("en-BD")} – ৳${(Number(activeMaxPrice) / 100).toLocaleString("en-BD")}`
                  : activeMinPrice
                    ? `Over ৳${(Number(activeMinPrice) / 100).toLocaleString("en-BD")}`
                    : `Under ৳${(Number(activeMaxPrice) / 100).toLocaleString("en-BD")}`
              }
              onRemove={() =>
                navigate((params) => {
                  params.delete("minPricePaisa");
                  params.delete("maxPricePaisa");
                })
              }
            />
          ) : null}

          {onlyInStock ? (
            <FilterChip
              label="In stock"
              onRemove={() => navigate((params) => params.delete("inStock"))}
            />
          ) : null}

          {onlyBestSellers ? (
            <FilterChip
              label="Best sellers"
              onRemove={() =>
                navigate((params) => params.delete("isBestSeller"))
              }
            />
          ) : null}

          {onlyNewArrivals ? (
            <FilterChip
              label="New arrivals"
              onRemove={() =>
                navigate((params) => params.delete("isNewArrival"))
              }
            />
          ) : null}

          <button
            type="button"
            onClick={clearAll}
            className="text-xs font-medium text-brand-700 underline underline-offset-2 transition-colors hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {/* ── Category ─────────────────────────────────────────────────── */}
      <FilterGroup title="Category">
        <ul className="space-y-1">
          {categories.map((category) => {
            const isActive = activeCategory === category.slug;

            return (
              <li key={category.id}>
                <button
                  type="button"
                  aria-pressed={isActive}
                  onClick={() =>
                    navigate((params) => {
                      if (isActive) {
                        params.delete("category");
                      } else {
                        params.set("category", category.slug);
                      }
                    })
                  }
                  className={[
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                    isActive
                      ? "bg-brand-50 font-medium text-brand-800"
                      : "text-foreground-muted hover:bg-surface-sunken",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-2">
                    {isActive ? (
                      <CheckIcon width={14} height={14} className="text-brand-600" />
                    ) : null}
                    {category.name}
                  </span>
                  <span className="text-xs text-foreground-muted">
                    {category.productCount}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </FilterGroup>

      {/* ── Skin concern ────────────────────────────────────────────── */}
      {concerns.length > 0 ? (
        <FilterGroup title="Skin Concern">
          <div className="flex flex-wrap gap-2">
            {concerns.map((concern) => {
              /*
                The active test is on the **slug**, because that is what
                the filter sets and what the catalogue matches on.

                It used to test the concern's ingredient tag, and set the
                `ingredient` parameter — which meant the "Skin Concern"
                group was really an ingredient group wearing a concern's
                name. A shopper who picked "Acne" was shown every product
                that merely contained BHA, including ones the shop
                markets for congestion. The concern the admin set on the
                product is the answer to the question the shopper asked.
              */
              const isActive = activeConcern === concern.slug;

              return (
                <button
                  key={concern.id}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() =>
                    navigate((params) => {
                      if (isActive) {
                        params.delete("concern");
                      } else {
                        params.set("concern", concern.slug);
                      }
                    })
                  }
                  className={[
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1",
                    isActive
                      ? "border-brand-600 bg-brand-600 text-white"
                      : "border-border bg-surface text-foreground-muted hover:border-brand-300 hover:text-brand-700",
                  ].join(" ")}
                >
                  {concern.name}
                </button>
              );
            })}
          </div>
        </FilterGroup>
      ) : null}

      {/* ── Price ────────────────────────────────────────────────────── */}
      <FilterGroup title="Price">
        <ul className="space-y-1">
          {PRICE_BANDS.map((band) => {
            const isActive =
              (band.minPaisa === null &&
                activeMinPrice === null &&
                activeMaxPrice === String(band.maxPaisa)) ||
              (band.minPaisa !== null &&
                band.maxPaisa !== null &&
                activeMinPrice === String(band.minPaisa) &&
                activeMaxPrice === String(band.maxPaisa)) ||
              (band.minPaisa !== null &&
                band.maxPaisa === null &&
                activeMinPrice === String(band.minPaisa) &&
                activeMaxPrice === null);

            return (
              <li key={band.id}>
                <button
                  type="button"
                  aria-pressed={isActive}
                  onClick={() =>
                    navigate((params) => {
                      if (isActive) {
                        params.delete("minPricePaisa");
                        params.delete("maxPricePaisa");
                        return;
                      }

                      if (band.minPaisa !== null) {
                        params.set("minPricePaisa", String(band.minPaisa));
                      } else {
                        params.delete("minPricePaisa");
                      }

                      if (band.maxPaisa !== null) {
                        params.set("maxPricePaisa", String(band.maxPaisa));
                      } else {
                        params.delete("maxPricePaisa");
                      }
                    })
                  }
                  className={[
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                    isActive
                      ? "bg-brand-50 font-medium text-brand-800"
                      : "text-foreground-muted hover:bg-surface-sunken",
                  ].join(" ")}
                >
                  {isActive ? (
                    <CheckIcon width={14} height={14} className="text-brand-600" />
                  ) : null}
                  {band.label}
                </button>
              </li>
            );
          })}
        </ul>
      </FilterGroup>

      {/* ── Availability ────────────────────────────────────────────── */}
      <FilterGroup title="Availability">
        <div className="space-y-1">
          <ToggleRow
            label="In stock only"
            checked={onlyInStock}
            onChange={() => toggleBoolean("inStock", onlyInStock)}
          />
          <ToggleRow
            label="Best sellers"
            checked={onlyBestSellers}
            onChange={() => toggleBoolean("isBestSeller", onlyBestSellers)}
          />
          <ToggleRow
            label="New arrivals"
            checked={onlyNewArrivals}
            onChange={() => toggleBoolean("isNewArrival", onlyNewArrivals)}
          />
        </div>
      </FilterGroup>

      {inSheet && onClose ? (
        <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface px-4 py-3">
          <Button fullWidth onClick={onClose} variant="primary">
            Show Results
          </Button>
        </div>
      ) : null}
    </div>
  );

  return body;
}

/**
 * A group of filters.
 */
function FilterGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-foreground-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * A removable filter chip.
 */
function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-100 py-1 pl-2.5 pr-1.5 text-xs font-medium text-brand-800">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove the ${label} filter`}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        <CloseIcon width={11} height={11} />
      </button>
    </span>
  );
}

/**
 * A checkbox-style row.
 */
function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground-muted transition-colors hover:bg-surface-sunken">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-500"
      />
      {label}
    </label>
  );
}
