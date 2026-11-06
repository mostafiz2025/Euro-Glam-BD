"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ColorField } from "@/components/admin/settings/ColorField";
import { ColorPresetPicker } from "@/components/admin/settings/ColorPresetPicker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import type { AdminSiteSettings } from "@/lib/admin/site-settings";
import {
  DEFAULT_MARQUEE_BG,
  DEFAULT_MARQUEE_TEXT,
  isLegiblePair,
  normalizeHexColor,
} from "@/lib/format/colors";

/**
 * The marquee settings form.
 *
 * ── Why the form sends only what changed ─────────────────────────────────
 *
 * This is a **partial** update, and the reason is the same one that
 * applies to the advisor configuration: the marquee has a **switch** and
 * a **text**, and the natural admin gesture is to flip the switch
 * without retyping the message. If the form sent the whole settings row
 * on every save, that gesture would also save whatever stale copy of
 * the text the form happened to be holding.
 *
 * The dirty-tracking is per-field for the same reason the advisor's is:
 * "I changed the switch but not the message" is a real state, and it
 * must not send the message.
 *
 * ── Why the switch is not saved on its own ────────────────────────────────
 *
 * Toggling the switch marks the form dirty but does not write anything.
 * The write happens on **Save**, with the text, in one request.
 *
 * The alternative — saving the switch the moment it is flipped — is
 * worse here, because the switch is exactly the control that can be
 * flipped *before* the announcement is written. An admin who types the
 * message and flips the switch would get the "you need some text"
 * refusal from the server, on a gesture that was not trying to publish
 * anything yet.
 *
 * ── The rules the client cannot enforce ───────────────────────────────────
 *
 * Two of them, and both are the server's to enforce:
 *
 *   1. The server refuses to switch the marquee **on** when there is no
 *      text to show — including text that was saved earlier but has
 *      since been cleared. The client cannot know what is stored, so it
 *      cannot enforce that rule; it can only show the server's message
 *      when the server refuses.
 *
 *   2. The server refuses a **ground and type pair** that is too faint
 *      to read. That check is about the *stored* pair — a request that
 *      changes only the ground changes the pair — so only the service
 *      can make it.
 *
 * So the client does two things the server cannot: it warns **before**
 * the save, when the admin is holding an empty message and a switch in
 * the on position, and it shows the pair's **contrast ratio live**, as
 * the admin chooses. Those are courtesies, not enforcement — the
 * enforcement is the server's, and the server is the authority.
 *
 * ── The colours are edited as a pair, and saved separately ───────────────
 *
 * The two colours are saved as two **separate** fields, because they
 * are two separate columns and the update is partial. But the presets
 * apply them **together**, because a ground and a type are only
 * legible as a unit.
 */
export function MarqueeSettingsForm({
  settings,
}: {
  readonly settings: AdminSiteSettings | null;
}) {
  const router = useRouter();

  const [isEnabled, setIsEnabled] = useState(settings?.isMarqueeEnabled ?? false);
  const [text, setText] = useState(settings?.marqueeText ?? "");
  const [href, setHref] = useState(settings?.marqueeHref ?? "");
  const [bgColor, setBgColor] = useState(
    settings?.marqueeBgColor ?? DEFAULT_MARQUEE_BG,
  );
  const [textColor, setTextColor] = useState(
    settings?.marqueeTextColor ?? DEFAULT_MARQUEE_TEXT,
  );

  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    readonly tone: "good" | "bad";
    readonly text: string;
  } | null>(null);

  const markDirty = (field: string): void => {
    setDirty((previous) => ({ ...previous, [field]: true }));
    setMessage(null);
  };

  const hasChanges = Object.values(dirty).some(Boolean);

  /*
   * The pre-flight warning.
   *
   * The server enforces this rule; this is the client saying it early,
   * while the admin is still looking at the form. It fires only when the
   * admin has actually asked for the marquee to be on **and** the
   * message in front of them is empty.
   */
  const wouldBeEmpty =
    isEnabled && (dirty.marqueeText ? text.trim() : (settings?.marqueeText ?? "").trim()) === "";

  /*
   * The pair the admin is looking at.
   *
   * The **saved** colour is used for the half the admin has not
   * touched, because that is the pair that would actually be in force
   * if they saved now.
   */
  const effectiveBackground =
    dirty.marqueeBgColor ? bgColor : (settings?.marqueeBgColor ?? DEFAULT_MARQUEE_BG);

  const effectiveTextColor =
    dirty.marqueeTextColor
      ? textColor
      : (settings?.marqueeTextColor ?? DEFAULT_MARQUEE_TEXT);

  /*
   * The legibility warning.
   *
   * It is only raised when **both** halves are real colours. A
   * half-typed hex is not a warning — it is a value the admin is still
   * in the middle of writing.
   */
  const colorsAreReal =
    normalizeHexColor(effectiveBackground) !== null &&
    normalizeHexColor(effectiveTextColor) !== null;

  const colorsAreFaint =
    colorsAreReal && !isLegiblePair(effectiveBackground, effectiveTextColor);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!hasChanges) return;

    const body: Record<string, unknown> = {};

    if (dirty.isMarqueeEnabled) {
      body.isMarqueeEnabled = isEnabled;
    }

    if (dirty.marqueeText) {
      body.marqueeText = text.trim();
    }

    if (dirty.marqueeHref) {
      // An empty link clears it — that is a real setting, and the
      // service stores it as null.
      body.marqueeHref = href.trim() === "" ? null : href.trim();
    }

    if (dirty.marqueeBgColor) {
      body.marqueeBgColor = bgColor;
    }

    if (dirty.marqueeTextColor) {
      body.marqueeTextColor = textColor;
    }

    setPending(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/settings/site-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        data?: unknown;
        error?: { message?: string };
      };

      if (!response.ok || !payload.ok) {
        setMessage({
          tone: "bad",
          // The server's message is the useful part — it names the
          // actual problem.
          text:
            payload.error?.message ??
            "The announcement could not be saved. Please try again.",
        });
        return;
      }

      setDirty({});
      setMessage({
        tone: "good",
        text: "The announcement has been saved and recorded in the audit log.",
      });

      router.refresh();
    } catch {
      setMessage({
        tone: "bad",
        text: "The announcement could not be saved. Please check your connection and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ── The switch ─────────────────────────────────────────────── */}
      <div className="rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-4">
        <Switch
          id="isMarqueeEnabled"
          checked={isEnabled}
          onChange={(next) => {
            setIsEnabled(next);
            markDirty("isMarqueeEnabled");
          }}
          label="Show the announcement bar"
          description="When on, a single line of your words scrolls across the top of every storefront page."
        />
      </div>

      {/* ── The message ────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="marqueeText"
          className="block text-sm font-medium text-foreground"
        >
          Announcement text
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          One scrolling line, up to 240 characters. This is the only
          sentence the shop gets to say unprompted, so it should be the
          one that matters this week.
        </p>

        <div className="mt-2">
          <textarea
            id="marqueeText"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              markDirty("marqueeText");
            }}
            rows={3}
            maxLength={240}
            placeholder="Complimentary delivery on orders over ৳2,000 — this weekend only."
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>

        <p className="mt-1.5 text-xs tabular-nums text-foreground-muted">
          {text.trim().length} / 240
        </p>
      </div>

      {/* ── The link ───────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="marqueeHref"
          className="block text-sm font-medium text-foreground"
        >
          Link (optional)
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          A path within the shop — for example{" "}
          <code className="font-mono text-[11px]">/category/skincare</code>.
          Leave empty and the announcement is plain text rather than a
          link.
        </p>

        <div className="mt-2">
          <input
            id="marqueeHref"
            value={href}
            onChange={(event) => {
              setHref(event.target.value);
              markDirty("marqueeHref");
            }}
            maxLength={255}
            placeholder="/category/skincare"
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

      {/* ── The colours ────────────────────────────────────────────── */}
      <div className="space-y-5 rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Colours</h3>

          <p className="mt-0.5 text-xs text-foreground-muted">
            The bar is the shop&apos;s own strip, so the shop paints it.
            Ink and white are the house style; rose is for a launch.
          </p>
        </div>

        <ColorPresetPicker
          background={effectiveBackground}
          text={effectiveTextColor}
          onApply={(background, foreground) => {
            setBgColor(background);
            setTextColor(foreground);
            markDirty("marqueeBgColor");
            markDirty("marqueeTextColor");
          }}
        />

        <ColorField
          id="marqueeBgColor"
          label="Background"
          description="The ground the announcement scrolls across."
          value={bgColor}
          onChange={(next) => {
            setBgColor(next);
            markDirty("marqueeBgColor");
          }}
          against={effectiveTextColor}
          warns={colorsAreFaint}
        />

        <ColorField
          id="marqueeTextColor"
          label="Text"
          description="The colour of the announcement's words."
          value={textColor}
          onChange={(next) => {
            setTextColor(next);
            markDirty("marqueeTextColor");
          }}
          against={effectiveBackground}
          warns={colorsAreFaint}
        />

        {colorsAreFaint ? (
          <p
            role="status"
            className="rounded-[var(--radius-card)] border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
          >
            That combination is too faint to read. The announcement is a
            thin strip of moving text, so it needs a contrast of at least
            4.5:1 — pick a darker background or a lighter text colour.
          </p>
        ) : null}
      </div>

      {/* ── The pre-flight warning ─────────────────────────────────── */}
      {wouldBeEmpty ? (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
        >
          The announcement needs some text before it can be switched on.
          Write the message first, or leave the switch off.
        </p>
      ) : null}

      {/* ── The feedback and the submit ─────────────────────────────── */}
      {message ? (
        <p
          role="status"
          className={[
            "rounded-[var(--radius-card)] border px-4 py-3 text-sm",
            message.tone === "good"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
          ].join(" ")}
        >
          {message.text}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!hasChanges || pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>

        {!hasChanges ? (
          <span className="text-xs text-foreground-muted">
            Nothing has changed yet.
          </span>
        ) : null}
      </div>
    </form>
  );
}
