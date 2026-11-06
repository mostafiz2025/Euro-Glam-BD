import { AdminAction } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import {
  AdminCard,
  AdminCardHeader,
  AdminEmptyState,
  AdminErrorState,
  StatTile,
} from "@/components/admin/primitives";
import { SearchIcon } from "@/components/ui/icons";
import {
  auditActionLabel,
  listAuditLogs,
} from "@/lib/admin/audit-logs";
import { AUDIT_ENTITY_TYPES } from "@/lib/admin/audit";
import { formatPaisa } from "@/lib/format/money";

/**
 * The admin audit-trail explorer.
 *
 * ── What this page is ──────────────────────────────────────────────────────
 *
 * Every mutating admin action in this codebase writes an
 * `AdminAuditLog` row **in the same transaction as the change it
 * describes**. So the trail is already complete and already correct —
 * this page only *reads* it.
 *
 * The question it answers is the one an admin asks after something has
 * gone wrong: *"who did this, when, and what did they change?"*
 *
 * ── Why the actor's name is on the row, not joined ────────────────────────
 *
 * `actorId` is `onDelete: SetNull`, and the name and email are
 * **copied** onto the row at write time. So an entry still names a human
 * after the account behind it is deleted. A trail that pointed at nothing
 * would be useless exactly when it is most needed.
 *
 * ── The failure case is not the empty case ────────────────────────────────
 *
 * Three distinct states, and conflating them would be a lie:
 *
 *   1. **The entries loaded.** They are shown.
 *   2. **The entries loaded and there are none.** A genuine "no
 *      activity" — a fresh database, or a filter that matches nothing.
 *      That is a true statement about the shop, and it is shown as an
 *      empty state.
 *   3. **The entries could not be loaded.** An outage. The panel says
 *      so, in words, and does not render an empty list.
 *
 * A trail that shows "no activity" because the database was unreachable
 * is a trail that will eventually be believed.
 */
export const metadata: Metadata = {
  title: "Audit Logs",
};

/**
 * The page is session-gated, so it is rendered at request time.
 */
export const instant = false;

/**
 * The number of rows one page of the trail shows.
 */
const PAGE_SIZE = 25;

export default async function AdminAuditLogsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly action?: string;
    readonly entityType?: string;
    readonly search?: string;
    readonly page?: string;
  }>;
}) {
  // The page depends on the session, so it is rendered at request time.
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts prerendering.
  await connection();

  const params = await searchParams;

  /*
   * The filters are parsed **here**, on the page, rather than through
   * the API's schema.
   *
   * The API rejects an unrecognised filter with a 400, because a machine
   * caller should be told. The page is a read-only view: a bad query
   * parameter should not leave an admin staring at an error page when
   * the fix is to click a different link. So an unrecognised filter is
   * simply **ignored**, and the unfiltered list is shown.
   */
  const action = parseAction(params.action);
  const entityType = parseEntityType(params.entityType);
  const search = params.search?.trim() || undefined;
  const page = parsePage(params.page);

  const result = await listAuditLogs({
    ...(action !== undefined ? { action } : {}),
    ...(entityType !== undefined ? { entityType } : {}),
    ...(search !== undefined ? { search } : {}),
    page,
    limit: PAGE_SIZE,
  }).catch((error: unknown) => {
    console.error("[admin] Audit trail failed:", error);
    return null;
  });

  if (!result) {
    return (
      <>
        <PageHeading
          title="Audit Logs"
          description="Every change an admin has made, and why."
        />

        <AdminErrorState message="We could not load the audit trail. Please try again in a moment." />
      </>
    );
  }

  const { entries, pagination, counts } = result;

  const hasFilters = action !== undefined || entityType !== undefined || search !== undefined;

  return (
    <>
      <PageHeading
        title="Audit Logs"
        description="Every change an admin has made, and why."
      />

      {/* ── The headline counts ────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Total entries"
          value={counts.total}
          hint="written since the trail began"
        />

        <StatTile
          label="Last 24 hours"
          value={counts.recent}
          hint="actions in the last day"
          tone={counts.recent > 0 ? "warn" : "neutral"}
        />

        <StatTile
          label="Admins acting"
          value={counts.actors}
          hint="distinct administrators on record"
        />

        <StatTile
          label="Matching"
          value={pagination.total}
          hint={
            hasFilters
              ? "entries match the current filters"
              : "entries in the trail"
          }
        />
      </div>

      {/* ── The filters ─────────────────────────────────────────────── */}
      <div className="mt-6">
        <AdminCard>
          <AdminCardHeader
            title="Filters"
            description="Narrow the trail by what was done, what it was done to, or who did it."
            action={
              hasFilters ? (
                <Link
                  href="/admin/audit-logs"
                  className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  Clear filters →
                </Link>
              ) : null
            }
          />

          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
            <span className="text-xs font-medium text-foreground-muted">
              Action
            </span>
            <FilterChip
              href={buildHref({
                action: undefined,
                entityType,
                search,
              })}
              label="All"
              active={action === undefined}
            />

            {AUDIT_ACTION_FILTERS.map((value) => (
              <FilterChip
                key={value}
                href={buildHref({
                  action: value,
                  entityType,
                  search,
                })}
                label={auditActionLabel(value)}
                active={action === value}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-4">
            <span className="text-xs font-medium text-foreground-muted">
              Entity
            </span>

            <FilterChip
              href={buildHref({
                action,
                entityType: undefined,
                search,
              })}
              label="All"
              active={entityType === undefined}
            />

            {AUDIT_ENTITY_TYPES.map((value) => (
              <FilterChip
                key={value}
                href={buildHref({
                  action,
                  entityType: value,
                  search,
                })}
                label={value.replace(/_/g, " ")}
                active={entityType === value}
              />
            ))}
          </div>

          {/*
            The search box.

            A **plain GET form**, not a client component with a fetch.
            The trail is a read-only view, and a GET form means the
            search term lives in the URL — so an admin can send
            "everything Sarah did last week" to a colleague as a link,
            and the back button returns where they were.

            The hidden inputs carry the active filters, so submitting the
            search keeps them.
          */}
          <form
            action="/admin/audit-logs"
            method="get"
            role="search"
            className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-4"
          >
            {action !== undefined ? (
              <input type="hidden" name="action" value={action} />
            ) : null}

            {entityType !== undefined ? (
              <input type="hidden" name="entityType" value={entityType} />
            ) : null}

            <label htmlFor="audit-search" className="sr-only">
              Search the trail
            </label>

            <div className="relative min-w-0 flex-1">
              <SearchIcon
                width={18}
                height={18}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-foreground-muted"
              />

              <input
                id="audit-search"
                name="search"
                type="search"
                defaultValue={search ?? ""}
                placeholder="Search by admin, reason or entity id…"
                className={[
                  "h-10 w-full rounded-full border border-border bg-surface pl-11 pr-4",
                  "text-sm text-foreground placeholder:text-foreground-muted",
                  "transition-colors duration-200",
                  "focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200",
                ].join(" ")}
              />
            </div>

            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-full bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
            >
              Search
            </button>
          </form>
        </AdminCard>
      </div>

      {/* ── The trail ──────────────────────────────────────────────── */}
      <div className="mt-6">
        <AdminCard>
          <AdminCardHeader
            title="The trail"
            description="Newest first. Each entry records who acted, what they changed, and why."
          />

          {entries.length === 0 ? (
            <AdminEmptyState
              title={hasFilters ? "No entries match these filters" : "No activity recorded yet"}
              description={
                hasFilters
                  ? "Nothing in the trail matches what you have chosen. Try widening the filters."
                  : "Once an admin changes something — a price, a stock level, a review — the decision is recorded here."
              }
              action={
                hasFilters ? (
                  <Link
                    href="/admin/audit-logs"
                    className="text-xs font-medium text-brand-700 hover:text-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                  >
                    Clear the filters
                  </Link>
                ) : null
              }
            />
          ) : (
            <ul className="divide-y divide-neutral-100">
              {entries.map((entry) => (
                <li key={entry.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">
                        {auditActionLabel(entry.action)}
                      </span>

                      <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                        {entry.entityType.replace(/_/g, " ")}
                      </span>
                    </div>

                    <time
                      dateTime={entry.createdAt.toISOString()}
                      className="shrink-0 text-xs tabular-nums text-foreground-muted"
                    >
                      {formatTimestamp(entry.createdAt)}
                    </time>
                  </div>

                  <p className="mt-1 text-xs text-foreground-muted">
                    {entry.actorName}{" "}
                    <span className="text-foreground-muted/70">
                      ({entry.actorEmail})
                    </span>
                  </p>

                  {entry.reason ? (
                    <p className="mt-2 border-l-2 border-brand-200 pl-3 text-xs italic text-foreground-muted dark:border-brand-500/40">
                      {entry.reason}
                    </p>
                  ) : null}

                  <Diff before={entry.before} after={entry.after} />
                </li>
              ))}
            </ul>
          )}
        </AdminCard>
      </div>

      {/* ── The pagination ─────────────────────────────────────────── */}
      {pagination.totalPages > 1 ? (
        <nav
          aria-label="Audit log pages"
          className="mt-4 flex items-center justify-between gap-3"
        >
          {pagination.hasPreviousPage ? (
            <Link
              href={buildHref({
                action,
                entityType,
                search,
                page: pagination.page - 1,
              })}
              className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              ← Newer
            </Link>
          ) : (
            <span />
          )}

          <span className="text-xs tabular-nums text-foreground-muted">
            Page {pagination.page} of {pagination.totalPages}
          </span>

          {pagination.hasNextPage ? (
            <Link
              href={buildHref({
                action,
                entityType,
                search,
                page: pagination.page + 1,
              })}
              className="rounded-full border border-border px-3.5 py-1.5 text-xs font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Older →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </>
  );
}

/**
 * The actions shown in the filter row.
 *
 * A short, meaningful subset rather than all seventeen. The full list
 * would wrap onto three rows and push the trail itself off the screen.
 * The three order actions are grouped as "Order", because an admin
 * asking "what happened to that order?" does not care whether the
 * payment moved or the fulfilment did.
 */
const AUDIT_ACTION_FILTERS: readonly AdminAction[] = [
  AdminAction.PRODUCT_UPDATED,
  AdminAction.PRODUCT_CREATED,
  AdminAction.PRODUCT_DELETED,
  AdminAction.PRODUCT_STOCK_ADJUSTED,
  AdminAction.REVIEW_APPROVED,
  AdminAction.REVIEW_HIDDEN,
  AdminAction.ORDER_STATUS_CHANGED,
  AdminAction.ORDER_CANCELLED,
  AdminAction.AI_CONFIG_UPDATED,
  AdminAction.COUPON_CREATED,
  AdminAction.COUPON_UPDATED,
  AdminAction.COUPON_DELETED,
];

/**
 * A filter chip.
 *
 * A **link**, not a button: it navigates — it changes the URL's query
 * parameters and the server re-renders the list. A `<button>` would be
 * the wrong element for a navigation.
 *
 * The active chip is marked with `aria-current`, so the control says
 * where it is rather than relying on colour alone.
 */
function FilterChip({
  href,
  label,
  active,
}: {
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "rounded-full px-2.5 py-1 text-xs font-medium capitalize transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        active
          ? "bg-brand-600 text-white"
          : "bg-surface-muted text-foreground-muted hover:bg-surface-sunken hover:text-foreground",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

/**
 * The before/after diff.
 *
 * Shows only the fields that **changed**. An entry that recorded the
 * whole row would be unreadable, and the changed fields are the whole
 * point of the entry.
 */
function Diff({
  before,
  after,
}: {
  readonly before: unknown;
  readonly after: unknown;
}) {
  const changes = describeChanges(before, after);

  if (changes.length === 0) return null;

  return (
    <dl className="mt-2 space-y-1">
      {changes.map((change) => (
        <div key={change.field} className="flex flex-wrap items-baseline gap-2">
          <dt className="text-[11px] font-medium uppercase tracking-wider text-foreground-muted">
            {change.field}
          </dt>

          <dd className="flex flex-wrap items-baseline gap-1.5 text-xs">
            <span className="text-foreground-muted line-through">
              {change.from}
            </span>

            <span aria-hidden="true" className="text-foreground-muted">
              →
            </span>

            <span className="font-medium text-foreground">{change.to}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A single changed field.
 */
type Change = {
  readonly field: string;
  readonly from: string;
  readonly to: string;
};

/**
 * Describes what changed between two audit snapshots.
 *
 * The snapshots are the `before` and `after` JSON blobs the service
 * wrote. The service writes **only the changed fields**, so the diff
 * here is a matter of matching the two objects' keys — not of
 * comparing a full before-state against a full after-state.
 *
 * A field that appears in only one of the two is a field that was set
 * or cleared, and its missing side reads "(not set)".
 *
 * Pure, so the rules are directly testable.
 */
export function describeChanges(
  before: unknown,
  after: unknown,
): Change[] {
  const beforeRecord = asRecord(before);
  const afterRecord = asRecord(after);

  const fields = new Set([
    ...Object.keys(beforeRecord),
    ...Object.keys(afterRecord),
  ]);

  const changes: Change[] = [];

  for (const field of fields) {
    const from = beforeRecord[field];
    const to = afterRecord[field];

    if (Object.is(from, to)) continue;

    changes.push({
      field,
      from: formatValue(from, field),
      to: formatValue(to, field),
    });
  }

  return changes;
}

/**
 * Coerces a snapshot into a plain object.
 *
 * A snapshot that is `null`, an array, or a primitive is not a set of
 * fields, so it contributes no changes rather than throwing.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

/**
 * The field names whose values are money.
 *
 * The audit entries store poisha — an integer — and a raw "95000" in a
 * diff is unreadable where "৳950" is not.
 *
 * The heuristic is the field's own **name**, not the value: a
 * `pricePaisa` field is money, a `usageCount` field is not, and both
 * happen to be integers. Matching on the value would turn every count
 * into a taka amount.
 */
const MONEY_FIELDS: readonly string[] = [
  "pricePaisa",
  "discountPricePaisa",
  "amountOffPaisa",
  "totalAmountPaisa",
  "unitPricePaisa",
  "amountPaisa",
];

/**
 * The field names whose value is a list of storage keys.
 *
 * A product's `images` is a list of storage keys — `products/2026/10/…`.
 * Rendered as raw JSON it reads as a wall of escaped slashes, which is
 * not a thing an admin is trying to read. So it is rendered as a count
 * and the **filename**, which is the part that identifies the image.
 */
const IMAGE_LIST_FIELDS: readonly string[] = ["images"];

/**
 * Formats one side of a change for display.
 *
 * A missing value reads "(not set)" rather than "undefined" — the
 * first is a statement about the record, the second is a statement
 * about JavaScript.
 */
function formatValue(value: unknown, field: string): string {
  if (value === undefined || value === null) return "(not set)";

  if (typeof value === "boolean") return value ? "yes" : "no";

  if (typeof value === "number") {
    if (MONEY_FIELDS.includes(field)) {
      return formatPaisa(value);
    }

    return String(value);
  }

  if (typeof value === "string") {
    // An ISO timestamp is stored as a string; showing it verbatim is
    // honest and legible.
    return value;
  }

  if (Array.isArray(value) && IMAGE_LIST_FIELDS.includes(field)) {
    return formatImageList(value);
  }

  return JSON.stringify(value);
}

/**
 * Formats a list of storage keys as "N images — name, name".
 *
 * The key's **last** segment is the filename, and the filename is the
 * only part that identifies an image to a human. The rest of the key is
 * the scope, the year, the month and a random suffix — machinery the
 * admin does not care about.
 *
 * An empty list reads "no images", which is a fact about the record
 * rather than an absence of one.
 */
function formatImageList(value: readonly unknown[]): string {
  if (value.length === 0) return "no images";

  const names = value.map((entry) => {
    if (typeof entry !== "string") return String(entry);

    const segments = entry.split("/");

    return segments[segments.length - 1] ?? entry;
  });

  const count = `${value.length} image${value.length === 1 ? "" : "s"}`;

  return `${count} — ${names.join(", ")}`;
}

/**
 * Formats a timestamp for the trail.
 *
 * The date, the time, and how long ago it was — because "when" is the
 * question an admin is usually answering, and an absolute date is the
 * harder one to read at a glance.
 */
function formatTimestamp(date: Date): string {
  const absolute = date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${absolute} (${formatRelative(date)})`;
}

/**
 * Formats how long ago something happened.
 *
 * Deliberately coarse. "3 days ago" is enough for a trail an admin
 * scans; "3 days, 4 hours, 22 minutes and 11 seconds ago" is not.
 */
function formatRelative(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.floor(months / 12);

  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Builds a link that preserves the current filters.
 *
 * A filter link that dropped the other filters would be a trap: an
 * admin who filtered by action and then clicked a different action
 * would lose their entity filter without being told.
 *
 * So every link carries **all four** parameters, and the caller's
 * `overrides` replace one or more of them. `undefined` means "remove
 * this filter" — which is exactly what the "All" chips mean.
 *
 * The page number is dropped whenever a filter changes, because page 4
 * of the previous filter is not page 4 of the new one: keeping it would
 * land the admin on an empty page.
 */
function buildHref(overrides: {
  readonly action?: AdminAction | undefined;
  readonly entityType?: string | undefined;
  readonly search?: string | undefined;
  readonly page?: number | undefined;
}): string {
  const params = new URLSearchParams();

  const action = overrides.action;
  const entityType = overrides.entityType;
  const search = overrides.search;
  const page = overrides.page;

  if (action !== undefined) params.set("action", action);
  if (entityType !== undefined) params.set("entityType", entityType);
  if (search !== undefined) params.set("search", search);
  if (page !== undefined && page > 1) params.set("page", String(page));

  const query = params.toString();

  return query.length > 0 ? `/admin/audit-logs?${query}` : "/admin/audit-logs";
}

/**
 * Parses the action filter.
 *
 * An unrecognised value is ignored rather than rejected — see the note
 * at the top of the page.
 */
function parseAction(value: string | undefined): AdminAction | undefined {
  if (!value) return undefined;

  const match = Object.values(AdminAction).find(
    (action) => action === value.toUpperCase(),
  );

  return match;
}

/**
 * Parses the entity-type filter.
 */
function parseEntityType(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const match = AUDIT_ENTITY_TYPES.find(
    (type) => type === value.toLowerCase(),
  );

  return match;
}

/**
 * Parses the page number.
 *
 * A page below 1, or one that is not a number at all, falls back to the
 * first page rather than erroring.
 */
function parsePage(value: string | undefined): number {
  if (!value) return 1;

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return 1;

  return parsed;
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
