import {
  AdminAction,
  Prisma,
  type AdminAuditLog,
} from "@prisma/client";

import type { SessionUser } from "@/lib/auth/guards";
import {
  AUDIT_ENTITY_TYPES,
  type AuditEntityType,
} from "@/lib/validation/admin";

/**
 * The admin audit log.
 *
 * ── The one rule that governs this file ────────────────────────────────
 *
 * **An audit entry is written in the same transaction as the change it
 * describes.**
 *
 * A mutation without an audit trail is worse than no audit trail at all,
 * because it looks complete. An admin who cancelled an order, and a
 * support agent who later asks "who did this and why", both deserve an
 * answer — and if the two writes are separate, a crash between them
 * leaves a changed order with no record of who changed it.
 *
 * So `writeAuditEntry` takes a `TransactionClient`, and there is
 * deliberately **no overload that takes the root `db` client**. Writing
 * an audit entry outside a transaction is awkward by construction rather
 * than by convention.
 */

/**
 * The Prisma client type an interactive transaction receives.
 *
 * `Prisma.TransactionClient` omits the `$transaction` and `$connect`
 * methods, which is exactly the set of operations that are safe inside
 * a transaction.
 */
export type AuditTransactionClient = Prisma.TransactionClient;

/**
 * The admin who performed an action.
 *
 * A narrow shape rather than the whole `SessionUser`, because the audit
 * writer only needs the identity — and because the `SessionUser` carries
 * a `smsOptIn` flag that has nothing to do with an audit trail.
 */
export type AuditActor = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
};

/**
 * Projects a session user onto the audit actor shape.
 */
export function toAuditActor(user: SessionUser): AuditActor {
  return { id: user.id, name: user.name, email: user.email };
}

/**
 * The kinds of thing an audit entry can describe.
 *
 * These are the `entityType` values. They are a closed set, because an
 * entry whose type is not one of these is a bug — it would be invisible
 * to every filter.
 *
 * The list itself lives in the **validation** layer, which is the lower
 * of the two: the admin services import from there, so it cannot import
 * from here. Re-exported so the callers that already reach for it here
 * keep working, and so there is exactly one copy of the list.
 */
export { AUDIT_ENTITY_TYPES };
export type { AuditEntityType };

/**
 * Returns true when a string is a known entity type.
 */
export function isAuditEntityType(value: string): value is AuditEntityType {
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * The input to `writeAuditEntry`.
 */
export type AuditEntryInput = {
  /** The admin who performed the action. */
  readonly actor: AuditActor;
  /** What was done. */
  readonly action: AdminAction;
  /** The kind of thing acted upon. */
  readonly entityType: AuditEntityType;
  /** The id of the thing acted upon. */
  readonly entityId: string;
  /** The state before the action. */
  readonly before?: Record<string, unknown> | null;
  /** The state after the action. */
  readonly after?: Record<string, unknown> | null;
  /** A free-text reason, for the actions that need one. */
  readonly reason?: string | null;
};

/**
 * The audit entry as it is returned to an admin.
 */
export type AuditEntry = {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string;
  readonly actorEmail: string;
  readonly action: AdminAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly createdAt: Date;
};

/**
 * Projects an audit row onto the shape returned to admins.
 */
export function toAuditEntry(row: AdminAuditLog): AuditEntry {
  return {
    id: row.id,
    actorId: row.actorId,
    actorName: row.actorName,
    actorEmail: row.actorEmail,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/**
 * Writes an audit entry.
 *
 * **Must be called with a transaction client**, so the entry commits or
 * rolls back together with the change it describes.
 *
 * The actor's name and email are copied into the row rather than joined
 * at read time. That is deliberate: when an admin's account is deleted,
 * the `actorId` foreign key is nulled — and the entry still names a
 * human rather than pointing at nothing.
 *
 * @param tx   - The transaction the change is being made in.
 * @param entry - What happened.
 */
export async function writeAuditEntry(
  tx: AuditTransactionClient,
  entry: AuditEntryInput,
): Promise<void> {
  // Prisma's Json input type is narrower than `Record<string, unknown>`
  // — it wants a concrete JSON value rather than an open-ended record.
  // The cast is safe here because the only values that reach it are the
  // status snapshots the services build, which are plain JSON objects.
  await tx.adminAuditLog.create({
    data: {
      actorId: entry.actor.id,
      actorName: entry.actor.name,
      actorEmail: entry.actor.email,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before:
        entry.before === null || entry.before === undefined
          ? undefined
          : (entry.before as Prisma.InputJsonValue),
      after:
        entry.after === null || entry.after === undefined
          ? undefined
          : (entry.after as Prisma.InputJsonValue),
      reason: entry.reason ?? null,
    },
  });
}

/**
 * The audit actions that describe a review being moderated.
 *
 * Kept as a lookup so a moderation action and its audit entry cannot
 * drift apart — the same action string is used for both.
 */
export const REVIEW_ACTIONS = {
  approve: AdminAction.REVIEW_APPROVED,
  hide: AdminAction.REVIEW_HIDDEN,
  unhide: AdminAction.REVIEW_UNHIDDEN,
} as const;

/**
 * The audit actions that describe an order changing.
 *
 * `gatewaySettled` is deliberately its own member rather than a reuse of
 * `paymentStatusChanged`. The trail has to answer *"who did this?"*, and
 * the two answers are different: `paymentStatusChanged` is a **staff**
 * member's decision, while `gatewaySettled` is the **customer** settling
 * their own payment through the gateway. Reusing one action for both
 * would make a customer's self-service payment indistinguishable from a
 * person confirming a transfer by hand.
 */
export const ORDER_ACTIONS = {
  statusChanged: AdminAction.ORDER_STATUS_CHANGED,
  paymentStatusChanged: AdminAction.ORDER_PAYMENT_STATUS_CHANGED,
  gatewaySettled: AdminAction.ORDER_PAYMENT_GATEWAY_SETTLED,
  /**
   * A settlement confirmed by the SSLCOMMERZ gateway.
   *
   * Separate from `gatewaySettled` because the two are different actors
   * writing to the same column. `gatewaySettled` is the customer
   * settling through the shop's own simulated gateway window;
   * `sslcommerzSettled` is a third-party gateway acting on a callback
   * the shop verified against SSLCOMMERZ's own validation API. The
   * trail has to be able to say which one happened.
   */
  sslcommerzSettled: AdminAction.ORDER_PAYMENT_SSLCOMMERZ_SETTLED,
  cancelled: AdminAction.ORDER_CANCELLED,
} as const;

/**
 * The audit actions that describe an SMS being sent.
 */
export const SMS_ACTIONS = {
  sweep: AdminAction.SMS_REMINDER_SWEEP,
  sent: AdminAction.SMS_REMINDER_SENT,
  resent: AdminAction.SMS_REMINDER_RESENT,
} as const;

/**
 * The audit actions that describe a product changing.
 *
 * The same lookup discipline as the three above: a product mutation and
 * its audit entry use the same action string, so the two cannot drift
 * apart.
 *
 * The test in `tests/admin/audit.test.ts` asserts that **every** value in
 * the `AdminAction` enum is covered by one of these lookups. That check
 * is the reason a new enum value cannot be added without a lookup
 * pointing at it — an action no service can write is an action that
 * looks supported but silently never happens.
 */
export const PRODUCT_ACTIONS = {
  stockAdjusted: AdminAction.PRODUCT_STOCK_ADJUSTED,
  created: AdminAction.PRODUCT_CREATED,
  updated: AdminAction.PRODUCT_UPDATED,
  deleted: AdminAction.PRODUCT_DELETED,
} as const;

/**
 * The audit actions that describe the AI configuration changing.
 *
 * Settings is a mutating admin surface, and it is the only one that
 * shipped **without** an audit trail. That is precisely why the trail
 * matters: the advisor's disclaimer is compliance text, and "who
 * changed the compliance text, from what, to what" is a question an
 * audit exists to answer.
 */
export const AI_CONFIG_ACTIONS = {
  updated: AdminAction.AI_CONFIG_UPDATED,
} as const;

/**
 * The audit actions that describe the site's settings changing.
 *
 * The announcement marquee is a **commercial surface**: it is the first
 * thing a customer reads, on every page, and it says whatever the shop
 * wants said that week. "Who switched the announcement on, and what did
 * it say" is a question an audit exists to answer — a marquee that
 * promotes a campaign that has ended, or that points somewhere
 * unexpected, is a problem somebody has to trace back to a decision.
 */
export const SITE_SETTINGS_ACTIONS = {
  updated: AdminAction.SITE_SETTINGS_UPDATED,
} as const;

/**
 * The audit actions that describe an administrator changing **their own**
 * profile.
 *
 * ── Why this is separate from the site's settings ──────────────────────────
 *
 * The two look alike — an admin, on a settings page, changing a name and
 * a phone number — and they are genuinely different acts:
 *
 *   • `SITE_SETTINGS_UPDATED` is the **shop** changing. The marquee and
 *     the support details are seen by every customer.
 *   • `ADMIN_PROFILE_UPDATED` is **one person** changing their own
 *     record. Nobody else sees it.
 *
 * Reusing one action for both would leave the trail unable to answer
 * "who changed the shop's contact details?" without also matching every
 * admin's own name correction. The audit explorer filters on the action,
 * so the two have to be distinguishable there.
 */
export const ADMIN_PROFILE_ACTIONS = {
  updated: AdminAction.ADMIN_PROFILE_UPDATED,
} as const;

/**
 * The audit actions that describe a coupon changing.
 *
 * The same lookup discipline as every other group. A coupon's terms are
 * a **commercial decision with a monetary value** — "twenty percent off"
 * is a price reduction — so the audit trail records who set them, what
 * they were before, and what they became.
 *
 * `deleted` covers **deactivation** as well as removal. A coupon is
 * rarely hard-deleted: it has been redeemed, and the redemption history
 * is what makes a campaign's performance readable. So the ordinary path
 * is "switch it off", and the audit entry says which.
 */
export const COUPON_ACTIONS = {
  created: AdminAction.COUPON_CREATED,
  updated: AdminAction.COUPON_UPDATED,
  deleted: AdminAction.COUPON_DELETED,
} as const;

/**
 * The audit actions that describe a category changing.
 *
 * The same lookup discipline as every other group. A category is a
 * storefront surface — its card image is what a shopper sees first — so
 * "who changed the picture on the Cleansers tile, and when" is a question
 * an audit should be able to answer.
 */
export const CATEGORY_ACTIONS = {
  created: AdminAction.CATEGORY_CREATED,
  updated: AdminAction.CATEGORY_UPDATED,
  deleted: AdminAction.CATEGORY_DELETED,
} as const;

/**
 * The audit actions that describe a skin concern changing.
 */
export const CONCERN_ACTIONS = {
  created: AdminAction.CONCERN_CREATED,
  updated: AdminAction.CONCERN_UPDATED,
  deleted: AdminAction.CONCERN_DELETED,
} as const;

/**
 * The audit actions that describe a brand changing.
 *
 * A brand carries a **logo**, which is a trademarked asset. The audit
 * trail records who uploaded it and when — which is the first half of
 * answering "do we have permission to display this?".
 */
export const BRAND_ACTIONS = {
  created: AdminAction.BRAND_CREATED,
  updated: AdminAction.BRAND_UPDATED,
  deleted: AdminAction.BRAND_DELETED,
} as const;

/**
 * The audit actions that describe a homepage hero banner changing.
 *
 * The hero is the shop's **opening line** — the first thing every
 * customer sees, on every visit. So the audit trail's job here is the
 * same as it is for a coupon's terms: to answer "what did the shop say
 * to its customers, and when did it change its mind?".
 *
 * A banner's headline, its artwork and its calls to action are all
 * recorded, so a change to any of them is reconstructable from the log
 * alone.
 */
export const HERO_BANNER_ACTIONS = {
  created: AdminAction.HERO_BANNER_CREATED,
  updated: AdminAction.HERO_BANNER_UPDATED,
  deleted: AdminAction.HERO_BANNER_DELETED,
} as const;
