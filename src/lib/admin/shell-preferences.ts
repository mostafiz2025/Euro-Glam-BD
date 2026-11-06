"use client";

import { useSyncExternalStore } from "react";

/**
 * The admin shell's persisted preferences.
 *
 * ── Why this is a store and not `useState` + `useEffect` ──────────────────
 *
 * The sidebar's collapsed state is an **external fact**: it lives in
 * `localStorage`, and the browser is the only thing that knows it. The
 * server has no access, so it cannot render the correct initial state.
 *
 * The obvious approach — `useState` with a `useEffect` that reads
 * `localStorage` on mount — renders the expanded rail first and then
 * corrects it. That is a visible layout shift on every page load, and
 * the lint rule `react-hooks/set-state-in-effect` flags it for exactly
 * that reason.
 *
 * `useSyncExternalStore` is the correct primitive: React renders the
 * server snapshot during hydration and the real value immediately
 * after, with no mismatch and no cascading render.
 *
 * ── Why a single shared key ──────────────────────────────────────────────
 *
 * The preferences live under one key as a JSON object rather than as
 * several separate keys. One `setItem` writes them atomically, so a
 * half-written state is impossible, and there is one place to look when
 * asking "what does this browser remember?".
 *
 * ── The one invariant this module must not break ─────────────────────────
 *
 * **`readAdminShellPrefs` must return the SAME object for the same
 * stored value.**
 *
 * It is the `getSnapshot` of a `useSyncExternalStore`, and React
 * compares consecutive snapshots with `Object.is` to decide whether
 * anything changed. A snapshot that is rebuilt on every call — even
 * when its *contents* are identical — looks like a change every time,
 * so React re-renders, calls `getSnapshot` again, and gets another
 * "different" object. That loop is the crash:
 *
 * > The result of getSnapshot should be cached to avoid an infinite loop
 *
 * followed by "Maximum update depth exceeded" when the loop runs away.
 *
 * So the parsed value is memoised against the raw stored text, and the
 * same reference is handed back until the stored value genuinely
 * changes. See `readAdminShellPrefs` for the detail.
 */

/** The `localStorage` key holding the admin shell's preferences. */
export const ADMIN_SHELL_PREFS_KEY = "egb-admin-shell";

export type AdminShellPrefs = {
  /** Whether the desktop rail is collapsed to icons only. */
  readonly collapsed: boolean;
};

const DEFAULT_PREFS: AdminShellPrefs = { collapsed: false };

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads the preferences from storage.
 *
 * A malformed or partial stored value falls back to the defaults
 * rather than throwing. Storage is user-writable — a corrupted entry
 * must not break the admin console.
 *
 * ── Why the result is CACHED ──────────────────────────────────────────────
 *
 * This function is the `getSnapshot` of a `useSyncExternalStore`, and
 * React requires that function to be **referentially stable**: two calls
 * that report the same state must return the *same object*.
 *
 * React compares the new snapshot with the previous one using
 * `Object.is`. If every call builds a fresh object literal, the
 * comparison always says "the state changed", so React re-renders — and
 * the re-render calls `getSnapshot` again, which returns another fresh
 * object, which says "changed" again. The result is an infinite loop,
 * which React reports as:
 *
 * > The result of getSnapshot should be cached to avoid an infinite loop
 *
 * and, when the loop runs away, as "Maximum update depth exceeded" —
 * which crashes the whole admin console.
 *
 * So the parsed value is **memoised**: the object is rebuilt only when
 * the stored value actually changes, and the same reference is handed
 * back on every other call.
 */
export function readAdminShellPrefs(): AdminShellPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;

  let raw: string | null;

  try {
    raw = window.localStorage.getItem(ADMIN_SHELL_PREFS_KEY);
  } catch {
    // Storage disabled (private browsing, a strict policy). The
    // preferences still work for this page view; they just are not
    // remembered. A read failure must never break the sidebar.
    return DEFAULT_PREFS;
  }

  /*
   * The raw string is the cache key.
   *
   * Comparing the raw text rather than the parsed object is what makes
   * the memo correct: it is the *stored bytes* that decide whether
   * anything changed, and it is cheap to compare. Re-parsing on every
   * call and comparing the results field-by-field would work too, but it
   * would do the work on every render to achieve the same result.
   */
  if (raw === cachedRaw) {
    return cachedPrefs;
  }

  cachedRaw = raw;

  cachedPrefs = parsePrefs(raw);

  return cachedPrefs;
}

/**
 * Parses a stored preferences value.
 *
 * Separated from `readAdminShellPrefs` so the memo can be updated in one
 * place, and so the parsing rules are stated once.
 */
function parsePrefs(raw: string | null): AdminShellPrefs {
  if (!raw) return DEFAULT_PREFS;

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;

    const record = parsed as Record<string, unknown>;

    return {
      collapsed: record.collapsed === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * The raw text the cached snapshot was built from.
 *
 * `null` means "nothing has been read yet", which is deliberately
 * different from the empty string — an empty string is a stored (and
 * malformed) value, and it must still invalidate the cache.
 */
let cachedRaw: string | null | undefined = undefined;

/**
 * The snapshot the cache currently holds.
 */
let cachedPrefs: AdminShellPrefs = DEFAULT_PREFS;

/**
 * The server snapshot.
 *
 * The server has no access to storage, so it renders the defaults.
 *
 * It returns the **same** `DEFAULT_PREFS` object every time, which is
 * what `useSyncExternalStore` requires of a server snapshot for the
 * same reason the client snapshot is cached: React compares snapshots
 * with `Object.is`, and a fresh object each time would look like a
 * change on every render.
 */
function getServerSnapshot(): AdminShellPrefs {
  return DEFAULT_PREFS;
}

/**
 * Writes the preferences and notifies the subscribers.
 */
export function writeAdminShellPrefs(next: AdminShellPrefs): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(ADMIN_SHELL_PREFS_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled (private browsing, a strict policy). The change
    // still applies for this page view; it just is not remembered. A
    // failed write must never break the sidebar.
  }

  emit();
}

/**
 * Returns the admin shell's persisted preferences, and re-renders when
 * they change.
 */
export function useAdminShellPrefs(): AdminShellPrefs {
  return useSyncExternalStore(subscribe, readAdminShellPrefs, getServerSnapshot);
}
