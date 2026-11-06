import type { Metadata } from "next";
import { connection } from "next/server";

import { AiConfigForm } from "@/components/admin/settings/AiConfigForm";
import { ContactSettingsForm } from "@/components/admin/settings/ContactSettingsForm";
import { MarqueeSettingsForm } from "@/components/admin/settings/MarqueeSettingsForm";
import { PreferencesSettingsForm } from "@/components/admin/settings/PreferencesSettingsForm";
import { ProfileSettingsForm } from "@/components/admin/settings/ProfileSettingsForm";
import {
  AdminCard,
  AdminCardHeader,
  AdminErrorState,
} from "@/components/admin/primitives";
import { getAiConfig } from "@/lib/admin/ai-config";
import { getAdminProfile } from "@/lib/admin/profile";
import { getSiteSettings } from "@/lib/admin/site-settings";
import { getOptionalUser } from "@/lib/auth/guards";

/**
 * The admin settings page.
 *
 * ── What this page is ────────────────────────────────────────────────────
 *
 * **Three things: how the AI advisor behaves, what the shop is
 * saying this week, and how customers reach the shop.**
 *
 * Plus the administrator's **own** details and **preferences** — their
 * name and telephone number, and the way their console looks. Those
 * belong to one person; the three above belong to the shop.
 *
 * The advisor card is a deliberate boundary, not a starting point. Two
 * things that look like settings are explicitly *not* editable there:
 *
 *   • **`disclaimerVersion`** is a **stamp**, not a setting. The schema
 *     comment says so: *"Bumped whenever disclaimerText changes; stamped
 *     onto every message's meta so an audit can prove which version a
 *     user actually saw."* If an admin could set it by hand, two
 *     different disclaimers could share a version number — and the
 *     stamp, whose entire job is to identify what a customer actually
 *     saw, would become meaningless. The service owns it.
 *
 *   • **`LOW_STOCK_THRESHOLD`** stays a **constant** in
 *     `src/lib/admin/stats.ts`. A setting that defaulted to zero would
 *     make "low stock" mean "out of stock" for anyone who cleared it,
 *     which is exactly the Step 9 bug class — a threshold that can be
 *     set to a value that makes the warning meaningless is worse than
 *     no threshold at all.
 *
 * ── The three cards load independently ───────────────────────────────────
 *
 * A failure to load the advisor's configuration does **not** hide the
 * announcement settings or the contact details, and a failure to load
 * the settings does not hide the advisor's. They are unrelated surfaces
 * that happen to share a page, so one being unreadable must not take
 * the others down with it — an admin who cannot reach the announcement
 * switch is blocked from running the shop.
 *
 * The announcement and the contact details share the **same** settings
 * row, so they are loaded together and rendered from one value. They
 * are still two cards, because they answer two different questions and
 * an admin looking for one should not have to read past the other.
 *
 * ── The audit trail ──────────────────────────────────────────────────────
 *
 * Settings is a mutating admin surface, and every change on it is
 * recorded. The advisor's disclaimer is compliance text, shown to every
 * customer during a conversation, the marquee is the one line of
 * copy the shop publishes without being asked, and the contact details
 * are the facts a customer uses to reach the shop after paying for
 * something they cannot see. "Who changed it, from what, to what" is a
 * question an audit exists to answer, and all of them now have one —
 * `AI_CONFIG_UPDATED` and `SITE_SETTINGS_UPDATED`, each written in
 * the same transaction as the change it describes.
 *
 * The administrator's own profile is audited too, under
 * `ADMIN_PROFILE_UPDATED` — a separate action, because a profile edit
 * affects one person and a shop-settings edit affects every customer.
 */
export const metadata: Metadata = {
  title: "Settings",
};

/**
 * The page is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminSettingsPage() {
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const [config, settings, profile] = await Promise.all([
    getAiConfig().catch((error: unknown) => {
      console.error("[admin] AI configuration failed:", error);
      return undefined;
    }),
    getSiteSettings().catch((error: unknown) => {
      console.error("[admin] Site settings failed:", error);
      return undefined;
    }),
    /*
     * The profile is the admin's **own** row, so its id comes from the
     * session — never from a query parameter, which would be
     * attacker-controlled.
     */
    (async () => {
      try {
        const user = await getOptionalUser();
        if (!user) return undefined;

        return await getAdminProfile(user.id);
      } catch (error) {
        console.error("[admin] Admin profile failed:", error);
        return undefined;
      }
    })(),
  ]);

  return (
    <>
      <PageHeading
        title="Settings"
        description="Your own account and how your console looks, plus what the shop says, how customers reach it, and how the AI advisor behaves. Every change is recorded in the audit log."
      />

      <div className="grid gap-6">
        {/* ── The administrator's own profile ───────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Your profile"
            description="Your name and telephone number. These belong to you alone — the shop's own details are further down this page."
          />

          <div className="px-5 py-5">
            {profile === undefined ? (
              <AdminErrorState message="We could not load your profile. Please try again in a moment." />
            ) : (
              <ProfileSettingsForm profile={profile} />
            )}
          </div>
        </AdminCard>

        {/* ── The display preferences ───────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Preferences"
            description="How this console looks to you. Remembered in this browser, and applied straight away."
          />

          <div className="px-5 py-5">
            <PreferencesSettingsForm />
          </div>
        </AdminCard>

        {/* ── The announcement marquee ─────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Announcement bar"
            description="The single line of copy that scrolls across the top of every storefront page."
          />

          <div className="px-5 py-5">
            {settings === undefined ? (
              <AdminErrorState message="We could not load the announcement settings. Please try again in a moment." />
            ) : (
              <>
                {settings === null ? (
                  <p className="mb-5 rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-3 text-xs text-foreground-muted">
                    No announcement has been set up yet. The bar is
                    switched off, and the storefront shows nothing at the
                    top of the page. Saving anything on this card creates
                    the settings and starts recording changes in the
                    audit log.
                  </p>
                ) : null}

                <MarqueeSettingsForm settings={settings} />
              </>
            )}
          </div>
        </AdminCard>

        {/* ── The contact details ───────────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="Contact details"
            description="How customers reach the shop. A blank field means the footer does not show that line at all."
          />

          <div className="px-5 py-5">
            {settings === undefined ? (
              <AdminErrorState message="We could not load the contact details. Please try again in a moment." />
            ) : (
              <>
                {settings === null ? (
                  <p className="mb-5 rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-3 text-xs text-foreground-muted">
                    Nothing has been set up yet, so the footer shows no
                    contact lines. Saving anything on this card creates the
                    settings and starts recording changes in the audit log.
                  </p>
                ) : null}

                <ContactSettingsForm settings={settings} />
              </>
            )}
          </div>
        </AdminCard>

        {/* ── The AI advisor ───────────────────────────────────────── */}
        <AdminCard>
          <AdminCardHeader
            title="AI advisor"
            description="The disclaimer, the prompt override, the product allow-list and the cart-conflict rule."
          />

          <div className="px-5 py-5">
            {config === undefined ? (
              <AdminErrorState message="We could not load the advisor configuration. Please try again in a moment." />
            ) : (
              <>
                {config === null ? (
                  <p className="mb-5 rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-3 text-xs text-foreground-muted">
                    No configuration has been saved yet. The advisor is running
                    on its built-in defaults. Saving anything on this page
                    creates the configuration and starts recording changes in
                    the audit log.
                  </p>
                ) : null}

                <AiConfigForm config={config} />
              </>
            )}
          </div>
        </AdminCard>

        <AdminCard>
          <AdminCardHeader
            title="What is not a setting"
            description="Two things an admin might expect to find here, and why they are not here."
          />

          <dl className="divide-y divide-neutral-100">
            <div className="px-5 py-4">
              <dt className="text-sm font-medium text-foreground">
                The disclaimer version
              </dt>

              <dd className="mt-1 text-xs text-foreground-muted">
                A stamp the server increments when the disclaimer text
                changes, so an audit can prove which wording a customer
                was actually shown. A hand-editable version could not do
                that, so it is not editable.
              </dd>
            </div>

            <div className="px-5 py-4">
              <dt className="text-sm font-medium text-foreground">
                The low-stock threshold
              </dt>

              <dd className="mt-1 text-xs text-foreground-muted">
                Fixed at five units. It is a constant in the inventory
                service rather than a setting, because a threshold that
                could be set to a value that makes the warning
                meaningless would be worse than no threshold at all.
              </dd>
            </div>
          </dl>
        </AdminCard>
      </div>
    </>
  );
}

/**
 * The page heading.
 */
function PageHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>

      <p className="mt-1.5 text-sm text-foreground-muted">{description}</p>
    </div>
  );
}
