import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";

/**
 * The storefront layout.
 *
 * ── Why the shop's chrome lives here and not in the root layout ───────────
 *
 * This is the whole point of the `(storefront)` route group.
 *
 * A **route group** is transparent to the URL — `(storefront)/products`
 * is still `/products` — but it is a real boundary for the layout tree.
 * Every page inside it inherits *this* layout; every page outside it
 * inherits nothing but the root layout.
 *
 * So the shop's furniture — the header with its search bar, the
 * announcement bar, the category strip, the cart drawer, the footer and
 * the bottom nav — is mounted **here**, and it is mounted **only** for
 * the pages that are actually the shop.
 *
 * ── Why this had to move ─────────────────────────────────────────────────
 *
 * It used to live in the root layout, which meant the admin dashboard
 * inherited it. The admin panel was rendered *inside* the storefront:
 * the customer's search bar sat above the operator's dashboard, the
 * cart drawer hung off the admin pages, and the shop's footer closed
 * every admin page.
 *
 * That was not merely untidy — it was a **layout collision**. The
 * storefront header is `sticky top-0 z-50`; the admin rail was `z-40`.
 * The higher z-index won, so the storefront header painted *over* the
 * admin sidebar, and the operator's menu was masked by the shop's
 * header on every admin page.
 *
 * Two z-indexes in two different components, each correct on its own,
 * is exactly how a layout collision happens. The fix is not to raise the
 * admin's z-index — it is to stop the two layouts from sharing a page
 * at all. The admin panel and the shop are two different applications
 * wearing the same URL space, and they should not be sharing a shell.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 *
 * The admin's own shell (`AdminShell`) is mounted in
 * `src/app/admin/layout.tsx`, which sits **outside** this group. The
 * two can never render at once: no URL resolves to both, because a
 * route group does not add a path segment.
 *
 * ── Why the shell is still a server component ─────────────────────────────
 *
 * Only `BottomNav` needs `usePathname()`, and it is wrapped in its own
 * `<Suspense>` boundary inside the shell. Everything else — the header,
 * the footer, the promo bar — is static and stays on the server.
 */
export default function StorefrontLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
