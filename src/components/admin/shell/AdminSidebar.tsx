"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { PanelLeftIcon } from "@/components/ui/icons";

import { ADMIN_NAV_ITEMS, isActiveNavItem } from "./admin-nav-items";

/**
 * The admin sidebar.
 *
 * ── Two layouts, one component ───────────────────────────────────────────
 *
 * On a wide screen the sidebar is a **fixed rail** beside the content.
 * It has two widths, and **neither of them hides the labels**:
 *
 *   - **Expanded** (260px) — the icon and the label sit on one row, the
 *     way a menu is normally read.
 *   - **Collapsed** (116px) — the icon and the label stack, the label
 *     becoming a caption underneath the icon. The rail gets narrower,
 *     but the word is still there.
 *
 * ── The rule the layout is built around ───────────────────────────────────
 *
 * **A label is never clipped.** Not with `truncate`, not with an
 * `overflow-hidden` ellipsis, not with a `text-[10px]` caption that
 * cannot fit the word.
 *
 * A clipped label is worse than a hidden one, because it looks present.
 * "Audit Lo…" tells the operator that a section named "Audit Logs"
 * exists; it does not tell them what the section is called, and it
 * makes the rail look broken rather than narrow. So the labels **wrap**
 * instead: the rail is sized to fit the longest word in the list, and
 * anything longer than that breaks onto a second line rather than
 * disappearing.
 *
 * The same rule explains why the collapsed caption is 11px rather than
 * 10px, and why the rail grew from 100px to 116px. The rail is sized
 * to its contents, not the other way round.
 *
 * ── Why the collapsed rail keeps its labels ──────────────────────────────
 *
 * An icons-only rail is the obvious way to save space, and it is wrong
 * here for two reasons.
 *
 * First, **a hidden label is a missing label.** The section names are
 * not decoration — "Audit Logs" and "Reviews" are different places, and
 * a column of unlabelled glyphs is a memory test rather than a menu.
 *
 * Second, the collapsed state is **persisted**. An operator who
 * collapses the rail once keeps it collapsed for the rest of the
 * session, and the toggle that undoes it lives at the very bottom of the
 * rail. So a collapsed rail is not a transient state an admin chooses;
 * it is a state they can get stuck in and not notice. Keeping the label
 * makes the worst case merely *narrower* rather than *unreadable*.
 *
 * So the collapsed rail stacks the label under the icon instead of
 * removing it. The word shrinks; it does not disappear.
 *
 * On a narrow screen the same markup becomes an **off-canvas drawer**,
 * hidden behind a hamburger. A permanent 260px rail on a 360px phone
 * would leave 100px of content. The drawer is always expanded — a
 * drawer has no width to save, because it is already off the screen.
 *
 * ── Why the active state is computed here ────────────────────────────────
 *
 * The server does not know which section the admin clicked when it
 * rendered the layout, so the highlight has to be resolved on the
 * client. This is the same reason `AdminNav` is a client component.
 */
export function AdminSidebar({
  collapsed,
  onNavigate,
}: {
  /** Whether the rail is collapsed to icons only. */
  readonly collapsed: boolean;
  /** Called after a navigation, so the mobile drawer can close itself. */
  readonly onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Admin sections"
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-4"
    >
      {ADMIN_NAV_ITEMS.map((item) => {
        const isActive = isActiveNavItem(item.href, pathname);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            /*
             * The title is what a collapsed rail shows on hover. When
             * the rail is expanded the label is visible, so the title
             * is redundant — but a `title` is harmless there and
             * removing it conditionally would need a client-side
             * check we do not otherwise need.
             */
            title={collapsed ? item.description : undefined}
            className={[
              "group flex rounded-xl font-medium transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
              "focus-visible:ring-offset-surface",
              /*
               * Two layouts, chosen by the collapsed flag.
               *
               * Expanded: icon and label on one row, the label free to
               * wrap rather than truncate. Collapsed: the icon above a
               * centred caption that also wraps rather than truncates.
               * Both keep the whole word.
               */
              collapsed
                ? "flex-col items-center gap-1 px-1 py-2.5 text-[11px] leading-tight"
                : "items-center gap-3 px-3 py-2.5 text-sm",
              isActive
                ? "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"
                : "text-foreground-muted hover:bg-surface-muted hover:text-foreground",
            ].join(" ")}
          >
            <Icon className={collapsed ? "h-4 w-4" : "h-5 w-5"} />

            {/*
              The label is always in the DOM and always fully visible —
              on a collapsed rail it shrinks to a caption under the icon
              rather than being hidden. A screen reader announces the
              same thing either way, but a sighted operator gets the
              same information too.

              **No `truncate` anywhere.** The label wraps instead. The
              rail is sized to fit the longest label ("Audit Logs"), so
              wrapping is the exception rather than the rule, but when
              it does happen the operator sees the whole word rather
              than an ellipsis that hides half of it.
            */}
            <span
              className={
                collapsed
                  ? "w-full break-words text-center leading-tight"
                  : "min-w-0 flex-1 break-words text-left"
              }
            >
              {item.label}
            </span>

            {/*
              The active marker. A left rule rather than a filled pill,
              so it reads as "you are here" in the position the eye
              already expects — the start of the row.

              On a collapsed rail there is no row to put a rule at the
              end of, so it becomes a short centred underline beneath
              the caption.
            */}
            {isActive ? (
              <span
                aria-hidden="true"
                className={
                  collapsed
                    ? "mt-0.5 h-0.5 w-5 shrink-0 rounded-full bg-brand-500"
                    : "ml-auto h-4 w-1 shrink-0 rounded-full bg-brand-500"
                }
              />
            ) : null}
          </Link>
        );
      })}

      <div className="mt-auto" />
    </nav>
  );
}

/**
 * The sidebar's brand mark.
 *
 * Separate from the nav so it can stay visible when the rail is
 * collapsed — an unlabelled rail of icons with no logo is hard to
 * orient in.
 *
 * ── Why the collapsed mark keeps the word "Admin" ───────────────────────
 *
 * The mark is the one place that says *where you are*. "EG" alone could
 * be anything, and on a collapsed rail the whole column of captions is
 * small — the mark is what gives the eye a heading. So the collapsed
 * mark stacks the monogram over the word rather than hiding it.
 */
export function AdminSidebarBrand({ collapsed }: { readonly collapsed: boolean }) {
  return (
    <div
      className={[
        "flex shrink-0 items-center border-b border-border",
        collapsed ? "h-20 justify-center px-2 py-2" : "h-16 px-4",
      ].join(" ")}
    >
      <Link
        href="/admin"
        className={[
          "flex min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          collapsed ? "flex-col items-center gap-1" : "items-center gap-2.5",
        ].join(" ")}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white">
          <span className="text-xs font-bold">EG</span>
        </span>

        {collapsed ? (
          <span className="text-[11px] font-semibold leading-none tracking-tight text-foreground">
            Admin
          </span>
        ) : (
          <span className="min-w-0">
            <span className="block truncate font-serif text-base font-semibold tracking-tight text-foreground">
              Admin
            </span>
            <span className="block truncate text-[11px] text-foreground-muted">
              Euro Glam BD
            </span>
          </span>
        )}
      </Link>
    </div>
  );
}

/**
 * The collapse control.
 *
 * A **button**, not a link: it changes the layout in place rather than
 * navigating anywhere. The `aria-expanded` and `aria-controls` make
 * the state legible to a screen reader, and the label says which way
 * it will move rather than which icon it shows.
 */
export function AdminSidebarToggle({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const label = collapsed ? "Expand the sidebar" : "Collapse the sidebar";

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      className={[
        "inline-flex h-9 w-9 items-center justify-center rounded-lg",
        "text-foreground-muted transition-colors duration-200",
        "hover:bg-surface-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        "focus-visible:ring-offset-surface",
      ].join(" ")}
    >
      <PanelLeftIcon className="h-5 w-5" />
    </button>
  );
}
