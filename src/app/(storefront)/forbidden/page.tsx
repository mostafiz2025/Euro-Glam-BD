import type { Metadata } from "next";
import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";

/**
 * The "you cannot go there" page.
 *
 * ── Why this exists rather than a 403 ────────────────────────────────────
 *
 * A signed-in **customer** who follows a link to `/admin` has not done
 * anything wrong — they have followed a link. A raw `403 Forbidden` is a
 * server error page with no way out: no navigation, no explanation, and
 * a status code that makes the browser show its own error UI.
 *
 * So the proxy redirects them here instead. The page explains what
 * happened in one sentence and offers the two places they might have
 * wanted to go.
 *
 * A signed-out visitor is **not** sent here — they are sent to the
 * sign-in page, because they have not identified themselves yet, and
 * the sign-in page is where they can.
 *
 * ── Why it is a static page ──────────────────────────────────────────────
 *
 * It carries no session state. It can be prerendered, so it loads
 * instantly and it does not add a request-time render to the app.
 */
export const metadata: Metadata = {
  title: "Not available",
  robots: { index: false, follow: false },
};

export default function ForbiddenPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-20 text-center sm:py-28">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50 text-brand-600">
        <svg
          width={26}
          height={26}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </span>

      <h1 className="mt-6 font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        That area is for staff
      </h1>

      <p className="mt-2.5 text-sm leading-relaxed text-foreground-muted">
        The admin dashboard is only available to administrator accounts. If
        you think yours should have access, ask the shop owner to update
        your role.
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink href="/" size="sm">
          Back to the shop
        </ButtonLink>

        <ButtonLink href="/account" variant="outline" size="sm">
          Your account
        </ButtonLink>
      </div>

      <p className="mt-8 text-xs text-foreground-muted">
        Need help?{" "}
        <Link
          href="/orders"
          className="underline underline-offset-2 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          Track an order
        </Link>
      </p>
    </div>
  );
}
