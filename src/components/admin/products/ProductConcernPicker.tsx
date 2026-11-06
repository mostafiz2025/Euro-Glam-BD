"use client";

import { CheckIcon } from "@/components/ui/icons";

/**
 * The "Shop by Concern" picker.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 *
 * The storefront has a "Shop by Concern" browse — Acne, Dullness, Fine
 * Lines, Dryness, Sensitivity, Texture, Oil Control, Sun Protection. A
 * product that carries no concern is invisible on every one of those
 * pages, and a product that carries the wrong one is visible on a page
 * it does not belong to.
 *
 * So this is the control that decides which pages a product appears on.
 *
 * ── Why the options come from the server ──────────────────────────────────
 *
 * The vocabulary is a **table**, not a constant. An admin adds "Redness"
 * in the Concerns panel, and it appears here immediately — with no code
 * change and no redeploy.
 *
 * That is the whole reason the options are passed in rather than
 * hard-coded. A hard-coded list would have to be edited in three places
 * (the picker, the storefront's concern grid, and the seed) every time a
 * concern was added, and the two would drift — the picker offering a
 * concern the storefront does not have.
 *
 * ── Why the state lives in the parent ─────────────────────────────────────
 *
 * The picker is a **controlled** component: it takes the selected slugs
 * and hands back a new list. That is what lets the parent form decide
 * whether the selection actually *changed* — an unchanged selection must
 * not be sent, because "send the concerns I did not touch" is how a
 * concurrent admin's careful tagging gets reverted by a save that only
 * meant to change the price.
 */

/**
 * One concern, as the picker sees it.
 */
export type ConcernOption = {
  /** The concern's slug — "acne", "fine-lines". */
  readonly slug: string;
  /** The shopper-facing name — "Acne", "Fine Lines". */
  readonly name: string;
  /**
   * A short line about what the concern is.
   *
   * Shown under the picker as a hint, not on each option — a tooltip
   * nobody can reach on a phone is not a hint.
   */
  readonly description?: string | null;
};

/**
 * The maximum number of concerns a product may carry.
 *
 * The same bound the server enforces. It is repeated here so the picker
 * can **disable** the remaining options once the limit is reached —
 * rather than letting the admin tick a fifth one and having the save
 * fail.
 */
const MAX_CONCERNS = 4;

export function ProductConcernPicker({
  concerns,
  selected,
  onChange,
}: {
  /**
   * Every concern the shop has.
   */
  readonly concerns: readonly ConcernOption[];
  /**
   * The slugs currently on the product.
   */
  readonly selected: readonly string[];
  /**
   * Called with the new slug list whenever the admin changes it.
   */
  readonly onChange: (slugs: string[]) => void;
}) {
  /**
   * Whether a concern is currently applied.
   *
   * The comparison is on the slug, which is already lowercase — the
   * server normalises on the way in, and the picker sends lowercase.
   */
  function isApplied(slug: string): boolean {
    return selected.includes(slug);
  }

  /**
   * Toggles a concern on or off.
   *
   * A concern that is **not** applied is refused once the limit is
   * reached. The checkbox is disabled in that state too, so the admin is
   * never left wondering why their click did nothing.
   */
  function toggle(slug: string) {
    if (isApplied(slug)) {
      onChange(selected.filter((entry) => entry !== slug));
      return;
    }

    if (selected.length >= MAX_CONCERNS) return;

    onChange([...selected, slug]);
  }

  const atLimit = selected.length >= MAX_CONCERNS;

  return (
    <fieldset>
      <legend className="text-xs font-medium text-foreground-muted">
        Shop by concern
      </legend>

      {concerns.length === 0 ? (
        <p className="mt-1.5 text-xs text-foreground-muted">
          No skin concerns have been set up yet. Add them in the Concerns
          panel and they will appear here.
        </p>
      ) : (
        <>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {concerns.map((concern) => {
              const applied = isApplied(concern.slug);

              /*
               * A concern that cannot be added right now — because the
               * limit is reached — is disabled rather than hidden. The
               * admin can see the whole vocabulary and understand why
               * the rest is closed.
               */
              const disabled = !applied && atLimit;

              return (
                <label
                  key={concern.slug}
                  className={[
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    applied
                      ? "border-brand-300 bg-brand-50 text-brand-800"
                      : "border-border bg-surface text-foreground-muted",
                    disabled
                      ? "cursor-not-allowed opacity-50"
                      : "cursor-pointer hover:border-brand-300 hover:text-foreground",
                    "focus-within:outline-none focus-within:ring-2 focus-within:ring-brand-500",
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={applied}
                    disabled={disabled}
                    onChange={() => toggle(concern.slug)}
                    className="sr-only"
                  />

                  {applied ? (
                    <CheckIcon width={13} height={13} />
                  ) : null}

                  {concern.name}
                </label>
              );
            })}
          </div>

          <p className="mt-1.5 text-xs text-foreground-muted">
            {atLimit
              ? `A product can carry at most ${MAX_CONCERNS} concerns. Remove one to add another.`
              : `Choose up to ${MAX_CONCERNS}. The product appears on each concern page you pick.`}
          </p>
        </>
      )}
    </fieldset>
  );
}
