import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/shell/AdminShell";
import { getOptionalUser } from "@/lib/auth/guards";

/**
 * The admin layout.
 *
 * ── Where the protection actually happens ─────────────────────────────────
 *
 * This layout is the **authoritative** gate for the admin pages. The
 * proxy in `src/proxy.ts` is the fast filter: it rejects a request with
 * no valid token in about a millisecond, before it touches the
 * database. But the token's `role` claim can be up to seven days stale,
 * so the proxy alone would keep letting a demoted admin through.
 *
 * So the layout does the real check:
 *
 *   1. `getOptionalUser()` verifies the token and **re-reads the role
 *      from the database**. A token minted while the user was an admin
 *      cannot survive their demotion.
 *
 *   2. No user at all → redirected to `/login?next=…`. Not a 403: a
 *      signed-out visitor has not *refused* anything, they have not
 *      identified themselves, and the sign-in page is where they can.
 *
 *   3. A signed-in non-admin → redirected to `/` with a message. A 403
 *      page for a customer who clicked a stale bookmark is a dead end;
 *      the shop is where they belong, and the `?forbidden=1` marker
 *      lets the storefront explain why.
 *
 * The API routes have their own `requireAdmin()` calls, and they stay
 * that way. A page gate protects the page; a route guard protects the
 * route. Sharing one guard between them would mean the API stops being
 * safe the moment someone renders a page without the layout.
 *
 * ── Why the layout is not a client component ─────────────────────────────
 *
 * The check reads the session cookie, which is HTTP-only. A client
 * component cannot read it, so the check would have to happen on the
 * server and be passed down — which is exactly what a server layout
 * does. Making it a client component would move the decision into the
 * browser, where it is both unreadable and meaningless.
 *
 * ── Why this layout is the admin panel's *only* inherited layout ────────
 *
 * The shop's chrome — the header with its search bar, the announcement
 * bar, the cart drawer, the footer — used to be mounted in the root
 * layout, which made it the inheritance of every route including
 * `/admin/*`. The admin dashboard was therefore rendered *inside* the
 * storefront, and the shop's sticky header (`z-50`) painted over the
 * admin rail (`z-40`), masking the operator's menu.
 *
 * The shop's chrome now lives in `src/app/(storefront)/layout.tsx`. A
 * route group is transparent to the URL but a real boundary for the
 * layout tree, so the admin pages inherit **this** layout and the root
 * document shell — and nothing else.
 *
 * The admin panel and the shop are two applications wearing the same
 * URL space. They should not share a shell, and now they do not.
 */
export const metadata: Metadata = {
  title: {
    default: "Admin",
    template: "%s · Admin · Euro Glam BD",
  },
  robots: {
    // An admin page must never appear in a search index.
    index: false,
    follow: false,
  },
};

/**
 * The admin pages depend on who is asking, so they are rendered at
 * request time and cannot be prerendered.
 */
export const instant = false;

/**
 * The admin layout.
 */
export default async function AdminLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const user = await getOptionalUser();

  // No session at all. Send them to the sign-in page, remembering where
  // they were headed so the login can send them back.
  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/admin")}`);
  }

  // A signed-in user who is not an administrator. The role was just read
  // from the database, so this is the authoritative answer — not a
  // seven-day-old claim in a cookie.
  if (user.role !== "ADMIN") {
    redirect("/forbidden");
  }

  return (
    /*
     * The shell is a **client** component (it owns the sidebar's
     * collapse state and the mobile drawer), but the gate above it is
     * not. The session check has already happened on the server, and
     * an unauthenticated visitor never reaches this render — so the
     * page's contents are never sent to a browser that should not see
     * them.
     */
    <AdminShell userName={user.name} userEmail={user.email}>
      {children}
    </AdminShell>
  );
}
