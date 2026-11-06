import { Suspense } from "react";

import { CategoryNav } from "@/components/layout/category-nav";
import { fetchCategories, fetchConcerns } from "@/lib/format/server-data";

/**
 * The category navigation strip, with its data.
 *
 * ── Why this wrapper exists ──────────────────────────────────────────────
 *
 * `CategoryNav` is a client component — it reads `usePathname()` to mark
 * the active item — but the categories it lists come from the database.
 *
 * So the data is fetched **on the server** and handed down as plain
 * props. The client component never touches the database; it only
 * renders what it was given. That keeps the Prisma engine out of the
 * browser bundle, which is the same rule every other split in this
 * codebase follows.
 *
 * The fetch is streamed behind a `<Suspense>` boundary so the header —
 * which does not depend on it — ships in the static shell. The fallback
 * reserves the strip's height so the page does not jump when the real
 * menu arrives.
 */

/**
 * The strip, with the categories and concerns loaded.
 *
 * Both reads are **parallel**, because the strip needs both and neither
 * depends on the other — two sequential round trips to the database for
 * a header that must not delay the page.
 */
async function CategoryNavContent() {
  const [{ categories }, { concerns }] = await Promise.all([
    fetchCategories(),
    fetchConcerns(),
  ]);

  return (
    <CategoryNav
      categories={categories.map((category) => ({
        slug: category.slug,
        name: category.name,
      }))}
      concerns={concerns.map((concern) => ({
        slug: concern.slug,
        name: concern.name,
      }))}
    />
  );
}

/**
 * The placeholder shown while the categories load.
 *
 * It is the strip's height with a few neutral placeholders in it, so the
 * header does not change size when the real menu replaces it.
 */
function CategoryNavFallback() {
  return (
    <div
      aria-hidden="true"
      className="border-b border-border/80 bg-surface/95"
    >
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-2 px-4 sm:px-6 lg:px-8">
        <div className="h-9 w-28 shrink-0 animate-pulse rounded-full bg-surface-muted" />
        <div className="h-9 w-20 shrink-0 animate-pulse rounded-full bg-surface-muted" />
        <div className="h-9 w-24 shrink-0 animate-pulse rounded-full bg-surface-muted" />
        <div className="h-9 w-16 shrink-0 animate-pulse rounded-full bg-surface-muted" />
      </div>
    </div>
  );
}

export function CategoryNavSection() {
  return (
    <Suspense fallback={<CategoryNavFallback />}>
      <CategoryNavContent />
    </Suspense>
  );
}
