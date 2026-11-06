"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChevronDownIcon } from "@/components/ui/icons";

/**
 * The category navigation strip.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. Two tiers, because the header has two jobs.**
 *
 * The **upper** header answers "where am I and what can I do here" —
 * the logo, the search field, the account and the cart. The **lower**
 * strip answers "what can I browse" — the catalogue's own axes, as a
 * horizontal menu.
 *
 * Splitting them is what makes a storefront header feel *large* rather
 * than *crowded*. Cramming both into one row is what makes a header feel
 * like a utility bar. The upper row stays calm and branded; the lower
 * row does the navigation.
 *
 * **2. The strip is sticky, and it travels with the bar above it.**
 *
 * This is the decision that makes the page feel like a shop rather than
 * a blog. The category menu is the thing a shopper scrolls the page to
 * use — they are reading a product grid and think "let me look at
 * serums". So the menu stays, and so does the bar above it with the
 * search field and the cart.
 *
 * The strip's sticky offset is the bar's height, not zero. Two elements
 * that both claim `top-0` overlap — the second paints over the first —
 * so the strip pins itself directly under the bar and the two read as
 * one header.
 *
 * **3. The menu is a real menu, and it is keyboard-navigable.**
 *
 * A "Shop all" dropdown opens on click, closes on `Escape`, on an
 * outside click, and on focus leaving the group. The trigger is a
 * `<button>` with `aria-expanded` and `aria-controls` — because it
 * toggles a panel, it is not a link.
 *
 * **4. The active item is marked from the URL.**
 *
 * `usePathname()` is runtime data, so this component is a client
 * component and must sit behind a `<Suspense>` boundary — Next.js
 * refuses to prerender a client component that reads it otherwise.
 *
 * **5. Nothing clips, and nothing shifts.**
 *
 * This is the rule that governs the strip's *geometry*, and it is the
 * reason the dropdown is positioned against the **viewport** rather
 * than against the trigger.
 *
 * The strip's menu row is a horizontal scroller (`overflow-x-auto`).
 * An overflow container is also a **clipping** container: anything
 * absolutely positioned inside it is clipped to its box. A dropdown
 * anchored to a trigger inside the scroller would therefore be cut off
 * at the strip's bottom edge — visible in the DOM, invisible on the
 * screen. So the panel is `fixed` and placed against the viewport's
 * coordinates, and the trigger lives outside the scroller.
 *
 * The second half of the rule is **no layout shift**. A dropdown that
 * pushes the page down when it opens is a dropdown that makes the
 * shopper lose their place; a panel that appears above the fold and
 * changes the document height is exactly that. The `fixed` panel takes
 * itself out of the flow entirely, so the page underneath does not
 * move when the menu opens.
 *
 * The third half is **no horizontal clipping of the strip's own
 * contents**. The inline row scrolls, and the fade at its right edge
 * is a gradient mask rather than a hard cut — so the shopper can see
 * that there is more to the right instead of reading a sliced label as
 * a rendering bug.
 */

/**
 * A category in the menu.
 */
export type CategoryNavItem = {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  /**
   * The sub-items shown in the dropdown, when the item has one.
   *
   * An item without sub-items is a plain link — there is nothing to
   * expand, and a button that opens an empty panel is worse than a link.
   */
  readonly children?: readonly {
    readonly label: string;
    readonly href: string;
  }[];
};

/**
 * Where the "all concerns" link goes.
 *
 * The concerns live on the products page, in its own section. The
 * `view` parameter is a **presentation** hint, not a filter — it does
 * not narrow the catalogue, it says which way in the shopper arrived.
 * The page reads it and scrolls to the section.
 */
const CONCERNS_SECTION_HREF = "/products?view=concerns";

/**
 * The items that are always in the strip.
 *
 * These are **editorial axes** — the ways a shopper thinks about a
 * shop ("what's new", "what's popular") — as opposed to the
 * category axis, which comes from the database and is passed in.
 *
 * The "Skin Concern" item is the exception that proves the rule: its
 * **children** come from the database too, because a concern the admin
 * adds has to appear in the menu without a code change. The item
 * itself is still editorial — it is a way of thinking about the shop,
 * not a row in a table.
 */
const EDITORIAL_ITEMS: readonly CategoryNavItem[] = [
  {
    id: "new-in",
    label: "New In",
    href: "/products?sort=newest",
  },
  {
    id: "best-sellers",
    label: "Best Sellers",
    href: "/products?isBestSeller=true",
  },
  {
    id: "skin-concern",
    label: "Skin Concern",
    href: CONCERNS_SECTION_HREF,
    children: [],
  },
];

/**
 * The category navigation strip.
 */
export function CategoryNav({
  categories,
  concerns = [],
}: {
  /**
   * The database categories, as `{ slug, name }` pairs.
   */
  readonly categories: readonly { readonly slug: string; readonly name: string }[];
  /**
   * The database skin concerns, as `{ slug, name }` pairs.
   *
   * The "Skin Concern" dropdown lists these, so a concern the admin
   * adds appears in the menu without a code change. It used to list
   * four hard-coded entries pointing at ingredient tags — and those
   * tags ("HA", "Peptides") were not even canonical ingredient IDs, so
   * two of the four links matched nothing at all.
   */
  readonly concerns?: readonly { readonly slug: string; readonly name: string }[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * The panel's position, in viewport coordinates.
   *
   * The panel is `fixed`, so it needs explicit coordinates — and it needs
   * them to *follow* the trigger, because the strip is sticky and the
   * page scrolls underneath it.
   */
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0 });

  /**
   * Whether the panel has been measured.
   *
   * The panel is `fixed`, so before it is measured it has no coordinates
   * and would paint at the top-left corner of the viewport. It stays
   * invisible until this is true, which is one frame — and it avoids a
   * panel flashing across the top-left of the screen on the way to its
   * real position.
   */
  const [isPositioned, setIsPositioned] = useState(false);

  /**
   * Measure the trigger and place the panel beneath it.
   *
   * The panel is clamped to the viewport's left edge, so it never runs
   * off-screen on a narrow phone.
   */
  const positionPanel = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;

    if (!trigger || !panel) return;

    const triggerRect = trigger.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;

    const left = Math.min(
      triggerRect.left,
      window.innerWidth - panelWidth - 16,
    );

    // Below the trigger, unless there is not enough room, in which case
    // it opens upward.
    const below = triggerRect.bottom + 8;
    const top =
      below + panelHeight <= window.innerHeight - 16
        ? below
        : Math.max(16, triggerRect.top - panelHeight - 8);

    setPanelPosition({ top: Math.round(top), left: Math.round(Math.max(16, left)) });
    setIsPositioned(true);
  }, []);

  /**
   * Keep the panel glued to the trigger.
   *
   * A `fixed` panel does not move when the page scrolls, so without this
   * the menu would detach from its button the moment the shopper
   * scrolled — and the strip is sticky, so scrolling is exactly what
   * they do.
   */
  useEffect(() => {
    if (!isOpen) return;

    positionPanel();

    window.addEventListener("scroll", positionPanel, true);
    window.addEventListener("resize", positionPanel);

    return () => {
      window.removeEventListener("scroll", positionPanel, true);
      window.removeEventListener("resize", positionPanel);
    };
  }, [isOpen, positionPanel]);

  /**
   * Close the panel on an outside click.
   */
  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const container = containerRef.current;
      const panel = panelRef.current;
      const target = event.target as Node;

      /*
        The panel is a **sibling** of the trigger's wrapper, not a child
        of it, so both have to be checked — otherwise clicking a category
        inside the open menu would close the menu before the link could
        be followed.
      */
      if (
        container &&
        panel &&
        !container.contains(target) &&
        !panel.contains(target)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  /**
   * Close on `Escape`, and hand focus back to the trigger so the user
   * is not dropped at the top of the document.
   */
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  /**
   * The category items, derived from the database.
   *
   * The "all categories" entry is first, so the dropdown opens with the
   * whole catalogue rather than with one category.
   */
  const categoryItems: CategoryNavItem[] = categories.map((category) => ({
    id: category.slug,
    label: category.name,
    href: `/products?category=${category.slug}`,
  }));

  /**
   * The editorial items, with the "Skin Concern" dropdown filled in.
   *
   * The dropdown's children are the shop's own concerns, so they are
   * built here rather than hard-coded in the constant above. The
   * constant holds the *shape* of the menu; the data supplies its
   * contents.
   */
  const editorialItems: CategoryNavItem[] = EDITORIAL_ITEMS.map((item) =>
    item.id === "skin-concern"
      ? {
          ...item,
          children: [
            ...concerns.map((concern) => ({
              label: concern.name,
              href: `/products?concern=${encodeURIComponent(concern.slug)}`,
            })),
            { label: "All Concerns", href: CONCERNS_SECTION_HREF },
          ],
        }
      : item,
  );

  /**
   * The categories shown **inline** in the strip.
   *
   * The strip has one row and no room to grow, and a menu that scrolls
   * horizontally with the last item sliced off at the right edge reads
   * as a rendering bug rather than as "there is more this way".
   *
   * So the strip carries the **editorial axes** plus the first few real
   * categories — the ones a shopper is most likely to want — and the
   * "All Categories" dropdown carries the whole list. The dropdown is
   * already there and already complete; this only decides what is
   * *also* repeated inline.
   *
   * The cap is a *count*, not a width, so the layout is identical on a
   * phone and a desktop and does not reflow as the catalogue grows.
   */
  const MAX_INLINE_CATEGORIES = 6;

  const inlineItems = [
    ...editorialItems,
    ...categoryItems.slice(0, MAX_INLINE_CATEGORIES),
  ];

  /**
   * Whether a given href is the current location.
   *
   * The comparison is on the **pathname plus the search parameters**,
   * because a shopper sitting on `/products?category=serums` has the
   * "Serums" item selected — and a link that is *visibly* selected but
   * not marked as such in the accessibility tree is a trap for
   * screen-reader users.
   *
   * The parameters are compared **exactly**, not by "is there a query
   * string at all". The earlier test — "same path and any query means
   * active" — marked *every* item in the strip active the moment the
   * shopper opened the catalogue: "New In", "Best Sellers", "Skin
   * Concern" and all six categories lit up at once, because they are
   * all `/products?something`. A strip where everything is selected
   * selects nothing.
   *
   * So each item is matched on the parameters it actually carries. An
   * item with no parameters of its own — the plain `/products` link — is
   * active only when no filter is applied.
   */
  const isActive = (href: string): boolean => {
    const [path, query] = href.split("?");

    if (path !== pathname) return false;

    const current = new URLSearchParams(searchParams.toString());
    const target = new URLSearchParams(query ?? "");

    // Every parameter the link carries must match the current one.
    for (const [key, value] of target.entries()) {
      if (current.get(key) !== value) return false;
    }

    // A link with no parameters of its own is active only on the bare
    // page. Otherwise "Browse the full catalogue" would be marked
    // active on every filtered view, which is the same bug in reverse.
    if (target.size === 0) {
      return current.size === 0;
    }

    return true;
  };

  return (
    <nav
      aria-label="Categories"
      className="border-b border-border/80 bg-surface/95 backdrop-blur-md"
    >
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-2 px-4 sm:px-6 lg:px-8">
        {/*
          The dropdown trigger.

          It sits **outside** the horizontal scroller on purpose.

          The scroller below is `overflow-x-auto`, and an overflow
          container is also a **clipping** container: anything absolutely
          positioned inside it is clipped to its box. A dropdown anchored
          to a trigger inside the scroller would therefore be cut off at
          the strip's bottom edge — visible in the DOM, invisible on the
          screen.

          So the trigger lives here, in a wrapper that does not clip, and
          the panel is positioned against the **viewport** instead of
          against the strip.
        */}
        <div ref={containerRef} className="relative z-[70] shrink-0">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => {
              setIsOpen((value) => {
                if (value) setIsPositioned(false);
                return !value;
              });
            }}
            aria-expanded={isOpen}
            aria-controls="category-menu-panel"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground px-4 text-xs font-semibold uppercase tracking-wide text-background transition-colors hover:bg-brand-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            <span className="hidden sm:inline">All Categories</span>
            <span className="sm:hidden">All</span>
            <ChevronDownIcon
              width={14}
              height={14}
              className={[
                "transition-transform duration-200",
                isOpen ? "rotate-180" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          </button>
        </div>

        {/*
          A hairline divider.

          It separates the trigger — the control that *opens* the menu —
          from the items the menu *contains*, so the eye reads the strip
          as "a trigger plus a list" rather than as one undifferentiated
          row of pills. It is `shrink-0` and low-contrast, so it never
          competes with the labels.
        */}
        <span
          aria-hidden="true"
          className="hidden h-5 w-px shrink-0 bg-border sm:block"
        />

        {/* ── The horizontal menu ───────────────────────────────────── */}
        <div className="relative min-w-0 flex-1">
          {/*
            The scroller.

            The fade on its right edge is a **gradient overlay**, not a
            mask. A mask would have to be supported with a
            `-webkit-mask` twin to work in every browser, and the
            overlay has the advantage of being *above* the text: it can
            fade the strip's own background over the last label, which
            is exactly the "there is more this way" cue, and it works
            identically on every engine.

            The overlay is `pointer-events-none`, so the label beneath
            it is still tappable — it only *looks* faded.

            It is `absolute` against the `relative` wrapper, so it
            stays pinned to the right edge while the row scrolls
            underneath it, and it never scrolls away with the content.
          */}
          <div className="relative">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar">
              <div className="flex min-w-max items-center gap-1 pr-6">
            {inlineItems.map((item) => {
              /*
                Every inline item is a **plain link**.

                The "Skin Concern" item used to carry a chevron, which
                promised a dropdown that did not exist — the strip has
                no per-item panels, only the one opened by the "All
                Categories" trigger. So the chevron was a dead
                affordance: it said "there is more under here" and there
                was not.

                The concerns are listed in that panel instead, from the
                database, so a concern the admin adds appears there
                without a code change. This link goes to the concerns
                section of the catalogue.
              */
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className={[
                    "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
                    isActive(item.href)
                      ? "bg-brand-50 text-brand-700"
                      : "text-foreground-muted hover:bg-brand-50 hover:text-brand-700",
                  ].join(" ")}
                >
                  {item.label}
                </Link>
              );
            })}
              </div>
            </div>

            {/*
              The right-edge fade.

              It is `pointer-events-none`, so the label underneath it
              stays tappable — it only *looks* faded. And it is hidden
              entirely on a large screen, where the row fits without
              scrolling and a fade would be fading nothing.
            */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-surface via-surface/85 to-transparent lg:hidden"
            />
          </div>
        </div>
      </div>

      {/*
        The panel.

        It is `fixed` and positioned from the trigger's measured
        rectangle, because a fixed panel is not clipped by the strip's
        scroll container and stays put when the page scrolls.

        It is also `fixed` rather than `absolute` for the second reason:
        a `fixed` panel is taken out of the document flow, so opening
        the menu does not change the page's height and the shopper does
        not lose their place.
      */}
      {isOpen ? (
        <div
          id="category-menu-panel"
          ref={panelRef}
          style={{
            top: panelPosition.top,
            left: panelPosition.left,
          }}
          className={[
            "fixed z-[70] w-[min(42rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-border bg-surface p-2 shadow-lg",
            isPositioned ? "opacity-100" : "opacity-0",
          ].join(" ")}
        >
          {/*
            The editorial axes.

            They lead the panel, because "New In" and "Best Sellers"
            are the two ways a shopper browses a shop *by intent*
            rather than by shelf — and a dropdown that opened on
            "Baby Care" would be a list, not a menu.
          */}
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {editorialItems.map((item) => (
              <Link
                key={item.id}
                href={item.href}
                onClick={() => setIsOpen(false)}
                className="rounded-xl px-3 py-2.5 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {item.label}
              </Link>
            ))}
          </div>

          {/*
            The skin concerns.

            They are listed here, from the database, so the menu carries
            the same vocabulary the storefront filters on. Each one links
            to `?concern=<slug>` — the concern's own slug — and not to
            the ingredient tag it happens to be led by.

            The section is skipped entirely when the shop has no
            concerns: an empty "Skin Concerns" heading is a heading that
            promises nothing.
          */}
          {concerns.length > 0 ? (
            <div className="mt-2 border-t border-border pt-2">
              <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground-muted/70">
                Skin Concerns
              </p>

              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {concerns.map((concern) => (
                  <Link
                    key={concern.slug}
                    href={`/products?concern=${encodeURIComponent(concern.slug)}`}
                    onClick={() => setIsOpen(false)}
                    className="rounded-xl px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {concern.name}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-2 border-t border-border pt-2">
            <p className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-foreground-muted/70">
              All Categories
            </p>

            {/*
              The category list.

              It is a **grid**, not a single long column. A dropdown with
              forty categories in one column is a scrollbar inside a
              dropdown — the shopper has to scroll *inside* the menu to
              find anything, which is slower than the catalogue page it
              is duplicating. The grid shows the whole catalogue at a
              glance and keeps the panel short enough to sit fully
              inside the viewport.

              The panel itself is capped at a maximum height with an
              internal scroll, so a very large catalogue can never push
              the panel off the bottom of the screen.
            */}
            <div className="max-h-[min(22rem,calc(100vh-12rem))] overflow-y-auto overscroll-contain">
              <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
                {categories.map((category) => (
                  <Link
                    key={category.slug}
                    href={`/products?category=${category.slug}`}
                    onClick={() => setIsOpen(false)}
                    className="rounded-xl px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {category.name}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-2 border-t border-border pt-2">
            <Link
              href="/products"
              onClick={() => setIsOpen(false)}
              className="flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold text-brand-700 transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Browse the full catalogue
              <ChevronDownIcon
                width={16}
                height={16}
                className="-rotate-90"
              />
            </Link>
          </div>
        </div>
      ) : null}
    </nav>
  );
}
