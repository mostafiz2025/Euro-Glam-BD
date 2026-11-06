import { AdminAction, Prisma } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * The admin audit-trail explorer.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * Every mutating admin action in this codebase writes an
 * `AdminAuditLog` row **in the same transaction as the change it
 * describes**. So the trail is already complete and already correct —
 * this module only *reads* it.
 *
 * The question it answers is the one an admin asks after something has
 * gone wrong: *"who did this, when, and what did they change?"*
 *
 * ── Why the actor's name is denormalised on the row ───────────────────────
 *
 * `AdminAuditLog.actorId` is `onDelete: SetNull`, and the actor's name
 * and email are **copied** onto the row at write time. So an entry still
 * names a human after the account behind it is deleted. A trail that
 * pointed at nothing would be useless exactly when it is most needed.
 *
 * ── Why the read is a plain query, not a join ─────────────────────────────
 *
 * There is nothing to join. The row carries everything the explorer
 * shows: who, what, which entity, before, after, why and when. Joining
 * `User` back in would only reproduce what the row already holds, and
 * would lose the deleted account's name in the process.
 */
export type AuditLogEntry = {
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
 * The audit-log list result.
 */
export type AuditLogListResult = {
  readonly entries: readonly AuditLogEntry[];
  readonly pagination: {
    readonly page: number;
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
  };
  readonly counts: {
    readonly total: number;
    /** Entries written in the last 24 hours. */
    readonly recent: number;
    /** The number of distinct admins who have acted. */
    readonly actors: number;
  };
};

/**
 * The query for the audit trail.
 */
export type AuditLogQuery = {
  readonly action?: AdminAction;
  readonly entityType?: string;
  readonly actorId?: string;
  readonly search?: string;
  readonly page: number;
  readonly limit: number;
};

/**
 * Builds the search filter.
 *
 * The term is matched against the actor's name, their email, the reason
 * and the entity id — the four things an admin would plausibly type to
 * find an entry.
 *
 * Prisma parameterises the term, so there is no injection risk. But
 * `%` and `_` are SQL wildcards inside `contains`, so they are escaped
 * to match literally — the way a person typing them expects. This is
 * the same treatment the inventory and user searches get.
 */
function buildSearchWhere(search: string | undefined): Prisma.AdminAuditLogWhereInput {
  if (!search) return {};

  const escaped = search.replace(/[\\%_]/g, (char) => `\\${char}`);

  return {
    OR: [
      { actorName: { contains: escaped, mode: "insensitive" } },
      { actorEmail: { contains: escaped, mode: "insensitive" } },
      { reason: { contains: escaped, mode: "insensitive" } },
      { entityId: { contains: escaped, mode: "insensitive" } },
    ],
  };
}

/**
 * Lists the audit trail.
 *
 * The counts are computed over the **whole** table, while the pagination
 * total counts only what the current filter matched — the two answer
 * different questions, and neither is derived from the other. This is
 * the same relationship the inventory list, the user list and the coupon
 * list have.
 */
export async function listAuditLogs(
  query: AuditLogQuery,
): Promise<AuditLogListResult> {
  const where: Prisma.AdminAuditLogWhereInput = {
    ...(query.action !== undefined ? { action: query.action } : {}),
    ...(query.entityType !== undefined ? { entityType: query.entityType } : {}),
    ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
    ...buildSearchWhere(query.search),
  };

  const skip = (query.page - 1) * query.limit;

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [rows, total, all, recent, actors] = await Promise.all([
    db.adminAuditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: query.limit,
    }),
    db.adminAuditLog.count({ where }),
    db.adminAuditLog.count(),
    db.adminAuditLog.count({ where: { createdAt: { gte: oneDayAgo } } }),
    /*
     * The number of distinct admins who have ever acted.
     *
     * `actorId` is nullable — a deleted admin's entries have it nulled
     * — so it is counted as a distinct value rather than joined. A
     * `count` of a joined relation would have to de-duplicate in
     * application code, and the join would multiply the rows for no
     * benefit.
     */
    db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "actorId")::bigint AS count
      FROM admin_audit_logs
      WHERE "actorId" IS NOT NULL
    `,
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    entries: rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    counts: {
      total: all,
      recent,
      // The raw query returns a `BigInt`. `Number()` converts it — safe
      // here, because it is a count.
      actors: Number(actors[0]?.count ?? 0),
    },
  };
}

/**
 * A human-readable description of what an action did.
 *
 * The enum names are written for the database (`PRODUCT_STOCK_ADJUSTED`),
 * not for a person reading a table. This maps them to prose, so the
 * trail reads as a record of decisions rather than a list of constants.
 */
const ACTION_LABELS: Record<AdminAction, string> = {
  REVIEW_APPROVED: "Approved a review",
  REVIEW_HIDDEN: "Hid a review",
  REVIEW_UNHIDDEN: "Un-hid a review",
  ORDER_STATUS_CHANGED: "Changed an order's status",
  ORDER_PAYMENT_STATUS_CHANGED: "Changed an order's payment status",
  ORDER_PAYMENT_GATEWAY_SETTLED: "Settled an order's payment through the gateway",
  ORDER_PAYMENT_SSLCOMMERZ_SETTLED:
    "Settled an order's payment through SSLCOMMERZ",
  ORDER_CANCELLED: "Cancelled an order",
  SMS_REMINDER_SWEEP: "Ran a depletion-reminder sweep",
  SMS_REMINDER_SENT: "Sent a depletion reminder",
  SMS_REMINDER_RESENT: "Resent a depletion reminder",
  PRODUCT_STOCK_ADJUSTED: "Adjusted a product's stock",
  PRODUCT_CREATED: "Added a product",
  PRODUCT_UPDATED: "Changed a product",
  PRODUCT_DELETED: "Removed a product",
  AI_CONFIG_UPDATED: "Changed the advisor configuration",
  COUPON_CREATED: "Created a coupon",
  COUPON_UPDATED: "Changed a coupon",
  COUPON_DELETED: "Deactivated a coupon",
  CATEGORY_CREATED: "Added a category",
  CATEGORY_UPDATED: "Changed a category",
  CATEGORY_DELETED: "Removed a category",
  CONCERN_CREATED: "Added a skin concern",
  CONCERN_UPDATED: "Changed a skin concern",
  CONCERN_DELETED: "Removed a skin concern",
  BRAND_CREATED: "Added a brand",
  BRAND_UPDATED: "Changed a brand",
  BRAND_DELETED: "Removed a brand",
  HERO_BANNER_CREATED: "Added a hero banner",
  HERO_BANNER_UPDATED: "Changed a hero banner",
  HERO_BANNER_DELETED: "Removed a hero banner",
  SITE_SETTINGS_UPDATED: "Changed the announcement marquee",
  ADMIN_PROFILE_UPDATED: "Changed their own profile details",
};

/**
 * The human label for an audit action.
 *
 * Falls back to the raw enum name for an action this file does not know
 * about, so a newly added action still renders rather than crashing the
 * page.
 */
export function auditActionLabel(action: AdminAction): string {
  return ACTION_LABELS[action] ?? action;
}
