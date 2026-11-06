import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyTheme, readAppliedTheme, THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * The theme module's tests.
 *
 * The theme is a **browser** concern — it lives on the document's
 * class list and in `localStorage`. The test environment here is Node,
 * so the browser globals are stubbed. That is deliberate: the behaviour
 * worth proving is the *contract with the document*, and a stub makes
 * that contract explicit rather than incidental.
 *
 * The properties proved here:
 *
 *   1. The applied theme is read from the **document's class list** —
 *      the same thing the CSS keys off. A toggle that disagreed with
 *      the DOM would show one icon and render another.
 *   2. `colorScheme` is set alongside the class, so the browser's own
 *      scrollbars and form controls match the theme.
 *   3. A **failing `localStorage`** does not break the toggle. The
 *      theme still applies for this page view; it just is not
 *      remembered. A private-mode browser must still be able to switch
 *      themes.
 *   4. The storage key is the one the inline script in the root layout
 *      reads. If the two ever diverge, the toggle would apply a theme
 *      the next page load would not restore.
 */

/**
 * A minimal stand-in for the parts of `document` the theme touches.
 */
function stubDocument(): {
  classList: {
    add: (c: string) => void;
    remove: (c: string) => void;
    contains: (c: string) => boolean;
    toggle: (c: string, force?: boolean) => boolean;
  };
  style: { colorScheme: string };
  documentElement: unknown;
} {
  const classes = new Set<string>();

  const classList = {
    add: (c: string) => {
      classes.add(c);
    },
    remove: (c: string) => {
      classes.delete(c);
    },
    contains: (c: string) => classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const shouldHave = force ?? !classes.has(c);
      if (shouldHave) {
        classes.add(c);
      } else {
        classes.delete(c);
      }
      return shouldHave;
    },
  };

  const style = { colorScheme: "" };

  const documentElement = { classList, style };

  return { classList, style, documentElement };
}

let store: Map<string, string>;
let failStorage = false;

beforeEach(() => {
  store = new Map<string, string>();
  failStorage = false;

  const stub = stubDocument();

  vi.stubGlobal("document", stub);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => (failStorage ? null : (store.get(key) ?? null)),
      setItem: (key: string, value: string) => {
        if (failStorage) {
          // A browser with storage disabled throws rather than silently
          // ignoring the write.
          throw new Error("QuotaExceededError");
        }
        store.set(key, value);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the theme", () => {
  it("reads the applied theme from the document's class list", () => {
    // The document is the source of truth, because the CSS keys off
    // it. A toggle that tracked its own copy could disagree with what
    // is actually on screen.
    expect(readAppliedTheme()).toBe("light");

    document.documentElement.classList.add("dark");
    expect(readAppliedTheme()).toBe("dark");

    document.documentElement.classList.remove("dark");
    expect(readAppliedTheme()).toBe("light");
  });

  it("applies the dark theme by adding the class", () => {
    applyTheme("dark");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(readAppliedTheme()).toBe("dark");
  });

  it("applies the light theme by removing the class", () => {
    applyTheme("dark");
    applyTheme("light");

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(readAppliedTheme()).toBe("light");
  });

  it("sets the color scheme so the browser's own controls match", () => {
    // Without this, a dark page still renders a white scrollbar and
    // white form controls — the OS chrome would be the only light
    // thing on screen.
    applyTheme("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("persists the theme under the key the inline script reads", () => {
    // If this key and the one in the root layout's inline script ever
    // diverge, the toggle would apply a theme the next page load
    // would not restore.
    applyTheme("dark");

    expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(THEME_STORAGE_KEY).toBe("egb-theme");
  });

  it("still applies the theme when storage is unavailable", () => {
    // Private browsing and strict cookie policies can make
    // `setItem` throw. The theme must still work for this page view —
    // it just cannot be remembered. A toggle that throws here would
    // leave the visitor unable to change the theme at all.
    failStorage = true;

    expect(() => applyTheme("dark")).not.toThrow();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(readAppliedTheme()).toBe("dark");
  });
});
