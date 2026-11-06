import Link from "next/link";

import { ButtonLink } from "@/components/ui/button";
import { SearchIcon } from "@/components/ui/icons";

/**
 * The shared "product not found" screen.
 *
 * ── Why it is a component and not just the `not-found.tsx` file ──────────
 *
 * Two paths lead here:
 *
 *   1. `notFound()` thrown inside the page's `<Suspense>` boundary,
 *      when the product is missing but the check happened too late to
 *      change the status code.
 *   2. The proxy, which answers with a genuine `404` **and** rewrites
 *      to this route so the customer sees a page rather than a blank
 *      response.
 *
 * Both must render the same screen. If the markup were written twice,
 * the two copies would drift — and the copy is exactly the thing a
 * customer reads when something has gone wrong.
 *
 * So the markup lives here, once, and both entry points use it.
 */

/**
 * The product-not-found screen.
 */
export function ProductNotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-4 py-16 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 text-brand-500">
        <SearchIcon width={28} height={28} />
      </div>

      <h1 className="mt-5 font-serif text-2xl font-bold text-foreground">
        We could not find that product
      </h1>

      <p className="mt-2.5 text-sm leading-relaxed text-foreground-muted">
        It may have been removed from the catalogue, or the link may be
        incomplete. The rest of the shop is still here.
      </p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink href="/products" variant="primary">
          Browse the catalogue
        </ButtonLink>

        <ButtonLink href="/" variant="outline">
          Back to home
        </ButtonLink>
      </div>

      <p className="mt-8 text-xs text-foreground-muted">
        Looking for something specific?{" "}
        <Link
          href="/products"
          className="text-brand-700 underline underline-offset-2 hover:text-brand-800"
        >
          Search the shop
        </Link>
        .
      </p>
    </div>
  );
}
