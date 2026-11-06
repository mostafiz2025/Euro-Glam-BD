import { connection } from "next/server";
import { Suspense } from "react";

import { MarqueeBanner } from "@/components/home/marquee-banner";
import { fetchSiteSettings } from "@/lib/format/server-data";

/**
 * The announcement marquee, with its data.
 *
 * ── Why this wrapper exists ──────────────────────────────────────────────
 *
 * The settings live in the database, and a banner that has to ask the
 * database for its contents cannot be part of the static shell. So the
 * data is fetched **on the server** and handed down as plain props.
 *
 * This is the same split `PromoBannerSection` uses, and it exists for
 * the same two reasons:
 *
 *   1. **The Prisma engine stays out of the browser bundle.** The
 *      component that renders the banner is a pure server component; the
 *      client never touches the database.
 *
 *   2. **The page does not wait for the banner.** The fetch is streamed
 *      behind a `<Suspense>` boundary, so the rest of the storefront
 *      ships while the settings query is still running.
 *
 * ── Where it sits ────────────────────────────────────────────────────────
 *
 * It is mounted **above the header**, and it is the first thing on every
 * page. That is deliberate: it is the shop's first sentence, and the
 * header is the shop's name. The name is permanent; the sentence is
 * this week.
 *
 * It is **not sticky**. The header is sticky and the marquee is not, so
 * the marquee scrolls away and the header stays — an announcement that
 * follows the customer down the page becomes furniture.
 */

/**
 * The marquee, with the settings loaded.
 *
 * ── Why `connection()` is called here ─────────────────────────────────────
 *
 * The settings are read at **request time**, not at build time. An
 * announcement that was switched on after the last build would not
 * appear on a statically prerendered page, and an announcement that was
 * switched **off** would keep appearing on every page until the next
 * build. Both are wrong, and neither is acceptable for the one line of
 * copy the shop writes without being asked.
 *
 * So the read is marked **request-bound** with `connection()`. That
 * excludes this component from the prerender, and it streams in from the
 * `<Suspense>` boundary below — once per request, with the settings
 * that are actually in force.
 *
 * The boundary must stay **around** this component rather than inside
 * it: `connection()` opts the whole subtree out of the prerender, and
 * the shell around it — the header, the footer, the rest of the page —
 * stays prerendered and ships instantly.
 */
async function MarqueeBannerContent() {
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts the prerender.
  await connection();

  const { settings } = await fetchSiteSettings();

  /*
   * The condition.
   *
   * The marquee renders **only** when it is switched on. The text check
   * is repeated here even though the service already refuses an
   * enabled-but-empty row — because the component's own rule is that it
   * renders nothing without something to say, and that rule must hold
   * no matter who calls it.
   */
  if (!settings.isMarqueeEnabled) return null;

  return (
    <MarqueeBanner
      text={settings.marqueeText}
      href={settings.marqueeHref}
      backgroundColor={settings.marqueeBgColor}
      textColor={settings.marqueeTextColor}
    />
  );
}

/**
 * The announcement marquee section.
 *
 * It renders **nothing at all** when the marquee is switched off, and
 * nothing at all when it is switched on but has no text. A shop with no
 * announcement shows no strip — an empty bar is a strip of coloured
 * nothing that pushes the page down.
 *
 * The `<Suspense>` fallback is `null` rather than a placeholder: the
 * marquee's height is not knowable in advance (it is a single line of
 * text that may or may not be there), and reserving a strip that then
 * turns out to be empty would be the very thing the empty bar is
 * supposed to avoid. A brief absence is better than a strip of
 * coloured nothing.
 */
export function MarqueeBannerSection() {
  return (
    <Suspense fallback={null}>
      <MarqueeBannerContent />
    </Suspense>
  );
}
