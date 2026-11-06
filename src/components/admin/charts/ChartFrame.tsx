import type { ReactNode } from "react";

import { AdminCard, AdminCardHeader } from "@/components/admin/primitives";

/**
 * The shared chart chrome.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * A chart is three things: a title, a body, and — sometimes — a
 * control. This component owns the first two, so every chart in the
 * console has the same padding, the same header height, and the same
 * empty-state treatment.
 *
 * The empty state matters most. A chart with no data must say so
 * **explicitly**. A chart frame with a blank body reads as "the data is
 * zero", which is a claim about the shop — and if the real reason is
 * "nothing has been recorded yet", that claim is wrong, and an admin
 * reading it would conclude something they should not.
 *
 * So `empty` is a required prop of the body, and it is rendered with
 * the same prominence as a chart, not as a faint placeholder.
 */
export function ChartFrame({
  title,
  description,
  action,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <AdminCard>
      <AdminCardHeader
        title={title}
        description={description}
        action={action}
      />

      {children}
    </AdminCard>
  );
}

/**
 * The empty state for a chart.
 *
 * Deliberately distinct in wording from a chart that legitimately has
 * no data. "Nothing recorded yet" is a statement about the *collector's
 * history*; "0 revenue" is a statement about the *shop*. They are
 * different facts and they get different words.
 */
export function ChartEmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm font-semibold text-foreground">{title}</p>

      <p className="mx-auto mt-1.5 max-w-sm text-xs text-foreground-muted">
        {description}
      </p>
    </div>
  );
}
