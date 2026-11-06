import Link from "next/link";

import { ChevronLeftIcon, ChevronRightIcon } from "@/components/ui/icons";
import type { Pagination as PaginationInfo } from "@/lib/format/types";

/**
 * The pagination control.
 *
 * ── The rule that governs this file ──────────────────────────────────────
 *
 * **Pagination is a link, not a button.**
 *
 * A page of results is a *place*. The customer can send it to someone,
 * bookmark it, or press the back button to return to it. That means
 * every page is a URL, and the control is a set of links — not a
 * client-side state machine that swaps the grid in place.
 *
 * The difference is not cosmetic. A button-based pager loses the URL,
 * so the back button leaves the whole catalogue instead of returning to
 * page 3, and the customer loses their place.
 *
 * ── The window ───────────────────────────────────────────────────────────
 *
 * Seven slots, centred on the current page: two before, the current
 * page, two after, plus the first and last. A long catalogue otherwise
 * renders fifty page buttons, which is a worse interface than no
 * pagination at all.
 */

/**
 * The props for the pagination control.
 */
export type PaginationProps = {
  readonly pagination: PaginationInfo;
  /**
   * The current query string, without the `page` parameter.
   *
   * The caller supplies this so the control does not have to read the
   * URL itself — a server component cannot.
   */
  readonly baseQuery: string;
};

export function Pagination({ pagination, baseQuery }: PaginationProps) {
  const { page, totalPages } = pagination;

  if (totalPages <= 1) {
    return null;
  }

  const pages = buildPageWindow(page, totalPages);

  return (
    <nav aria-label="Pagination" className="mt-10 flex justify-center">
      <ul className="flex items-center gap-1.5">
        <li>
          {pagination.hasPreviousPage ? (
            <PageLink
              href={pageHref(baseQuery, page - 1)}
              label="Previous page"
              ariaLabel="Go to the previous page"
            >
              <ChevronLeftIcon width={16} height={16} />
            </PageLink>
          ) : (
            <span
              aria-hidden="true"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-neutral-300"
            >
              <ChevronLeftIcon width={16} height={16} />
            </span>
          )}
        </li>

        {pages.map((entry, index) =>
          entry === "gap" ? (
            <li
              key={`gap-${index}`}
              aria-hidden="true"
              className="inline-flex h-9 w-9 items-center justify-center text-sm text-foreground-muted"
            >
              …
            </li>
          ) : (
            <li key={entry}>
              {entry === page ? (
                <span
                  aria-current="page"
                  className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-brand-600 px-3 text-sm font-semibold text-white"
                >
                  {entry}
                </span>
              ) : (
                <PageLink
                  href={pageHref(baseQuery, entry)}
                  label={`Page ${entry}`}
                  ariaLabel={`Go to page ${entry}`}
                >
                  {entry}
                </PageLink>
              )}
            </li>
          ),
        )}

        <li>
          {pagination.hasNextPage ? (
            <PageLink
              href={pageHref(baseQuery, page + 1)}
              label="Next page"
              ariaLabel="Go to the next page"
            >
              <ChevronRightIcon width={16} height={16} />
            </PageLink>
          ) : (
            <span
              aria-hidden="true"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-neutral-300"
            >
              <ChevronRightIcon width={16} height={16} />
            </span>
          )}
        </li>
      </ul>
    </nav>
  );
}

/**
 * One page link.
 */
function PageLink({
  href,
  label,
  ariaLabel,
  children,
}: {
  readonly href: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className="inline-flex h-9 min-w-9 items-center justify-center rounded-full border border-border bg-surface px-3 text-sm font-medium text-foreground-muted transition-colors hover:border-brand-300 hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
    >
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">{children}</span>
    </Link>
  );
}

/**
 * Builds the window of page numbers to show.
 *
 * Returns page numbers and the string `"gap"` where a run of pages was
 * collapsed.
 */
function buildPageWindow(
  page: number,
  totalPages: number,
): (number | "gap")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages: (number | "gap")[] = [1];

  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);

  if (start > 2) {
    pages.push("gap");
  }

  for (let index = start; index <= end; index += 1) {
    pages.push(index);
  }

  if (end < totalPages - 1) {
    pages.push("gap");
  }

  pages.push(totalPages);

  return pages;
}

/**
 * Builds the href for a page.
 *
 * The `page` parameter is always present on page 1 too, so the link is
 * stable — a customer who copies the URL of the first page gets the
 * same URL the site itself links to.
 */
function pageHref(baseQuery: string, page: number): string {
  const params = new URLSearchParams(baseQuery);
  params.set("page", String(page));

  return `/products?${params.toString()}`;
}
