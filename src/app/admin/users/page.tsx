import type { Metadata } from "next";
import { connection } from "next/server";

import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatTile,
  StatusBadge,
} from "@/components/admin/primitives";
import { listAdminUsers } from "@/lib/admin/users";
import { formatPaisa } from "@/lib/format/money";

/**
 * The admin users list.
 *
 * ── What this page is, and what it deliberately is not ───────────────────
 *
 * This page **reports**. It does not edit.
 *
 * Every mutating admin action in this codebase is audited: a review
 * moderation, an order cancellation, a stock adjustment — each writes an
 * `AdminAuditLog` row in the same transaction as the change it
 * describes.
 *
 * A user-edit path would be the **only** un-audited mutation in the
 * system, and it would carry obvious abuse potential:
 *
 *   • **Role elevation.** Promoting a customer to `ADMIN` is a
 *     privilege grant, and privilege grants are exactly what an audit
 *     trail exists to record.
 *   • **Consent flipping.** `User.smsOptIn` is the *only* flag that
 *     authorises an SMS send. An admin who could flip it could message
 *     a customer who never consented — the one thing the consent design
 *     exists to prevent.
 *   • **Contact harvesting.** A phone number is personal data.
 *
 * So the Users page reports. If editing is wanted later, it is a
 * separate, audited decision — not a side effect of a "Users" page.
 *
 * The columns are chosen with the same lens: each one is a fact an
 * operator needs, and none of them is a capability they are being
 * offered.
 */
export const metadata: Metadata = {
  title: "Users",
};

/**
 * The page is session-gated, so it is rendered at request time.
 */
export const instant = false;

export default async function AdminUsersPage() {
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const result = await listAdminUsers({ page: 1, limit: 50 }).catch(
    (error: unknown) => {
      console.error("[admin] User list failed:", error);
      return null;
    },
  );

  if (!result) {
    return (
      <>
        <PageHeading
          title="Users"
          description="Who has an account, and who can be reminded."
        />

        <AdminErrorState message="We could not load the user list. Please try again in a moment." />
      </>
    );
  }

  const { users, counts } = result;

  return (
    <>
      <PageHeading
        title="Users"
        description="Who has an account, and who can be reminded."
      />

      {/* ── The headline counts ────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Accounts" value={counts.total} hint="all time" />

        <StatTile
          label="Customers"
          value={counts.customers}
          hint="can place orders"
        />

        <StatTile
          label="Administrators"
          value={counts.admins}
          hint="can use this console"
        />

        <StatTile
          label="SMS reminders on"
          value={counts.smsOptIn}
          hint="have opted in"
          tone={counts.smsOptIn > 0 ? "good" : "neutral"}
        />
      </div>

      <div className="mt-6">
        <AdminCard>
          <AdminCardHeader
            title="All accounts"
            description="The most recent accounts first. This list is read-only."
          />

          {users.length === 0 ? (
            <AdminEmptyState
              title="No accounts yet"
              description="Nobody has signed up. Accounts appear here as soon as the first customer does."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wider text-foreground-muted">
                    <th scope="col" className="px-5 py-3 font-medium">
                      Customer
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Contact
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Role
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Orders
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Lifetime spend
                    </th>
                    <th scope="col" className="px-5 py-3 font-medium">
                      Joined
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-neutral-100">
                  {users.map((user) => (
                    <tr key={user.id} className="align-middle">
                      <td className="px-5 py-3">
                        <span className="block font-medium text-foreground">
                          {user.name}
                        </span>
                        <span className="block text-xs text-foreground-muted">
                          {user.email}
                        </span>
                      </td>

                      <td className="px-5 py-3 text-foreground-muted">
                        {user.phone ?? (
                          <span className="text-xs">No phone number</span>
                        )}
                      </td>

                      <td className="px-5 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge
                            status={user.role}
                            label={user.role === "ADMIN" ? "Admin" : "Customer"}
                          />

                          {user.smsOptIn ? (
                            <span className="text-[10px] uppercase tracking-wider text-foreground-muted">
                              SMS on
                            </span>
                          ) : null}
                        </div>
                      </td>

                      <td className="px-5 py-3 tabular-nums text-foreground">
                        {user.orderCount}
                      </td>

                      <td className="px-5 py-3 tabular-nums text-foreground">
                        {formatPaisa(user.lifetimeSpendPaisa)}
                      </td>

                      <td className="px-5 py-3 text-xs text-foreground-muted">
                        {user.createdAt.toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="border-t border-border px-5 py-3 text-xs text-foreground-muted">
            Showing the {users.length} most recent of {counts.total}{" "}
            account{counts.total === 1 ? "" : "s"}. Cancelled orders are
            excluded from the lifetime spend.
          </p>
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
