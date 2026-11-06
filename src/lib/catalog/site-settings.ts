import { db } from "@/lib/db";
import {
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
  normalizeHexColor,
} from "@/lib/format/colors";

/**
 * The public site settings.
 *
 * ── Why the storefront half lives in its own module ───────────────────────
 *
 * The admin half — create, edit, delete — is in
 * `src/lib/admin/site-settings.ts`, and it is allowed to do things the
 * storefront is not: write an audit entry, and write settings that are
 * not yet published. The storefront half has exactly one job — **show
 * the settings that are on** — and it has to do it without any of the
 * admin machinery.
 *
 * So the two are separate modules, exactly as the hero banners are.
 * A read path that reached for the admin service would drag the audit
 * writer into the page render for no reason.
 */

/**
 * The settings as the storefront sees them.
 *
 * This is a **narrower** type than the admin one. The storefront does
 * not need the row's key or its update timestamp, and a narrower type
 * is what stops a future column from leaking into the page by
 * accident.
 */
export type PublicSiteSettings = {
  /** Whether the announcement marquee is shown. */
  readonly isMarqueeEnabled: boolean;
  /** The marquee's copy — the words that scroll. */
  readonly marqueeText: string;
  /** Where the marquee links to, or `null` when it does not. */
  readonly marqueeHref: string | null;
  /**
   * The marquee's ground.
   *
   * A hex triplet. The storefront renders it inline, so it is
   * validated here rather than trusted — see `normalizeHexColor`.
   */
  readonly marqueeBgColor: string;
  /** The marquee's type colour. A hex triplet. */
  readonly marqueeTextColor: string;
  /** The shop's support address, or `""` when there is none. */
  readonly supportEmail: string;
  /** The shop's support telephone, or `""` when there is none. */
  readonly supportPhone: string;
  /** When the support desk is open, or `""` when it is not stated. */
  readonly supportHours: string;
  /** The shop's store address, or `""` when there is none. */
  readonly storeAddress: string;
};

/**
 * The Prisma select for the public settings.
 */
const PUBLIC_SITE_SETTINGS_SELECT = {
  isMarqueeEnabled: true,
  marqueeText: true,
  marqueeHref: true,
  marqueeBgColor: true,
  marqueeTextColor: true,
  supportEmail: true,
  supportPhone: true,
  supportHours: true,
  storeAddress: true,
} as const;

/**
 * The single-row key. The table is guarded to one row by the service
 * layer, and "default" is that row's key.
 */
const SETTINGS_KEY = "default";

/**
 * The settings for a shop that has never saved any.
 *
 * The marquee is **off**. A fresh shop shows no announcement, because
 * an announcement with nothing to say is a strip of coloured nothing
 * at the top of every page.
 *
 * The colours are the ones the bar carried before it could be
 * painted — the shop's darkest fill with white type — so a row that
 * predates the colour columns still produces the bar the shop is used
 * to.
 */
const EMPTY_SETTINGS: PublicSiteSettings = {
  isMarqueeEnabled: false,
  marqueeText: "",
  marqueeHref: null,
  marqueeBgColor: DEFAULT_MARQUEE_BG,
  marqueeTextColor: DEFAULT_MARQUEE_TEXT,
  supportEmail: "",
  supportPhone: "",
  supportHours: "",
  storeAddress: "",
};

/**
 * Reads the public site settings.
 *
 * Never throws — the caller catches, but a helper that returns the
 * empty settings is the honest answer to "there are no settings", and
 * the storefront shows no marquee either way.
 */
export async function listPublicSiteSettings(): Promise<PublicSiteSettings> {
  const settings = await db.siteSettings.findUnique({
    where: { key: SETTINGS_KEY },
    select: PUBLIC_SITE_SETTINGS_SELECT,
  });

  if (settings === null) {
    return EMPTY_SETTINGS;
  }

  /*
   * A marquee that is switched on but has no text is not a state the
   * admin route allows, but the database is not a validator — a row
   * written by a migration, a script, or a future admin feature could
   * carry it.
   *
   * So the storefront defends itself rather than trusting the row. An
   * announcement with nothing to say renders as an empty strip, which
   * looks broken; rendering nothing is strictly better.
   *
   * Only the **marquee** is suppressed. The row's contact details are
   * a separate fact and they are still true — the footer's support
   * address has nothing to do with whether the announcement has
   * anything to say, and blanking it because of an empty marquee would
   * be a bug of exactly the kind this check exists to prevent.
   */
  const marqueeIsEmpty =
    settings.isMarqueeEnabled && settings.marqueeText.trim() === "";

  /*
   * The colours are **normalised on the way out**.
   *
   * They are rendered into a `style` attribute, so a row carrying
   * something that is not a colour must not reach the browser. A row
   * written by hand, by a script, or by an older version of the admin
   * route could hold anything.
   *
   * A value that is not a colour falls back to the default, so the bar
   * is still painted — an unreadable bar is worse than the bar the
   * shop had before.
   */
  return {
    isMarqueeEnabled: marqueeIsEmpty ? false : settings.isMarqueeEnabled,
    marqueeText: marqueeIsEmpty ? "" : settings.marqueeText,
    marqueeHref: marqueeIsEmpty ? null : settings.marqueeHref,
    marqueeBgColor:
      normalizeHexColor(settings.marqueeBgColor) ?? DEFAULT_MARQUEE_BG,
    marqueeTextColor:
      normalizeHexColor(settings.marqueeTextColor) ?? DEFAULT_MARQUEE_TEXT,
    supportEmail: settings.supportEmail.trim(),
    supportPhone: settings.supportPhone.trim(),
    supportHours: settings.supportHours.trim(),
    storeAddress: settings.storeAddress.trim(),
  };
}
