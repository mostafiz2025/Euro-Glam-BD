"use client";

import { useState } from "react";

import {
  DISCOUNT_BADGE,
  KNOWN_BADGES,
  canonicalBadge,
} from "@/lib/format/badges";

/**
 * The badge editor.
 *
 * ── What it replaces ──────────────────────────────────────────────────────
 *
 * Two hardcoded checkboxes — "New arrival" and "Best seller" — answered
 * exactly two questions and left nowhere to put "Limited Edition" or an
 * "Eid Special" badge. A shop that wants a third label has nowhere to put
 * it, so it ends up in the description, where it is invisible to the
 * catalogue and impossible to filter by.
 *
 * So the editor offers the **closed set of known badges** as checkboxes —
 * an admin picks rather than types — **plus a free-text field** for the
 * one-off campaign badge that a closed set cannot anticipate.
 *
 * ── Why "Discount Offer" is not a checkbox ───────────────────────────────
 *
 * Whether a product is discounted is a fact about its two **prices**, and
 * prices change. A badge that says "Discount Offer" on a product whose
 * discount was removed yesterday is a lie the storefront would tell. So
 * the badge is derived from the prices at render time, and it is shown
 * here as a **read-only note** rather than a checkbox — the admin can see
 * that the product is discounted, but the flag is never theirs to set
 * and stale.
 *
 * ── Why the state lives in the parent ─────────────────────────────────────
 *
 * The editor is a **controlled** component: it takes the badge list and
 * hands back a new one. That is what lets the parent form decide whether
 * the badges actually *changed* — an unchanged badge list must not be
 * sent, because "send the badges I did not touch" is how a concurrent
 * admin's badge gets reverted by a save that only meant to change the
 * price.
 */
export function ProductBadgeEditor({
  badges,
  onChange,
  hasDiscount,
}: {
  /**
   * The badges currently on the product.
   */
  readonly badges: readonly string[];
  /**
   * Called with the new badge list whenever the admin changes it.
   */
  readonly onChange: (badges: string[]) => void;
  /**
   * Whether the product currently has a discount price.
   *
   * Used only to explain the derived badge — the editor never writes it.
   */
  readonly hasDiscount: boolean;
}) {
  const [customTag, setCustomTag] = useState("");

  /**
   * The known badges, minus the derived one.
   */
  const selectable = KNOWN_BADGES.filter((badge) => badge !== DISCOUNT_BADGE);

  /**
   * The badges that are not one of the known ones — the custom tags.
   */
  const customTags = badges.filter((badge) => canonicalBadge(badge) === null);

  /**
   * Whether a known badge is currently applied.
   *
   * The comparison is case-insensitive, so a badge stored as "best
   * seller" still shows as ticked.
   */
  function isApplied(badge: string): boolean {
    return badges.some((entry) => entry.toLowerCase() === badge.toLowerCase());
  }

  /**
   * Toggles a known badge on or off.
   */
  function toggle(badge: string) {
    if (isApplied(badge)) {
      onChange(
        badges.filter((entry) => entry.toLowerCase() !== badge.toLowerCase()),
      );
      return;
    }

    onChange([...badges, badge]);
  }

  /**
   * Adds a custom tag.
   *
   * A tag that matches a known badge is **canonicalised** into it, so
   * "eid special" stays "Eid Special" and "best seller" becomes "Best
   * Seller" rather than a second spelling of an existing badge.
   */
  function addCustomTag() {
    const trimmed = customTag.trim();

    if (trimmed.length === 0) return;

    const canonical = canonicalBadge(trimmed);

    // The discount badge is derived. Letting an admin store it would
    // freeze a fact about the prices into the badge list, where it
    // would outlive the discount itself.
    if (canonical === DISCOUNT_BADGE) {
      setCustomTag("");
      return;
    }

    const value = canonical ?? trimmed;

    if (isApplied(value)) {
      setCustomTag("");
      return;
    }

    onChange([...badges, value]);
    setCustomTag("");
  }

  /**
   * Removes a custom tag.
   */
  function removeCustomTag(tag: string) {
    onChange(badges.filter((entry) => entry !== tag));
  }

  return (
    <fieldset>
      <legend className="text-xs font-medium text-foreground-muted">
        Badges
      </legend>

      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
        {selectable.map((badge) => (
          <label
            key={badge}
            className="inline-flex items-center gap-2 text-sm text-foreground"
          >
            <input
              type="checkbox"
              checked={isApplied(badge)}
              onChange={() => toggle(badge)}
              className="h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-400"
            />
            {badge}
          </label>
        ))}

        {/*
          The discount badge is a fact about the prices, so it is shown
          as a note rather than a checkbox. An admin can see that the
          product is discounted without being able to leave a "Discount
          Offer" behind when the discount goes.
        */}
        <span
          className="inline-flex items-center gap-2 text-sm text-foreground-muted"
        >
          <input
            type="checkbox"
            checked={hasDiscount}
            disabled
            readOnly
            aria-label="Discount Offer is set automatically from the prices"
            className="h-4 w-4 rounded border-border text-brand-600 focus:ring-brand-400"
          />
          {DISCOUNT_BADGE}
          <span className="text-xs text-foreground-muted">
            (from the prices)
          </span>
        </span>
      </div>

      {/* ── The custom tags ─────────────────────────────────────────── */}
      <div className="mt-3">
        <label className="block">
          <span className="text-xs font-medium text-foreground-muted">
            Custom tag
          </span>

          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={customTag}
              onChange={(event) => setCustomTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;

                // `Enter` adds the tag rather than submitting the
                // form — an admin typing a tag should not have to
                // reach for the mouse.
                event.preventDefault();
                addCustomTag();
              }}
              placeholder="e.g. Eid Special 2026"
              maxLength={40}
              aria-describedby="custom-tag-hint"
              className="h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />

            <button
              type="button"
              onClick={addCustomTag}
              disabled={customTag.trim().length === 0}
              className="inline-flex h-10 shrink-0 items-center rounded-full bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </label>

        <p id="custom-tag-hint" className="mt-1 text-xs text-foreground-muted">
          A tag you add here appears on the product card.
        </p>

        {customTags.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {customTags.map((tag) => (
              <li key={tag}>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted py-1 pl-3 pr-1.5 text-xs font-medium text-foreground">
                  {tag}

                  <button
                    type="button"
                    onClick={() => removeCustomTag(tag)}
                    aria-label={`Remove the ${tag} tag`}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </fieldset>
  );
}
