import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { SearchIcon } from "@/components/ui/icons";

/**
 * The shared "order not found" screen.
 *
 * ── Why the wording is deliberately vague ────────────────────────────────
 *
 * This screen is reached in two cases:
 *
 *   1. The order does not exist.
 *   2. The order belongs to someone else.
 *
 * The two must be indistinguishable. If a stranger could tell them
 * apart — "that order number is not in our system" versus "that order
 * belongs to another customer" — the page would confirm that an order
 * number is real, which is a small leak of information about other
 * people's orders.
 *
 * So both cases render the same screen, and it does not speculate about
 * which one it is.
 *
 * ── Why it is a component and not just the `not-found.tsx` file ──────────
 *
 * Two paths lead here:
 *
 *   1. `notFound()` thrown inside the page's `<Suspense>` boundary,
 *      when the order is missing but the check happened too late to
 *      change the status code.
 *   2. The proxy, which answers with a genuine `404` **and** rewrites
 *      to a flat route that calls `notFound()`.
 *
 * Both must render the same screen. If the markup were written twice,
 * the two copies would drift — and the copy is exactly the thing a
 * customer reads when something has gone wrong.
 *
 * So the markup lives here, once, and both entry points use it.
 */
export function OrderNotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-4 py-16 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-brand-500">
        <SearchIcon width={28} height={28} />
      </div>

      <h1 className="mt-5 font-serif text-2xl font-bold text-foreground">
        We could not find that order
      </h1>

      <p className="mt-2.5 text-sm leading-relaxed text-foreground-muted">
        The order may have been placed with a different account, or the link
        may be incomplete. Your orders are always listed in your account.
      </p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink href="/account" variant="primary">
          See your orders
        </ButtonLink>

        <ButtonLink href="/products" variant="outline">
          Browse the catalogue
        </ButtonLink>
      </div>

      <p className="mt-8 text-xs text-foreground-muted">
        Need help?{" "}
        <Link
          href="/account"
          className="text-brand-700 underline underline-offset-2 hover:text-brand-800"
        >
          Open your account
        </Link>
        .
      </p>
    </div>
  );
}
