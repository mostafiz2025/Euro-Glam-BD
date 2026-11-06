import type { ReactNode } from "react";

/**
 * The admin UI primitives.
 *
 * ── Why these live in one file ───────────────────────────────────────────
 *
 * The admin surface has a small vocabulary of repeated shapes: a stat
 * tile, a status badge, a card, an empty state. Each one appears on
 * three or four pages.
 *
 * A repeated shape that is written out four times is a shape that
 * drifts — four slightly different paddings, four slightly different
 * badge colours, four slightly different empty states. So the shapes
 * live here once, and the pages compose them.
 *
 * These are **server** components: they render static markup and pull
 * in nothing from the client bundle.
 */

/**
 * A card — the standard admin panel.
 */
export function AdminCard({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section
      className={[
        "rounded-[var(--radius-card)] border border-border bg-surface",
        "shadow-[var(--shadow-card)]",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </section>
  );
}

/**
 * A card's header — a title and an optional action on the right.
 */
export function AdminCardHeader({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div>
        <h2 className="text-sm font-bold text-foreground">{title}</h2>

        {description ? (
          <p className="mt-0.5 text-xs text-foreground-muted">{description}</p>
        ) : null}
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A stat tile — one figure, with its label.
 *
 * The `tone` is the only thing that changes between tiles. The number
 * stays the loudest thing on the tile, because the number is the point.
 *
 * The `trend` is a growth indicator — the comparison against the
 * previous period. It sits *beside* the label, not under the number, so
 * the eye reads "the number, and how it moved" in one pass.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  trend,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly hint?: string;
  readonly tone?: "neutral" | "warn" | "danger" | "good";
  /** The growth indicator, if this figure has a comparison. */
  readonly trend?: GrowthIndicator;
}) {
  const tones: Record<string, string> = {
    neutral: "text-foreground",
    warn: "text-amber-600",
    danger: "text-red-600",
    good: "text-emerald-600",
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-foreground-muted">
          {label}
        </p>

        {trend ? <GrowthBadge metric={trend} /> : null}
      </div>

      <p
        className={[
          "mt-2 font-serif text-3xl font-bold tabular-nums tracking-tight",
          tones[tone] ?? tones.neutral,
        ].join(" ")}
      >
        {value}
      </p>

      {hint ? <p className="mt-1 text-xs text-foreground-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * The growth indicator's shape.
 *
 * Mirrors `GrowthMetric` in `src/lib/admin/analytics.ts`, but declared
 * here so the primitives file does not have to import from a service
 * module that reads the database. The two are structurally identical, and
 * the type is checked at the call site.
 */
export type GrowthIndicator = {
  readonly current: number;
  readonly previous: number;
  /** `null` when the percentage is undefined — see the zero-base rule. */
  readonly percentage: number | null;
  readonly kind: "UP" | "DOWN" | "FLAT" | "NEW";
};

/**
 * The growth badge.
 *
 * ── Why "NEW" is a badge and not a percentage ───────────────────────────
 *
 * A percentage against a zero base is not a number — it is a division by
 * zero wearing a percentage's clothes. The service returns `null` for
 * it, and the badge renders the word **NEW** instead: there was no
 * activity last period, and there is some now. That is a true statement.
 * "+100%" is not.
 *
 * ── Why the arrow is a character and not an icon ──────────────────────────
 *
 * The badge is inline text, and `↑`/`↓`/`→` read correctly in a text
 * context, in a screen reader's announcement, and when copied out of the
 * page into a spreadsheet. An SVG arrow would need an `aria-label` to
 * say the same thing.
 */
function GrowthBadge({ metric }: { readonly metric: GrowthIndicator }) {
  const styles: Record<GrowthIndicator["kind"], string> = {
    UP: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
    DOWN:
      "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30",
    FLAT:
      "bg-surface-muted text-foreground-muted ring-border dark:bg-white/5 dark:text-foreground-muted dark:ring-white/10",
    NEW: "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30",
  };

  const arrows: Record<GrowthIndicator["kind"], string> = {
    UP: "↑",
    DOWN: "↓",
    FLAT: "→",
    NEW: "✦",
  };

  const label =
    metric.kind === "NEW"
      ? "NEW"
      : metric.percentage === null
        ? "—"
        : `${metric.percentage > 0 ? "+" : ""}${Math.round(metric.percentage)}%`;

  return (
    <span
      className={[
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5",
        "text-[10px] font-semibold tabular-nums ring-1",
        styles[metric.kind],
      ].join(" ")}
      title={
        metric.kind === "NEW"
          ? "No activity in the previous period"
          : "Compared with the previous 30 days"
      }
    >
      <span aria-hidden="true">{arrows[metric.kind]}</span>

      <span>{label}</span>
    </span>
  );
}

/**
 * A status badge.
 *
 * The colour is keyed by the status string, and the fallback is a
 * neutral badge. A neutral fallback matters: an unrecognised status
 * must not render as "nothing" (which would read as "no status") and
 * must not crash the page (which would take the whole table down).
 */
export function StatusBadge({
  status,
  label,
}: {
  readonly status: string;
  readonly label?: string;
}) {
  /**
   * The badge colours.
   *
   * Each badge pairs a **tinted background** with a **saturated text**
   * and a **ring** in the same hue. The ring is what keeps the badge
   * legible against a card of any colour — without it, a pale tint on
   * a pale card is an edge the eye cannot find.
   *
   * The `dark:` variants are here because a status colour is the one
   * place the token layer cannot help: a badge's *meaning* is carried
   * by its hue, and that hue has to be legible against the surface it
   * sits on. A light-mode `bg-amber-50 text-amber-700` badge on a dark
   * card is a white blob — the tint reads as brighter than the surface
   * it is supposed to sit on, and the text loses its contrast.
   */
  const styles: Record<string, string> = {
    // Order fulfilment.
    PENDING:
      "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30",
    PROCESSING:
      "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30",
    SHIPPED:
      "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30",
    DELIVERED:
      "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
    CANCELLED: "bg-surface-muted text-foreground-muted ring-border",
    // Payment.
    PAID: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
    FAILED:
      "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30",
    REFUNDED: "bg-surface-muted text-foreground-muted ring-border",
    // Review moderation.
    APPROVED:
      "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
    HIDDEN: "bg-surface-muted text-foreground-muted ring-border",
    // Stock.
    IN_STOCK:
      "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30",
    OUT_OF_STOCK:
      "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30",
    LOW_STOCK:
      "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30",
    // Archived products.
    ARCHIVED: "bg-surface-muted text-foreground-muted ring-border",
  };

  return (
    <span
      className={[
        "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1",
        styles[status] ?? "bg-surface-muted text-foreground-muted ring-border",
      ].join(" ")}
    >
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * The empty state.
 *
 * ── Why "nothing here" is stated explicitly ──────────────────────────────
 *
 * A table with no rows and no message is ambiguous: is the queue empty,
 * or did the query fail?
 *
 * The distinction matters enormously for a moderation queue. "No
 * reviews are waiting" is good news. "We could not load the reviews" is
 * an outage, and an admin who reads the first when the second is true
 * will leave a backlog unattended.
 *
 * So the two are different components with different wording, and a
 * failed load never renders as an empty list.
 */
export function AdminEmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>

      <p className="mx-auto mt-1.5 max-w-sm text-xs text-foreground-muted">
        {description}
      </p>

      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * The error state.
 *
 * Deliberately distinct from the empty state — see the note above.
 */
export function AdminErrorState({ message }: { readonly message: string }) {
  return (
    <div
      role="alert"
      className="m-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      {message}
    </div>
  );
}
