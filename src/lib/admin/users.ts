import { Prisma, UserRole } from "@prisma/client";

import { db } from "@/lib/db";

/**
 * The admin user list service.
 *
 * ── Why this is read-only ────────────────────────────────────────────────
 *
 * Every mutating admin action in this codebase is audited: a review
 * moderation, an order cancellation, a stock adjustment — each writes
 * an `AdminAuditLog` row in the same transaction as the change it
 * describes.
 *
 * A user-edit path would be the **only** un-audited mutation in the
 * system, and it would carry obvious abuse potential:
 *
 *   • **Role elevation.** Promoting a customer to `ADMIN` is a
 *     privilege grant, and privilege grants are exactly what an audit
 *     trail exists to record.
 *   • **Consent flipping.** `User.smsOptIn` is the *only* flag that
 *     authorises an SMS send (decision #25). An admin who could flip
 *     it could message a customer who never consented — the one thing
 *     the consent design exists to prevent.
 *   • **Contact harvesting.** A phone number is personal data.
 *
 * So the Users page reports. If editing is wanted later, it is a
 * separate, audited decision — not a side effect of a "Users" page.
 */

/**
 * One row of the admin user list.
 */
export type AdminUserSummary = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  smsOptIn: boolean;
  createdAt: Date;
  /** How many orders the account has placed. */
  orderCount: number;
  /** The account's lifetime spend, in poisha, excluding cancelled orders. */
  lifetimeSpendPaisa: number;
};

/**
 * The admin user list result.
 */
export type AdminUserListResult = {
  users: AdminUserSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
  counts: {
    total: number;
    customers: number;
    admins: number;
    /** Customers who opted in to depletion reminders. */
    smsOptIn: number;
  };
};

/**
 * The search term's filter.
 *
 * Prisma parameterises the term, so there is no injection risk. But
 * `%` and `_` are SQL wildcards inside `contains`, so they are escaped
 * to match literally — the way a person typing them expects. This is
 * the same treatment the inventory search gets.
 */
function buildSearchWhere(search: string | undefined): Prisma.UserWhereInput {
  if (!search) return {};

  const escaped = search.replace(/[\\%_]/g, (char) => `\\${char}`);

  return {
    OR: [
      { name: { contains: escaped, mode: "insensitive" } },
      { email: { contains: escaped, mode: "insensitive" } },
      { phone: { contains: escaped, mode: "insensitive" } },
    ],
  };
}

/**
 * Lists the users for the admin users view.
 *
 * The counts are computed over the **whole** table, while the
 * pagination total counts only what the current filter matched — the
 * two answer different questions, and neither is derived from the
 * other. (This is the same relationship the inventory list has: the
 * band counts let an admin see "8 low stock" and navigate to them even
 * while looking at an unrelated filtered list.)
 */
export async function listAdminUsers(query: {
  readonly search?: string;
  readonly page: number;
  readonly limit: number;
}): Promise<AdminUserListResult> {
  const where: Prisma.UserWhereInput = buildSearchWhere(query.search);

  const skip = (query.page - 1) * query.limit;

  const [rows, total, all, customers, admins, smsOptIn] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        smsOptIn: true,
        createdAt: true,
        _count: { select: { orders: true } },
        orders: {
          where: { status: { not: "CANCELLED" } },
          select: { totalAmountPaisa: true },
        },
      },
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: query.limit,
    }),
    db.user.count({ where }),
    db.user.count(),
    db.user.count({ where: { role: UserRole.CUSTOMER } }),
    db.user.count({ where: { role: UserRole.ADMIN } }),
    db.user.count({ where: { smsOptIn: true } }),
  ]);

  const users: AdminUserSummary[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    smsOptIn: row.smsOptIn,
    createdAt: row.createdAt,
    orderCount: row._count.orders,
    // Cancelled orders contributed no money, so they are excluded —
    // the same rule the dashboard's revenue figure uses.
    lifetimeSpendPaisa: row.orders.reduce(
      (total, order) => total + order.totalAmountPaisa,
      0,
    ),
  }));

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    users,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    counts: { total: all, customers, admins, smsOptIn },
  };
}
