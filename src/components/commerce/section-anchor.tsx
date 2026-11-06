"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Scrolls to a section when the URL asks for it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Several links across the shop say "View all" beside a section —
 * "Shop By Skin Concern", "Shop By Brand" — and they all pointed at
 * `/products?view=concerns` and `/products?view=brands`. The `view`
 * parameter was **never read by anything**. So every one of those
 * links landed the shopper at the top of the catalogue, where the
 * section they asked for was at the bottom of the page, below the
 * product grid they had to scroll past.
 *
 * The link said "here is the concerns section" and the page said
 * "here is a product grid". The parameter is now honoured: the page
 * scrolls to the section it names.
 *
 * ── How it works ──────────────────────────────────────────────────────────
 *
 * The section is a **plain anchor** — a real `id` on the element — so
 * the link works without JavaScript, and the browser's own
 * "jump to fragment" behaviour is what a reader expects.
 *
 * The scroll is done here rather than with `scrollIntoView` on the
 * server, because the section is **streamed**. The shell ships
 * without it, so a server-side scroll would run before the element
 * exists and silently do nothing.
 *
 * The scroll is deliberately **not** smooth. A smooth scroll animates
 * past a screenful of unrelated products, and the shopper who clicked
 * "View all" is looking for a section, not for an animation. An
 * instant jump is also the one behaviour that cannot be interrupted
 * halfway.
 *
 * `scroll-mt-32` on the section itself offsets the sticky header, so
 * the heading is not hidden underneath it. The offset is generous
 * because the storefront's sticky header is two tiers — the 4.5rem
 * brand bar and the 3rem category strip beneath it — and a section
 * that lands under only the first tier is still half-hidden.
 */

/**
 * The props for the anchor.
 */
export type SectionAnchorProps = {
  /**
   * The query parameter that names the section.
   *
   * The value is the section's id: `view=concerns` scrolls to
   * `#shop-by-concern`.
   */
  readonly parameter: string;
  /**
   * The id of the section to scroll to.
   */
  readonly targetId: string;
};

export function SectionAnchor({ parameter, targetId }: SectionAnchorProps) {
  const searchParams = useSearchParams();

  const requested = searchParams.get(parameter);

  useEffect(() => {
    if (requested !== targetId) return;

    /*
      The element may not be in the DOM yet — the section is streamed,
      and this effect runs as soon as the shell mounts. So the lookup
      is retried on the next frame.

      Two frames is enough in practice: the section is a small
      Suspense boundary that resolves on the first flush. The retry
      count is bounded so a target that genuinely does not exist
      cannot spin.
    */
    let attempts = 0;

    function scrollToTarget(): void {
      const element = document.getElementById(targetId);

      if (!element) {
        attempts += 1;

        if (attempts < 10) {
          requestAnimationFrame(scrollToTarget);
        }

        return;
      }

      element.scrollIntoView({ behavior: "instant", block: "start" });
    }

    requestAnimationFrame(scrollToTarget);
  }, [requested, targetId]);

  return null;
}
