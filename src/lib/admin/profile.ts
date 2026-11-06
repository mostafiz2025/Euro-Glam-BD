import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/guards";

import { ADMIN_PROFILE_ACTIONS, writeAuditEntry, type AuditActor } from "./audit";

/**
 * The signed-in administrator's own profile.
 *
 * ── What this module is for ───────────────────────────────────────────────
 *
 * The Settings page has two kinds of thing on it, and they are not the
 * same kind of thing:
 *
 *   • **The shop's configuration** — the announcement marquee, the
 *     support contact details, the AI advisor's rules. These belong to
 *     the *shop*. Every admin sees them, every customer is affected by
 *     them, and they live in the `site_settings` row. That is the
 *     `site-settings.ts` service.
 *
 *   • **The administrator's own details** — the name in the top bar, the
 *     telephone number on their own account. These belong to **one
 *     person**. Nobody else sees them, and they live on the `users` row.
 *     That is this module.
 *
 * The two are separated because conflating them would be a mistake with
 * consequences: a "support phone" edited in the wrong form would change
 * the number every customer sees, and an admin's personal number edited
 * in the shop's form would change nothing they expected.
 *
 * ── What an admin may change about themselves ─────────────────────────────
 *
 * **Their name. Their phone number. Nothing else.**
 *
 * The email address is deliberately **not** editable here, and the reason
 * is the identity question:
 *
 *   • The email address is the account's **identity**. It is the
 *     username, it is the sign-in key, and it is where the password reset
 *     goes. Changing it is not "updating a detail" — it is moving the
 *     account to a different address, and everything that has ever been
 *     sent to the old address stays there.
 *
 *   • The shop already owns an **email verification** flow. A new address
 *     has to be proved before it is trusted, and that flow stamps
 *     `emailVerifiedAt` and resets it when the address changes. Wiring
 *     that into a self-service profile form is a real piece of work, and
 *     until it is done the honest answer is to not offer the field at
 *     all rather than to offer it and quietly skip the verification.
 *
 *   • The `role` is not editable either, for the same family of reasons.
 *     A role change is a **privilege grant**, and privilege grants are
 *     made by somebody else, on the Users page, and recorded there. A
 *     self-service role field would let any admin promote themselves.
 *
 * ── Why the phone number may be changed, but not the SMS consent ─────────
 *
 * The phone number is a piece of contact information — it is how the shop
 * reaches the admin. Editing it is ordinary profile maintenance.
 *
 * The SMS **consent** flag is a different thing entirely. It is the only
 * flag that authorises the platform to send a depletion reminder, and it
 * is a decision about **being messaged**, not about what number to be
 * messaged at. So `smsOptIn` is not in the patch type, and the service
 * does not write it. An admin who does not want reminders clears the
 * flag on their storefront account; an admin editing their profile is
 * correcting a spelling.
 *
 * ── Why the change is audited ─────────────────────────────────────────────
 *
 * Because it is a mutating admin surface, and because "who changed this
 * admin's name, from what, to what" is a question the audit trail
 * exists to answer. The entry is written in the **same transaction** as
 * the change it describes, so a crash between the two cannot leave a
 * changed profile with no record of who changed it.
 *
 * Note what the trail does **not** record: the audit log's own comment
 * says *"Only status flags and order statuses are ever stored here —
 * never a shipping address, never a price, never a phone number."* So
 * the phone number is recorded as a **change flag** — "the phone number
 * changed" — and not as the number itself.
 */

/**
 * The profile as the Settings page sees it.
 *
 * Deliberately narrow: it holds the fields the admin may see and edit,
 * and nothing else. The `passwordHash` is not here, and there is no way
 * for it to reach a response body by accident.
 */
export type AdminProfile = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly role: string;
  readonly smsOptIn: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly updatedAt: Date;
};

/**
 * The fields an admin may change about themselves.
 *
 * Every field is optional — an update that names one field leaves the
 * others alone.
 */
export type AdminProfilePatch = {
  readonly name?: string;
  readonly phone?: string | null;
};

/**
 * The Prisma select for the admin's own row.
 *
 * `passwordHash` is **not** selected. The select is what decides which
 * columns reach the process, so excluding it here is stronger than
 * remembering to strip it later.
 */
const ADMIN_PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  smsOptIn: true,
  emailVerifiedAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

/**
 * Loads the signed-in administrator's profile.
 *
 * The id comes from the **session**, never from the request body. A
 * profile endpoint that took the id from the client would let any admin
 * read and write any other admin's row — the id in the body is
 * attacker-controlled, and the only trustworthy id is the one the guard
 * resolved from the session cookie.
 *
 * @param adminId - The id of the signed-in administrator.
 *
 * @throws ApiError 404 when the row has gone — an admin whose account was
 *         deleted mid-session.
 */
export async function getAdminProfile(adminId: string): Promise<AdminProfile> {
  const user = await db.user.findUnique({
    where: { id: adminId },
    select: ADMIN_PROFILE_SELECT,
  });

  if (!user) {
    throw ApiError.notFound(
      "Your account could not be found. Please sign in again.",
    );
  }

  return user;
}

/**
 * Updates the signed-in administrator's profile, atomically with its
 * audit entry.
 *
 * ── Why the actor is the admin themselves ─────────────────────────────────
 *
 * This service can only ever write to the row the actor owns. The id is
 * taken from the session and **not** from the patch, and the `where`
 * clause on the update names that id. So even a malformed request
 * cannot make this write to somebody else's row — the id is not in the
 * request at all.
 *
 * @param actor - The admin making the change.
 * @param patch - The fields to change. Unnamed fields are left alone.
 */
export async function updateAdminProfile(
  actor: AuditActor,
  patch: AdminProfilePatch,
): Promise<AdminProfile> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const existing = await tx.user.findUnique({
        where: { id: actor.id },
        select: ADMIN_PROFILE_SELECT,
      });

      if (!existing) {
        throw ApiError.notFound(
          "Your account could not be found. Please sign in again.",
        );
      }

      const data: Prisma.UserUpdateInput = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.phone !== undefined
          ? { phone: patch.phone === null ? null : patch.phone }
          : {}),
      };

      const saved = await tx.user.update({
        where: { id: actor.id },
        data,
        select: ADMIN_PROFILE_SELECT,
      });

      /*
       * ── The diff ──────────────────────────────────────────────────────
       *
       * Only the fields that actually changed are recorded, so the audit
       * entry reads "the name changed" rather than reproducing the whole
       * row on every save.
       *
       * The phone number is recorded as a **flag**, not as a value. The
       * audit log's own comment says never to store a phone number in
       * it, and that rule is about the *content* of the trail rather
       * than about who may read it: the trail is browsable by every
       * admin, and it is copied out of the database into exports and
       * backups. A number that changes is worth recording; the number
       * itself is not.
       */
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      if (patch.name !== undefined && existing.name !== saved.name) {
        before.name = existing.name;
        after.name = saved.name;
      }

      if (patch.phone !== undefined && existing.phone !== saved.phone) {
        before.phone = existing.phone === null ? null : "set";
        after.phone = saved.phone === null ? null : "set";
      }

      /*
       * A save that changed nothing is not an action worth auditing.
       * Writing an entry with empty `before` and `after` would pad the
       * log with noise and make a real change harder to find — the same
       * rule the site-settings service follows.
       */
      if (Object.keys(after).length > 0) {
        await writeAuditEntry(tx, {
          actor,
          action: ADMIN_PROFILE_ACTIONS.updated,
          entityType: "admin_profile",
          entityId: actor.id,
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

/**
 * The session user, projected onto the audit actor shape.
 *
 * Re-exported from here so the profile route has one import for the
 * "who is acting" question, and does not reach into the audit module for
 * a conversion it does not otherwise need.
 */
export function toProfileActor(user: SessionUser): AuditActor {
  return { id: user.id, name: user.name, email: user.email };
}
