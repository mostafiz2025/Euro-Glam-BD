"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { KNOWN_BRANDS, canonicalBrand } from "@/lib/format/brand";

/**
 * The brand picker.
 *
 * ── What it is ───────────────────────────────────────────────────────────
 *
 * A **combobox**: a text input that filters a list of suggestions and
 * accepts a value that is not in the list.
 *
 * That last part is the whole point. The brand vocabulary is a closed
 * list plus a typed escape hatch — an admin can pick "CeraVe" from the
 * suggestions, or type "Some New Brand" and have it accepted. A plain
 * `<select>` could do the first but not the second, and a plain text
 * input could do the second but not the first.
 *
 * ── Why not a native `<select>` ──────────────────────────────────────────
 *
 * A native `<select>` renders its popup with the operating system's own
 * chrome, which cannot be themed — so it would be the one control on the
 * page that ignores the dark mode. The listbox below is themed, and it
 * also filters as you type, which a native select cannot do at all.
 *
 * ── Why the suggestion list is filtered, not paginated ───────────────────
 *
 * The vocabulary is nine brands. There is nothing to paginate, and a
 * paginated picker would be a worse version of a `<select>`.
 *
 * ── Why the typed value is canonicalised ─────────────────────────────────
 *
 * A brand typed as "cerave" is stored as "CeraVe". Without that, the
 * shop could end up with three products branded "cerave", "CeraVe" and
 * "CERAVE", and the storefront would show all three as different
 * brands. The canonicalisation happens here, in the picker, so the
 * admin sees the corrected spelling before they save.
 *
 * ── The controlled contract ──────────────────────────────────────────────
 *
 * The picker takes the value and hands back the new one. That is what
 * lets the parent form decide whether the brand actually **changed** —
 * an unchanged brand must not be sent, because "send the brand I did
 * not touch" is how a concurrent admin's change gets reverted by a
 * save that only meant to change the price.
 */
export function BrandPicker({
  value,
  onChange,
  suggestions = KNOWN_BRANDS,
  id,
  describedBy,
}: {
  /**
   * The product's current brand. `null` means "no brand".
   */
  readonly value: string | null;
  /**
   * Called with the new brand, or `null` when the brand is cleared.
   */
  readonly onChange: (brand: string | null) => void;
  /**
   * The brands to suggest. Defaults to the shop's registered brands.
   */
  readonly suggestions?: readonly string[];
  /**
   * The input's id, so a `<label htmlFor>` can point at it.
   */
  readonly id?: string;
  /**
   * The id of the element that describes this control.
   */
  readonly describedBy?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * The text in the box.
   *
   * When the picker is closed, the box shows the **value**. When it is
   * open, the box holds the **query** — so typing filters rather than
   * replacing the brand.
   *
   * There is no separate `draft` state, because there is nothing to
   * synchronise: the closed-state text *is* the value, and the
   * open-state text *is* the query. A `draft` copy would need an effect
   * to keep it in step with a value that changes elsewhere — the form
   * resets the brand when the dialog closes — and that effect would be
   * a second source of truth for something already known.
   */
  const displayedText = isOpen ? query : (value ?? "");

  /**
   * The suggestions that match the query.
   *
   * An empty query shows everything. A query matches case-insensitively
   * on a prefix first, and on a substring second — so "roche" finds
   * "La Roche-Posay", and "serum" would too if a brand's name contained
   * it.
   */
  const matches = useMemo(() => {
    const trimmed = query.trim().toLowerCase();

    if (trimmed.length === 0) return [...suggestions];

    const prefix = suggestions.filter((brand) =>
      brand.toLowerCase().startsWith(trimmed),
    );

    if (prefix.length > 0) return prefix;

    return suggestions.filter((brand) =>
      brand.toLowerCase().includes(trimmed),
    );
  }, [query, suggestions]);

  /**
   * The value the query would commit.
   *
   * A known brand is canonicalised to its registry spelling. A custom
   * one is canonicalised to its trimmed, collapsed form.
   */
  const pending = useMemo(() => {
    const trimmed = query.trim();

    if (trimmed.length === 0) return null;

    return canonicalBrand(trimmed);
  }, [query]);

  /**
   * Whether the typed value is one of the suggestions.
   *
   * When it is, the suggestion is highlighted in the list rather than
   * offered as a separate "create this" entry — because it is the same
   * brand.
   */
  const pendingIsKnown = useMemo(() => {
    if (pending === null) return false;

    return suggestions.some(
      (brand) => brand.toLowerCase() === pending.toLowerCase(),
    );
  }, [pending, suggestions]);

  // Close on an outside click.
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

  // Close on `Escape`, and return the focus to the input — which is
  // where a keyboard user expects it to be when they cancel.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      setIsOpen(false);
      inputRef.current?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  /**
   * Commits a brand.
   */
  function commit(brand: string | null) {
    onChange(brand);
    setQuery("");
    setIsOpen(false);
    inputRef.current?.focus();
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={`${inputId}-listbox`}
        aria-autocomplete="list"
        aria-describedby={describedBy}
        autoComplete="off"
        value={displayedText}
        placeholder="CeraVe, Bioderma, La Roche-Posay…"
        onFocus={() => {
          setIsOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // `Enter` commits the typed brand rather than submitting
            // the form — an admin typing a brand should not have to
            // reach for the mouse.
            event.preventDefault();

            commit(pending);
            return;
          }

          if (event.key === "ArrowDown" && !isOpen) {
            event.preventDefault();
            setIsOpen(true);
          }
        }}
        className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />

      {isOpen ? (
        <div className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
          {matches.length > 0 ? (
            <ul
              id={`${inputId}-listbox`}
              role="listbox"
              aria-label="Choose a brand"
              className="max-h-56 overflow-y-auto py-1"
            >
              {matches.map((brand) => {
                const isSelected =
                  value !== null &&
                  brand.toLowerCase() === value.toLowerCase();

                return (
                  <li key={brand} role="none">
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => commit(brand)}
                      className={[
                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm",
                        "transition-colors hover:bg-surface-muted",
                        "focus-visible:outline-none focus-visible:bg-surface-muted",
                        isSelected ? "text-foreground" : "text-foreground-muted",
                      ].join(" ")}
                    >
                      <span>{brand}</span>

                      {isSelected ? (
                        <span aria-hidden="true" className="text-foreground-muted">
                          ✓
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {/*
            The typed brand is offered as a new value when it is not
            already in the list. A brand the shop stocks but the code
            has never heard of must have somewhere to go.
          */}
          {pending !== null && !pendingIsKnown ? (
            <div className="border-t border-border">
              <button
                type="button"
                onClick={() => commit(pending)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:bg-surface-muted"
              >
                <span className="text-foreground-muted">Add brand</span>

                <span className="font-medium">{pending}</span>
              </button>
            </div>
          ) : null}

          {matches.length === 0 && pending === null ? (
            <p className="px-3 py-2 text-sm text-foreground-muted">
              No brands match.
            </p>
          ) : null}

          {value !== null ? (
            <div className="border-t border-border">
              <button
                type="button"
                onClick={() => commit(null)}
                className="flex w-full px-3 py-2 text-left text-sm text-foreground-muted transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:bg-surface-muted"
              >
                Clear the brand
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
