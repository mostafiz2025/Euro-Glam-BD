"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * The tabs.
 *
 * ── The accessibility contract ───────────────────────────────────────────
 *
 * A tab set, implemented to the WAI-ARIA pattern:
 *
 *   • The container is a `role="tablist"`, and each tab is a
 *     `role="tab"` with `aria-selected` and `aria-controls`.
 *   • Each panel is a `role="tabpanel"` with the matching `id` and an
 *     `aria-labelledby` pointing back at its tab.
 *   • **Arrow keys move between tabs**, and `Home`/`End` jump to the
 *     first and last. The arrow keys only work if the tablist is
 *     focused, so the tablist itself is focusable.
 *
 * The tabs use **roving tabindex**: the selected tab is the only one in
 * the tab order (`tabIndex={0}`), and the rest are `tabIndex={-1}`. That
 * is what the pattern prescribes — a screen reader user tabs *to* the
 * tab set and then uses the arrow keys *within* it, rather than tabbing
 * through every tab.
 *
 * The selected tab is also the only one that can be activated by
 * `Enter`/`Space`, and the panels are hidden with `hidden` rather than
 * unmounted, so the content is present for a search engine and for a
 * browser find-in-page.
 *
 * ── A deliberate note on the checkout ─────────────────────────────────────
 *
 * The payment method selection in the checkout is **not** built on this
 * component. That selection is a radio group — a native
 * `<input type="radio">` inside a `<fieldset>` — because the radio group
 * carries semantics this widget does not: the browser's own `checked`
 * state, the announcement of the position ("1 of 3"), and the form
 * participation that a form needs.
 *
 * `Tabs` exists for tabs in the ordinary sense: panels of content that
 * belong to the same region of the page.
 */

/**
 * One tab.
 */
export type TabItem = {
  /** The stable id of the tab. Used to build its ids. */
  readonly id: string;
  /** The visible label. */
  readonly label: ReactNode;
  /** The panel content. */
  readonly content: ReactNode;
  /** An optional short line under the label. */
  readonly description?: ReactNode;
  /** An optional icon, shown before the label. */
  readonly icon?: ReactNode;
  /** Whether the tab is disabled. */
  readonly disabled?: boolean;
};

/**
 * The props for the tabs.
 */
export type TabsProps = {
  readonly items: readonly TabItem[];
  /** The id of the tab that starts selected. */
  readonly defaultSelectedId?: string;
  /** Called when the selected tab changes. */
  readonly onSelectedIdChange?: (id: string) => void;
  /** An accessible name for the tab list. */
  readonly label?: string;
  readonly className?: string;
  /**
   * How the tab strip is laid out.
   *
   * `"cards"` draws the reference design's icon-led selection cards.
   * `"strip"` draws a conventional underlined tab strip.
   */
  readonly variant?: "cards" | "strip";
};

export function Tabs({
  items,
  defaultSelectedId,
  onSelectedIdChange,
  label = "Tabs",
  className,
  variant = "strip",
}: TabsProps) {
  const baseId = useId();

  /**
   * The selected tab.
   *
   * Falls back to the first non-disabled tab, so there is always a
   * selection — a tab set with nothing selected is an odd state for a
   * screen reader to announce.
   */
  const [selectedId, setSelectedId] = useState(
    defaultSelectedId ??
      items.find((item) => !item.disabled)?.id ??
      items[0]?.id ??
      "",
  );

  /**
   * The tab elements, by id.
   *
   * The arrow-key handler needs to move **focus**, not just selection,
   * and moving focus to a React element requires a ref to it.
   */
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      onSelectedIdChange?.(id);
    },
    [onSelectedIdChange, setSelectedId],
  );

  /**
   * The arrow-key handling.
   *
   * `Home` and `End` jump to the ends; `ArrowLeft`/`ArrowRight` move by
   * one and **wrap around**, which is what the pattern specifies — the
   * last tab's right arrow returns to the first.
   */
  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    const enabled = items.filter((item) => !item.disabled);

    if (enabled.length === 0) return;

    const current = enabled.findIndex((item) => item.id === items[index]?.id);

    let nextIndex: number | undefined;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (current + 1) % enabled.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (current - 1 + enabled.length) % enabled.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = enabled.length - 1;
    } else {
      return;
    }

    event.preventDefault();

    const next = enabled[nextIndex];
    if (!next) return;

    select(next.id);
    tabRefs.current.get(next.id)?.focus();
  }

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className={
          variant === "cards"
            ? "grid gap-3 sm:grid-cols-3"
            : [
                // The strip is a flex row that scrolls sideways on a
                // narrow screen.
                //
                // `overflow-x-auto` on the scroll container **clips**
                // anything that extends past its box — and the
                // selected tab's `border-b-2` sits exactly on that
                // edge, so the underline was being cut in half. The
                // fix is the negative-margin trick: each tab pulls
                // itself down by one pixel with `-mb-px` so its
                // 2px border lands *on* the container's 1px border
                // rather than below it, and the container grows a
                // `pb-px` to make room. Nothing overflows, so nothing
                // is clipped, and the selected tab's underline is
                // always fully drawn.
                "flex gap-1 overflow-x-auto border-b border-border pb-px",
              ].join(" ")
        }
      >
        {items.map((item, index) => {
          const isSelected = item.id === selectedId;
          const tabId = `${baseId}-${item.id}-tab`;
          const panelId = `${baseId}-${item.id}-panel`;

          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(item.id, node);
                } else {
                  tabRefs.current.delete(item.id);
                }
              }}
              type="button"
              role="tab"
              id={tabId}
              aria-selected={isSelected}
              aria-controls={panelId}
              tabIndex={isSelected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => select(item.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={
                variant === "cards"
                  ? [
                      "flex w-full items-start gap-3 rounded-[var(--radius-card)] border p-4 text-left",
                      "transition-all duration-200 ease-[var(--ease-out-soft)]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                      isSelected
                        ? "border-brand-400 bg-brand-50 ring-1 ring-brand-300"
                        : "border-border bg-surface hover:border-brand-200 hover:bg-brand-50/40",
                      item.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                    ].join(" ")
                  : [
                      // `-mb-px` pulls the tab down onto the strip's
                      // own border, so the selected underline is drawn
                      // at full height rather than clipped by the
                      // scroll container.
                      "-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                      isSelected
                        ? "border-brand-600 text-brand-700"
                        : "border-transparent text-foreground-muted hover:text-foreground",
                    ].join(" ")
              }
            >
              {variant === "cards" ? (
                <>
                  {item.icon ? (
                    <span
                      aria-hidden="true"
                      className={[
                        "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                        "transition-colors",
                        isSelected
                          ? "bg-brand-600 text-white"
                          : "bg-surface-muted text-foreground-muted",
                      ].join(" ")}
                    >
                      {item.icon}
                    </span>
                  ) : null}

                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">
                      {item.label}
                    </span>

                    {item.description ? (
                      <span className="mt-1 block text-xs leading-relaxed text-foreground-muted">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                </>
              ) : (
                item.label
              )}
            </button>
          );
        })}
      </div>

      {items.map((item) => {
        const isSelected = item.id === selectedId;
        const tabId = `${baseId}-${item.id}-tab`;
        const panelId = `${baseId}-${item.id}-panel`;

        return (
          <div
            key={item.id}
            role="tabpanel"
            id={panelId}
            aria-labelledby={tabId}
            hidden={!isSelected}
            tabIndex={0}
            className={[
              variant === "cards" ? "mt-4" : "pt-5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
            ].join(" ")}
          >
            {item.content}
          </div>
        );
      })}
    </div>
  );
}
