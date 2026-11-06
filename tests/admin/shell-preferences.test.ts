import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_SHELL_PREFS_KEY,
  readAdminShellPrefs,
  writeAdminShellPrefs,
} from "@/lib/admin/shell-preferences";

/**
 * The admin shell's persisted preferences.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * `readAdminShellPrefs` is the `getSnapshot` of a `useSyncExternalStore`.
 * React compares consecutive snapshots with `Object.is` to decide
 * whether anything changed, and it **requires** that the snapshot be
 * referentially stable: two calls that report the same state must
 * return the same object.
 *
 * When it does not, the admin console cannot render at all:
 *
 *   > The result of getSnapshot should be cached to avoid an infinite loop
 *
 * followed by "Maximum update depth exceeded" once the loop runs away.
 * React re-renders, calls `getSnapshot` again, gets another fresh
 * object, sees a difference, and re-renders forever.
 *
 * So the tests below pin the **caching contract**:
 *
 *   1. The same stored value yields the **same object** — the property
 *      the infinite loop is made of.
 *   2. A **changed** stored value yields a **different** object — a
 *      cache that never invalidates would freeze the sidebar and be just
 *      as broken as one that never caches.
 *   3. The **values** are right: the collapse state round-trips.
 *   4. A malformed or missing entry falls back to the defaults without
 *      throwing, and the fallback is itself stable.
 */

/**
 * The fake storage backing the module.
 *
 * `localStorage` is installed on a fake `window`, because the module
 * reads `window.localStorage` and refuses to touch storage when there
 * is no window (that is the server-render path).
 */
let stored: string | null = null;

beforeEach(() => {
  stored = null;

  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => (key === ADMIN_SHELL_PREFS_KEY ? stored : null),
      setItem: (key: string, value: string) => {
        if (key === ADMIN_SHELL_PREFS_KEY) stored = value;
      },
      removeItem: (key: string) => {
        if (key === ADMIN_SHELL_PREFS_KEY) stored = null;
      },
      clear: () => {
        stored = null;
      },
      key: () => null,
      length: 0,
    },
  } as unknown as typeof globalThis.window;
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("the admin shell preferences", () => {
  describe("the snapshot is cached", () => {
    it("returns the SAME object for the same stored value", () => {
      // This is the property the infinite loop is made of. Without it,
      // React re-renders forever.
      const first = readAdminShellPrefs();
      const second = readAdminShellPrefs();

      expect(Object.is(first, second)).toBe(true);
    });

    it("returns the SAME object across many reads", () => {
      const snapshots = Array.from({ length: 50 }, () => readAdminShellPrefs());

      for (const snapshot of snapshots) {
        expect(Object.is(snapshot, snapshots[0])).toBe(true);
      }
    });

    it("returns a DIFFERENT object when the stored value changes", () => {
      const before = readAdminShellPrefs();

      stored = JSON.stringify({ collapsed: true });

      const after = readAdminShellPrefs();

      // A cache that never invalidates would freeze the sidebar — the
      // admin could never collapse it.
      expect(Object.is(before, after)).toBe(false);
    });

    it("reuses the object again once the value settles", () => {
      stored = JSON.stringify({ collapsed: true });

      const first = readAdminShellPrefs();
      const second = readAdminShellPrefs();

      expect(Object.is(first, second)).toBe(true);
    });

    it("does not rebuild the object when the value is written unchanged", () => {
      // Writing the same preferences the browser already holds must not
      // produce a new snapshot — otherwise every write would re-render
      // every subscriber for no reason.
      writeAdminShellPrefs({ collapsed: false });

      const before = readAdminShellPrefs();

      writeAdminShellPrefs({ collapsed: false });

      const after = readAdminShellPrefs();

      expect(Object.is(before, after)).toBe(true);
    });
  });

  describe("the values", () => {
    it("reads a collapsed preference", () => {
      stored = JSON.stringify({ collapsed: true });

      expect(readAdminShellPrefs().collapsed).toBe(true);
    });

    it("reads an expanded preference", () => {
      stored = JSON.stringify({ collapsed: false });

      expect(readAdminShellPrefs().collapsed).toBe(false);
    });

    it("round-trips a write", () => {
      writeAdminShellPrefs({ collapsed: true });

      expect(readAdminShellPrefs().collapsed).toBe(true);
    });

    it("treats a missing value as expanded", () => {
      expect(readAdminShellPrefs().collapsed).toBe(false);
    });

    it("treats a non-boolean `collapsed` as expanded", () => {
      // Only `true` means collapsed. A string "true" is not a boolean,
      // and reading it as collapsed would surprise the admin.
      stored = JSON.stringify({ collapsed: "true" });

      expect(readAdminShellPrefs().collapsed).toBe(false);
    });
  });

  describe("a malformed entry falls back to the defaults", () => {
    it("survives invalid JSON", () => {
      stored = "{ not json";

      expect(readAdminShellPrefs().collapsed).toBe(false);
    });

    it("survives a JSON array", () => {
      stored = "[1, 2, 3]";

      expect(readAdminShellPrefs().collapsed).toBe(false);
    });

    it("survives a JSON null", () => {
      stored = "null";

      expect(readAdminShellPrefs().collapsed).toBe(false);
    });

    it("survives a JSON string", () => {
      stored = '"collapsed"';

      expect(readAdminShellPrefs().collapsed).toBe(false);
    });

    it("keeps the fallback stable", () => {
      stored = "{ not json";

      const first = readAdminShellPrefs();
      const second = readAdminShellPrefs();

      // The fallback is a snapshot too, so it is cached like any other.
      expect(Object.is(first, second)).toBe(true);
    });
  });
});
