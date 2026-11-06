"use client";

import { useSyncExternalStore } from "react";

/**
 * The theme.
 *
 * ── Where the theme lives, and why ───────────────────────────────────────
 *
 * The theme is a **browser preference**, not session state. It is
 * stored in `localStorage` under `egb-theme` and applied by adding the
 * `.dark` class to the `<html>` element.
 *
 * It is deliberately **not** a cookie. A cookie would have to be read in
 * the root layout, which makes every route request-time and fails
 * `next build` (decision #46 — the root layout must not read the
 * session). A presentation preference does not belong in the session
 * anyway.
 *
 * The *initial* theme is applied by the inline script in the root
 * layout, before the first paint, so there is no flash. This module is
 * only responsible for reading the theme *after* that, and for writing
 * it when the user changes it.
 *
 * ── The hydration contract ──────────────────────────────────────────────
 *
 * The `<html>` element's React `className` never contains the theme.
 * The inline script owns that class, entirely. React renders
 * `class="…"` and the script has already set `class="… dark"` — so
 * React's rendered output does not match the DOM, and
 * `suppressHydrationWarning` on `<html>` tells React not to complain.
 *
 * A component that renders the *current* theme therefore has to read
 * it in a way that is hydration-safe. `useSyncExternalStore` is built
 * for exactly this: it gives React a server snapshot to render during
 * hydration and the real value immediately after, with no mismatch and
 * no cascading re-render.
 */

export type Theme = "light" | "dark";

/** The `localStorage` key. Shared with the inline script in the layout. */
export const THEME_STORAGE_KEY = "egb-theme";

/**
 * The listeners for the theme change.
 *
 * The theme is a document-level fact, so the store is a module-level
 * set of subscribers rather than anything React owns.
 */
const listeners = new Set<() => void>();

/**
 * Notifies every subscriber that the theme changed.
 */
function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Reads the applied theme from the document.
 *
 * The class on `<html>` is the source of truth — it is what the CSS
 * actually keys off. Reading it means the toggle can never disagree
 * with what is on screen.
 */
export function readAppliedTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * The server snapshot.
 *
 * During hydration React calls this to learn what the server rendered.
 * The server rendered the light theme, because the server cannot know
 * the browser's preference. So this returns `"light"` — and React
 * immediately re-renders with the real value on the client.
 */
function getServerSnapshot(): Theme {
  return "light";
}

/**
 * Subscribes to theme changes.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Applies a theme to the document and persists it.
 *
 * The `colorScheme` style is set alongside the class so that the
 * browser's own form controls, scrollbars and the mobile address bar
 * match the theme. Without it, a dark page still renders a white
 * scrollbar.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A browser with storage disabled (private mode, a strict
    // cookie policy) still gets the theme for this page view. It just
    // will not be remembered. A failed `setItem` must never break the
    // toggle.
  }

  emit();
}

/**
 * Returns the current theme, and re-renders when it changes.
 *
 * Uses `useSyncExternalStore` rather than `useState` + `useEffect`
 * because the theme is an **external fact** — it lives on the document,
 * not in React. Reading it with an effect would mean rendering the
 * wrong icon on the first paint and correcting it afterwards; the
 * store subscription renders the right one immediately.
 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readAppliedTheme, getServerSnapshot);
}

