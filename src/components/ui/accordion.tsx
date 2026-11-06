"use client";

import { useId, useState, type ReactNode } from "react";

import { ChevronDownIcon } from "./icons";

/**
 * The accordion.
 *
 * ── The accessibility contract ──────────────────────────────────────────
 *
 * A disclosure widget, implemented to the WAI-ARIA pattern:
 *
 *   • The header is a `<button>` with `aria-expanded` and
 *     `aria-controls` pointing at the panel.
 *   • The panel has `role="region"` and the matching `id`.
 *   • The button is inside a heading, so a screen reader's heading list
 *     shows the section names — which is how a user navigates a long
 *     product page.
 *
 * The chevron rotates with a CSS transition rather than a re-render, so
 * the motion is smooth and respects `prefers-reduced-motion` (the global
 * rule in `globals.css` neutralises it).
 *
 * `defaultOpenId` lets the first section start open, which is what a
 * shopper expects on a product page — the description is the thing
 * people came for.
 */

/**
 * One section of the accordion.
 */
export type AccordionItem = {
  /** The stable id of the section. */
  readonly id: string;
  /** The header text. */
  readonly title: string;
  /** The panel content. */
  readonly content: ReactNode;
  /** An optional short line under the title. */
  readonly subtitle?: string;
};

/**
 * The props for the accordion.
 */
export type AccordionProps = {
  readonly items: readonly AccordionItem[];
  /** The id of the section that starts open. */
  readonly defaultOpenId?: string;
  /** Whether more than one section may be open at a time. */
  readonly allowMultiple?: boolean;
  readonly className?: string;
};

export function Accordion({
  items,
  defaultOpenId,
  allowMultiple = false,
  className,
}: AccordionProps) {
  const [openIds, setOpenIds] = useState<string[]>(
    defaultOpenId ? [defaultOpenId] : [],
  );

  const baseId = useId();

  function toggle(id: string) {
    setOpenIds((current) => {
      const isOpen = current.includes(id);

      if (allowMultiple) {
        return isOpen
          ? current.filter((entry) => entry !== id)
          : [...current, id];
      }

      // Single-open mode: opening a section closes the other one. The
      // section is still open afterwards, so an already-open section
      // collapses instead.
      return isOpen ? [] : [id];
    });
  }

  return (
    <div
      className={[
        "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {items.map((item) => {
        const isOpen = openIds.includes(item.id);
        const buttonId = `${baseId}-${item.id}-button`;
        const panelId = `${baseId}-${item.id}-panel`;

        return (
          <div key={item.id}>
            <h3>
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
                className={[
                  "flex w-full items-center justify-between gap-4 px-5 py-4 text-left",
                  "transition-colors duration-200 hover:bg-surface-sunken",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
                ].join(" ")}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">
                    {item.title}
                  </span>
                  {item.subtitle ? (
                    <span className="mt-0.5 block text-xs text-foreground-muted">
                      {item.subtitle}
                    </span>
                  ) : null}
                </span>

                <ChevronDownIcon
                  width={18}
                  height={18}
                  className={[
                    "text-foreground-muted transition-transform duration-300 ease-[var(--ease-out-soft)]",
                    isOpen ? "rotate-180" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              </button>
            </h3>

            {/* The panel is always in the DOM and hidden with CSS rather
                than unmounted, so the content is present for a search
                engine and for a browser find-in-page. */}
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              hidden={!isOpen}
              className="px-5 pb-5 text-sm leading-relaxed text-foreground-muted"
            >
              {item.content}
            </div>
          </div>
        );
      })}
    </div>
  );
}
