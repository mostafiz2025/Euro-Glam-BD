"use client";

import { useState } from "react";

import { ThemeToggle } from "@/components/admin/shell/ThemeToggle";
import { Switch } from "@/components/ui/switch";

import {
  useAdminShellPrefs,
  writeAdminShellPrefs,
} from "@/lib/admin/shell-preferences";
import { applyTheme, useTheme } from "@/lib/theme";

/**
 * The administrator's display preferences.
 *
 * ── Why these live here, and not only in the top bar ──────────────────────
 *
 * The theme switch and the sidebar's collapse control are both in the
 * shell already, and both are *one gesture* controls — an admin flips
 * the theme and moves on. Having them here as well is not redundancy; it
 * is the difference between a control you can only reach if you happen to
 * remember where it is, and a **place you can look** to see what your
 * console is set to and change it.
 *
 * The theme in particular is a **preference**, and preferences belong on
 * the preferences page. The top bar's switch stays because it is the
 * quickest way to flip it — but an admin who lands on the settings page
 * to check what their console is set to should not have to go hunting
 * through the header for the answer.
 *
 * ── Why these are stored in the browser, and not on the account ───────────
 *
 * Both the theme and the sidebar's collapsed state live in
 * `localStorage`, and that is deliberate — see `src/lib/theme.ts` for the
 * theme's reasoning (a cookie would force every route to be request-time,
 * and a presentation preference does not belong in the session anyway).
 *
 * The consequence is that these settings follow the **browser**, not the
 * person. A different browser, or a different machine, gets the default.
 * That is the right trade for a presentation preference: it is a
 * property of the screen you are looking at, and tying it to an account
 * would mean the shop's own devices shared one layout.
 *
 * ── Why there is no "Save" button for the theme ───────────────────────────
 *
 * The theme applies the instant it is chosen. A switch that waited for a
 * save would show the admin one theme while the page used another, and
 * the whole point of the control is that the change is immediate — the
 * same reason the top bar's toggle has no confirmation step.
 *
 * The sidebar's collapsed state is the same: the layout changes in place.
 *
 * So this card has no submit button, and the card says so, rather than
 * showing a button that would do nothing.
 */
export function PreferencesSettingsForm() {
  const theme = useTheme();
  const prefs = useAdminShellPrefs();

  /*
   * A small confirmation, so the admin knows the change took. It is
   * ephemeral — the state that caused it is the truth, and the note
   * disappears on the next change.
   */
  const [note, setNote] = useState<string | null>(null);

  function setNextTheme(next: "light" | "dark") {
    applyTheme(next);
    setNote(
      next === "dark"
        ? "The dark theme is now applied to this browser."
        : "The light theme is now applied to this browser.",
    );
  }

  function setCollapsed(next: boolean) {
    writeAdminShellPrefs({ collapsed: next });
    setNote(
      next
        ? "The sidebar is now collapsed. It is remembered in this browser."
        : "The sidebar is now expanded. It is remembered in this browser.",
    );
  }

  return (
    <div className="space-y-6">
      {/* ── The theme ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Theme</p>

          <p className="mt-0.5 text-xs text-foreground-muted">
            Light or dark. Remembered in this browser, and applied straight
            away — there is nothing to save.
          </p>
        </div>

        {/*
          The two choices are **buttons**, not a radio group, because each
          one is the switch itself: clicking "Dark" makes the console
          dark. A radio group would need a separate Save, and a page
          that says "Dark" while rendering light would be worse than no
          control at all.
        */}
        <div
          role="group"
          aria-label="Theme"
          className="flex shrink-0 items-center gap-2"
        >
          <button
            type="button"
            onClick={() => setNextTheme("light")}
            aria-pressed={theme === "light"}
            className={[
              "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium",
              "transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
              "focus-visible:ring-offset-surface",
              theme === "light"
                ? "bg-surface text-foreground shadow-[var(--shadow-card)] ring-1 ring-border"
                : "text-foreground-muted hover:bg-surface hover:text-foreground",
            ].join(" ")}
          >
            Light
          </button>

          <button
            type="button"
            onClick={() => setNextTheme("dark")}
            aria-pressed={theme === "dark"}
            className={[
              "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium",
              "transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
              "focus-visible:ring-offset-surface",
              theme === "dark"
                ? "bg-surface text-foreground shadow-[var(--shadow-card)] ring-1 ring-border"
                : "text-foreground-muted hover:bg-surface hover:text-foreground",
            ].join(" ")}
          >
            Dark
          </button>

          {/*
            The quick toggle, beside the pair.

            It is the same action as the two buttons — it flips rather
            than choosing — so it is there for the admin who wants the
            other one without reading which is which.
          */}
          <ThemeToggle />
        </div>
      </div>

      {/* ── The sidebar ───────────────────────────────────────────── */}
      <div className="rounded-[var(--radius-card)] border border-border bg-surface-muted px-4 py-4">
        <Switch
          id="collapsedSidebar"
          checked={prefs.collapsed}
          onChange={setCollapsed}
          label="Collapse the sidebar"
          description="Show the navigation as icons with their labels underneath. Remembered in this browser."
        />
      </div>

      {note ? (
        <p
          role="status"
          className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3 text-sm text-foreground-muted"
        >
          {note}
        </p>
      ) : null}

      {/*
        The absence of a Save button, stated.

        A card whose controls apply instantly and which nonetheless ends
        with a "Save changes" button would teach the admin to expect a
        step that is not there. The note says what is actually true.
      */}
      <p className="text-xs text-foreground-muted">
        These preferences are remembered in this browser and apply
        immediately — there is nothing to save.
      </p>
    </div>
  );
}
