import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import {
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
  MIN_CONTRAST_BODY,
  marqueeContrast,
} from "@/lib/format/colors";

import {
  SITE_SETTINGS_ACTIONS,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin site-settings service.
 *
 * ── Why this exists as its own module ────────────────────────────────────
 *
 * The site's settings are a **mutating admin surface**, and every
 * mutating admin surface in this codebase writes an audit entry in the
 * same transaction as the change it describes.
 *
 * So the write path lives here, where it can share a transaction with
 * its audit entry, rather than in the route handler — the same
 * reasoning that moved the advisor configuration out of its route.
 *
 * ── The rules that govern this module ────────────────────────────────────
 *
 * **1. The table holds one row, and the service guards that.**
 *
 * A `key` column with a unique index, always `"default"`. The row is
 * created on the first write, so an admin never has to "set the shop
 * up" before they can use the settings.
 *
 * **2. A partial update changes only what it names.**
 *
 * Every field is optional, and a field the update does not mention is
 * left exactly as it was. This matters more here than it might seem:
 * the marquee has a **switch** and a **text**, and the natural admin
 * gesture is to flip the switch without retyping the message. If the
 * update sent the whole settings row, that gesture would also save
 * whatever stale copy of the text the form happened to be holding.
 *
 * **3. Switching the marquee on requires text to show.**
 *
 * A marquee that is on but has no text is a strip of coloured nothing.
 * It looks broken to a customer and looks switched off to an admin,
 * and neither is true — so it is refused rather than rendered.
 *
 * The converse is deliberately allowed: switching the marquee **off**
 * while the text is still there is how an admin pauses a campaign, and
 * the text is preserved so switching it back on restores the message
 * rather than losing it.
 *
 * This rule lives here rather than in the validation layer because it
 * is a rule about the **stored** state: a request that switches the
 * marquee on without naming the text is switching on whatever is
 * already saved, and only this module can see what that is.
 *
 * **4. The text is bounded, and the link is closed.**
 *
 * The text is a single scrolling line, so it is bounded at 240
 * characters. The link is a **path within the storefront**, and nothing
 * else — the same closed rule the hero banner's calls to action
 * follow, because the link is rendered into an `href` on every page.
 *
 * **5. The marquee's colours must be legible together.**
 *
 * The ground and the type are two hex triplets the admin picks, and
 * the admin may pick a pair that is technically valid and practically
 * unreadable — a pale rose ground with white type, say. The bar would
 * then be on every page of the shop, saying something nobody can read.
 *
 * The check is here rather than in the validation layer for the same
 * reason the "switch on with no text" rule is: the pair is a fact
 * about the **stored** state. A request that changes only the ground
 * is changing the pair, and only this module can see what the type
 * already is.
 *
 * The threshold is WCAG's **4.5:1** — the body-text ratio — because
 * the marquee is a thin strip of a moving line of type at a small
 * size. It is not a heading, and it is not large.
 *
 * **6. The contact details are free text, and they are optional.**
 *
 * The footer's support email, phone, opening hours and store address
 * are the shop's to write, in the shop's own words. A store address is
 * an address — it may be two lines — so it is a single free-text
 * field rather than a set of structured parts.
 *
 * Every one of them may be **empty**, and an empty one means "the
 * footer does not show this line". A shop that has not told us where
 * its counter is gets no address in the footer, rather than a
 * placeholder address the customer might try to visit.
 */

/**
 * The settings as the admin Settings page sees them.
 */
export type AdminSiteSettings = {
  readonly key: string;
  readonly isMarqueeEnabled: boolean;
  readonly marqueeText: string;
  readonly marqueeHref: string | null;
  readonly marqueeBgColor: string;
  readonly marqueeTextColor: string;
  readonly supportEmail: string;
  readonly supportPhone: string;
  readonly supportHours: string;
  readonly storeAddress: string;
  readonly updatedAt: Date;
};

/**
 * The fields an admin may change.
 *
 * Every field is optional — an update that names one field leaves the
 * others alone.
 */
export type SiteSettingsPatch = {
  readonly isMarqueeEnabled?: boolean;
  readonly marqueeText?: string;
  readonly marqueeHref?: string | null;
  readonly marqueeBgColor?: string;
  readonly marqueeTextColor?: string;
  readonly supportEmail?: string;
  readonly supportPhone?: string;
  readonly supportHours?: string;
  readonly storeAddress?: string;
};

/**
 * The Prisma select for the settings row.
 */
const SITE_SETTINGS_SELECT = {
  key: true,
  isMarqueeEnabled: true,
  marqueeText: true,
  marqueeHref: true,
  marqueeBgColor: true,
  marqueeTextColor: true,
  supportEmail: true,
  supportPhone: true,
  supportHours: true,
  storeAddress: true,
  updatedAt: true,
} satisfies Prisma.SiteSettingsSelect;

/**
 * The single-row key. The table is guarded to one row by the service
 * layer, and "default" is that row's key.
 */
const SETTINGS_KEY = "default";

/**
 * The longest marquee text.
 *
 * A marquee is one scrolling line. Two hundred and forty characters is
 * roughly two full passes of a wide desktop, which is enough for a
 * sentence and not enough for a paragraph.
 */
export const MAX_MARQUEE_TEXT = 240;

/**
 * Reads the site's settings.
 *
 * Returns `null` when the row has never been created — a fresh
 * database has no settings until an admin writes one. `null` is a
 * meaningful answer: it means "nothing has been configured yet", and
 * the storefront treats that as "no marquee".
 */
export async function getSiteSettings(): Promise<AdminSiteSettings | null> {
  const settings = await db.siteSettings.findUnique({
    where: { key: SETTINGS_KEY },
    select: SITE_SETTINGS_SELECT,
  });

  return settings;
}

/**
 * The fields that differ between two settings snapshots.
 *
 * Only the fields that actually changed are recorded, so the audit
 * entry reads "isMarqueeEnabled changed" rather than reproducing the
 * whole row on every save.
 */
function diffSettings(
  before: AdminSiteSettings | null,
  after: AdminSiteSettings,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const beforeFields: Record<string, unknown> = {};
  const afterFields: Record<string, unknown> = {};

  const compare = (
    field: keyof AdminSiteSettings,
    equal: (a: unknown, b: unknown) => boolean,
  ): void => {
    const previous = before?.[field] ?? null;
    const next = after[field];

    if (equal(previous, next)) return;

    beforeFields[field] = previous;
    afterFields[field] = next;
  };

  compare("isMarqueeEnabled", (a, b) => a === b);
  compare("marqueeText", (a, b) => a === b);
  compare("marqueeHref", (a, b) => a === b);
  compare("marqueeBgColor", (a, b) => a === b);
  compare("marqueeTextColor", (a, b) => a === b);
  compare("supportEmail", (a, b) => a === b);
  compare("supportPhone", (a, b) => a === b);
  compare("supportHours", (a, b) => a === b);
  compare("storeAddress", (a, b) => a === b);

  return { before: beforeFields, after: afterFields };
}

/**
 * Updates the site's settings, atomically with its audit entry.
 *
 * @param actor - The admin making the change.
 * @param patch - The fields to change. Unnamed fields are left alone.
 *
 * @throws ApiError 400 when the marquee is switched on with no text.
 */
export async function updateSiteSettings(
  actor: AuditActor,
  patch: SiteSettingsPatch,
): Promise<AdminSiteSettings> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const existing = await tx.siteSettings.findUnique({
        where: { key: SETTINGS_KEY },
        select: SITE_SETTINGS_SELECT,
      });

      /*
       * ── The conditional rule ───────────────────────────────────────────
       *
       * Switching the marquee **on** requires text to show.
       *
       * The text that would be shown is the one this request names, if
       * it names one, and otherwise the one already stored. So the
       * check is made against the text that would actually be in force
       * afterwards — not against the request alone.
       *
       * The rule is enforced here as well as in the schema, for the same
       * reason the advisor's disclaimer rule is: a rule that only one
       * layer enforces is a rule that can be bypassed by calling the
       * other layer.
       */
      if (patch.isMarqueeEnabled === true) {
        const effectiveText =
          patch.marqueeText !== undefined
            ? patch.marqueeText.trim()
            : (existing?.marqueeText ?? "").trim();

        if (effectiveText === "") {
          throw ApiError.validation(
            "The marquee needs some text before it can be switched on. Write the announcement first, or leave the switch off.",
          );
        }
      }

      /*
       * ── The legibility rule ───────────────────────────────────────────
       *
       * The ground and the type must be readable **together**.
       *
       * The check is made against the pair that would actually be in
       * force afterwards — the same reasoning as the rule above. A
       * request that changes only the ground is changing the pair, so
       * the type it is checked against is the one already stored.
       *
       * The bar's own copy is a **small** moving line, so the
       * threshold is WCAG's body-text ratio (4.5:1) rather than the
       * large-text one (3:1). A pair that is legible for a heading is
       * not legible for this.
       */
      const effectiveBackground =
        patch.marqueeBgColor ?? existing?.marqueeBgColor ?? DEFAULT_MARQUEE_BG;

      const effectiveForeground =
        patch.marqueeTextColor ??
        existing?.marqueeTextColor ??
        DEFAULT_MARQUEE_TEXT;

      if (
        patch.marqueeBgColor !== undefined ||
        patch.marqueeTextColor !== undefined
      ) {
        const ratio = marqueeContrast(effectiveBackground, effectiveForeground);

        if (ratio === null) {
          throw ApiError.validation(
            "Those colours could not be read. Pick a background and a text colour as hex values, such as #1c1917.",
          );
        }

        if (ratio < MIN_CONTRAST_BODY) {
          throw ApiError.validation(
            `That combination is too faint to read — the text and the background have a contrast of ${ratio}:1, and the announcement needs at least ${MIN_CONTRAST_BODY}:1.`,
          );
        }
      }

      const data: Prisma.SiteSettingsUpdateInput = {
        ...(patch.isMarqueeEnabled !== undefined
          ? { isMarqueeEnabled: patch.isMarqueeEnabled }
          : {}),
        ...(patch.marqueeText !== undefined
          ? { marqueeText: patch.marqueeText.trim() }
          : {}),
        ...(patch.marqueeHref !== undefined
          ? { marqueeHref: patch.marqueeHref?.trim() || null }
          : {}),
        ...(patch.marqueeBgColor !== undefined
          ? { marqueeBgColor: patch.marqueeBgColor }
          : {}),
        ...(patch.marqueeTextColor !== undefined
          ? { marqueeTextColor: patch.marqueeTextColor }
          : {}),
        ...(patch.supportEmail !== undefined
          ? { supportEmail: patch.supportEmail.trim() }
          : {}),
        ...(patch.supportPhone !== undefined
          ? { supportPhone: patch.supportPhone.trim() }
          : {}),
        ...(patch.supportHours !== undefined
          ? { supportHours: patch.supportHours.trim() }
          : {}),
        ...(patch.storeAddress !== undefined
          ? { storeAddress: patch.storeAddress.trim() }
          : {}),
      };

      const saved = await tx.siteSettings.upsert({
        where: { key: SETTINGS_KEY },
        create: {
          key: SETTINGS_KEY,
          isMarqueeEnabled: patch.isMarqueeEnabled ?? false,
          marqueeText: patch.marqueeText?.trim() ?? "",
          marqueeHref: patch.marqueeHref?.trim() || null,
          marqueeBgColor: patch.marqueeBgColor ?? DEFAULT_MARQUEE_BG,
          marqueeTextColor: patch.marqueeTextColor ?? DEFAULT_MARQUEE_TEXT,
          supportEmail: patch.supportEmail?.trim() ?? "",
          supportPhone: patch.supportPhone?.trim() ?? "",
          supportHours: patch.supportHours?.trim() ?? "",
          storeAddress: patch.storeAddress?.trim() ?? "",
        },
        update: data,
        select: SITE_SETTINGS_SELECT,
      });

      const { before, after } = diffSettings(existing, saved);

      // A save that changed nothing is not an action worth auditing.
      // Writing an entry with empty `before` and `after` would pad the
      // log with noise and make a real change harder to find.
      if (Object.keys(after).length > 0) {
        await writeAuditEntry(tx, {
          actor,
          action: SITE_SETTINGS_ACTIONS.updated,
          entityType: "site_settings",
          entityId: SETTINGS_KEY,
          before,
          after,
          reason: null,
        });
      }

      return saved;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}
