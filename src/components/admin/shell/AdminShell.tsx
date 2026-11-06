"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  useAdminShellPrefs,
  writeAdminShellPrefs,
} from "@/lib/admin/shell-preferences";

import {
  AdminDrawerClose,
  AdminDrawerScrim,
  AdminTopbar,
} from "./AdminTopbar";
import {
  AdminSidebar,
  AdminSidebarBrand,
  AdminSidebarToggle,
} from "./AdminSidebar";

/**
 * The admin shell.
 *
 * ── What this component owns ─────────────────────────────────────────────
 *
 * Two pieces of UI state:
 *
 *   1. **Whether the desktop rail is collapsed.** An external fact,
 *      persisted in `localStorage`, because an operator who collapses
 *      the sidebar does so to keep it collapsed for the whole session,
 *      not re-collapse it on every page load. It is read through
 *      `useSyncExternalStore` so the server can render a snapshot
 *      without a hydration mismatch.
 *
 *   2. **Whether the mobile drawer is open.** Genuinely ephemeral
 *      React state — not persisted, because a drawer that reopens
 *      itself on the next page load is a drawer that blocks the
 *      content the admin was trying to reach.
 *
 * ── Why this is a client component, and what that does NOT cost ────────
 *
 * The shell holds interactive state, so it is a client component. But the
 * **session check is not here** — it stays in the server layout
 * (`src/app/admin/layout.tsx`), which reads the cookie and redirects
 * before this component is ever rendered.
 *
 * That ordering matters. The gate is server-side and authoritative; the
 * shell is presentation. If the check moved into this component, the
 * admin page would render for an unauthenticated visitor and then
 * redirect them client-side — which leaks the page's contents into the
 * browser for a moment and makes the protection a client-side illusion.
 *
 * ── The layout rule: a flex row, and nothing that overlaps ───────────────
 *
 * The shell is a **flex row**:
 *
 *   ┌────────────┬────────────────────────────────┐
 *   │            │  top bar                       │
 *   │  sidebar   ├────────────────────────────────┤
 *   │  (its own  │                                │
 *   │   track)   │  page content                  │
 *   └────────────┴────────────────────────────────┘
 *
 * The sidebar is a **flex item**, not a `fixed` element. That single
 * change is what makes the overlap structurally impossible.
 *
 * ── Why it was a `fixed` rail, and why that was wrong ────────────────────
 *
 * The rail used to be `fixed inset-y-0 left-0`, and the content column
 * carried a matching `lg:pl-[260px]` to make room for it. Those are two
 * pieces of arithmetic that have to agree: the rail's width, the
 * padding, and the collapsed width, and the padding again.
 *
 * When they disagree — and they disagreed the moment the storefront's
 * sticky header (`z-50`) was layered over the rail (`z-40`) — the rail
 * and the content stop being two parts of one layout and become two
 * elements fighting for the same pixels. The header painted over the
 * menu, and the operator's labels were unreadable.
 *
 * A flex row removes the arithmetic entirely. The sidebar's width is
 * whatever the sidebar is; the content takes the rest. There is no
 * padding to keep in step with a width, and no `fixed` element to
 * overlap anything, because nothing is taken out of the flow.
 *
 * The rail still scrolls with the page rather than pinning itself to the
 * viewport, which is a small change in feel and a large change in
 * robustness: the page is now one scroll container, and there is no
 * second, independently-positioned column that can drift out of
 * alignment with it.
 *
 * ── Why the mobile drawer stays `fixed` ───────────────────────────────────
 *
 * On a phone the sidebar cannot be a flex item — there is no room for
 * it beside the content, and a 260px rail beside a 360px screen would
 * leave 100px of page. So the drawer is `fixed` and off-canvas, which
 * is the one place `fixed` is the right tool: it is an overlay, and it
 * is meant to cover what is behind it.
 */
export function AdminShell({
  userName,
  userEmail,
  children,
}: {
  /** The signed-in administrator's name. */
  readonly userName: string;
  /** The signed-in administrator's email address. */
  readonly userEmail: string;
  readonly children: ReactNode;
}) {
  const prefs = useAdminShellPrefs();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const collapsed = prefs.collapsed;

  const toggleCollapsed = useCallback(() => {
    writeAdminShellPrefs({ collapsed: !collapsed });
  }, [collapsed]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Escape closes the drawer. A drawer that traps the user is a
  // drawer they have to reload out of.
  useEffect(() => {
    if (!drawerOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDrawerOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  // The body must not scroll behind an open drawer, or the page moves
  // under the scrim while the admin is trying to read the menu.
  useEffect(() => {
    if (!drawerOpen) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  return (
    <div className="min-h-screen bg-surface-sunken text-foreground">
      {/*
        The shell is a **flex row**.

        The sidebar is a flex item with a fixed width and `shrink-0`, so
        it keeps exactly the width it asks for; the content column takes
        the rest of the row with `flex-1` and `min-w-0`.

        `min-w-0` on the content is the important one. A flex item's
        default `min-width` is `auto`, which means it refuses to shrink
        below the size of its own content — so a wide table or a long
        unbroken string in the page would push the content *out* of the
        row and push the sidebar off the left edge of the screen. With
        `min-w-0` the content is allowed to shrink, and the overflow is
        handled inside it where it belongs.
      */}
      <div className="flex min-h-screen w-full">
        {/* ── The desktop rail ─────────────────────────────────────────── */}
        <aside
          className={[
            "hidden shrink-0 flex-col border-r border-border bg-surface",
            "transition-[width] duration-200 ease-out",
            "lg:flex",
            /*
             * `sticky top-0 h-dvh` keeps the rail in view as the page
             * scrolls, which is what an operator expects from a
             * dashboard's menu.
             *
             * The crucial point is that it is **sticky, not fixed**. A
             * sticky element is still a flex item: it occupies its own
             * track in the row, and the content column sits *beside* it
             * rather than underneath it. A `fixed` element is taken out
             * of the flow entirely and painted over whatever it lands
             * on — which is exactly how the storefront's header came to
             * mask this menu.
             *
             * Sticky and fixed look similar and behave completely
             * differently. This one reserves its space.
             */
            "sticky top-0 h-dvh",
            /*
             * The collapsed rail is 116px, not 76px. The difference is
             * the width the stacked captions need: "Audit Logs" has to
             * fit on one or two short lines under its icon, and 76px
             * truncates it to nonsense. 116px fits the longest single
             * word ("Inventory") without a break.
             *
             * The two widths are the *only* two numbers this layout
             * has. The content column is `flex-1`, so it takes whatever
             * is left — there is no padding to keep in step with the
             * rail's width.
             */
            collapsed ? "w-[116px]" : "w-[260px]",
          ].join(" ")}
        >
          <AdminSidebarBrand collapsed={collapsed} />

          <AdminSidebar collapsed={collapsed} />

          <div
            className={[
              "flex h-14 shrink-0 items-center border-t border-border",
              collapsed ? "justify-center px-3" : "justify-between px-4",
            ].join(" ")}
          >
            {!collapsed ? (
              <span className="text-xs text-foreground-muted">Euro Glam BD</span>
            ) : null}

            <AdminSidebarToggle collapsed={collapsed} onToggle={toggleCollapsed} />
          </div>
        </aside>

        {/* ── The mobile drawer ───────────────────────────────────────── */}
        {drawerOpen ? (
          <>
            <AdminDrawerScrim onClose={closeDrawer} />
            <aside
              className="fixed inset-y-0 left-0 z-50 flex w-[280px] flex-col border-r border-border bg-surface shadow-lift lg:hidden"
              role="dialog"
              aria-modal="true"
              aria-label="Admin navigation"
            >
              <div className="flex shrink-0 items-center justify-between">
                <AdminSidebarBrand collapsed={false} />
                <AdminDrawerClose onClose={closeDrawer} />
              </div>

              <AdminSidebar collapsed={false} onNavigate={closeDrawer} />
            </aside>
          </>
        ) : null}

        {/* ── The content column ──────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <AdminTopbar
            userName={userName}
            userEmail={userEmail}
            onOpenDrawer={() => setDrawerOpen(true)}
          />

          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
