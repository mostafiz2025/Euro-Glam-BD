import { InfoIcon } from "@/components/ui/icons";

/**
 * The disclaimer banner.
 *
 * ── The one rule that governs this file ──────────────────────────────────
 *
 * **This banner cannot be dismissed.**
 *
 * There is no close button, no dismiss state, no "hide" action, and no
 * "I understand" checkbox. PRD §3.A requires the disclaimer to be
 * visible during the chat session, and the spec (§5.4) makes it
 * non-disableable by design. A disclaimer a customer can scroll past and
 * forget is not a disclaimer — it is decoration.
 *
 * The most likely future "improvement" here is to add a close button,
 * because dismissible banners feel more polished. That change would
 * break a compliance requirement while looking like a UX win, so the
 * absence of any dismissal affordance is deliberate and should be
 * preserved.
 *
 * ── The version is shown ─────────────────────────────────────────────────
 *
 * The version number lets a support agent answer "which disclaimer was
 * this customer shown?" from the message's `meta.disclaimerVersion`. It
 * is deliberately visible rather than hidden in a tooltip.
 */
export type DisclaimerBannerProps = {
  readonly text: string;
  readonly version: number;
  readonly className?: string;
};

export function DisclaimerBanner({
  text,
  version,
  className,
}: DisclaimerBannerProps) {
  return (
    <aside
      // `role="note"` announces it as supplementary content without
      // stealing focus — it is information, not an alert.
      role="note"
      aria-label="Disclaimer"
      className={[
        "flex items-start gap-3 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="mt-0.5 shrink-0 text-brand-600">
        <InfoIcon width={18} height={18} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-xs leading-relaxed text-brand-900">{text}</p>

        <p className="mt-1 text-[11px] font-medium text-brand-700">
          Version {version}
        </p>
      </div>
    </aside>
  );
}
