"use client";

import { MoonIcon, SunIcon } from "@/components/ui/icons";
import { applyTheme, useTheme } from "@/lib/theme";

/**
 * The light/dark theme switch.
 *
 * ── Why the theme is read from a store, not from state ───────────────────
 *
 * The theme lives on the `<html>` element — the inline script in the
 * root layout put it there before the first paint, and the CSS keys off
 * it. So it is an **external fact**, and `useSyncExternalStore` is the
 * correct way to read it.
 *
 * The alternatives are both worse:
 *
 *   • `useState` + `useEffect` — renders "light" on the first paint
 *     and corrects itself afterwards, so a dark-mode visitor sees the
 *     wrong icon flash on every page load. The lint rule
 *     `react-hooks/set-state-in-effect` flags this for good reason.
 *
 *   • Reading `document` during render — the server would render
 *     "light" and the client "dark", which is a hydration mismatch.
 *
 * `useSyncExternalStore` resolves both: React renders the server
 * snapshot during hydration and the real value immediately after, with
 * no mismatch and no cascading render.
 */
export function ThemeToggle({ className }: { readonly className?: string }) {
  const theme = useTheme();

  function toggle() {
    // Apply first, then let the store notify. The class change is what
    // the user sees; the store update re-renders the icon.
    applyTheme(theme === "dark" ? "light" : "dark");
  }

  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={[
        "inline-flex h-10 w-10 items-center justify-center rounded-full",
        "text-foreground-muted transition-colors duration-200",
        "hover:bg-surface-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        "focus-visible:ring-offset-surface",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {theme === "dark" ? <SunIcon className="h-5 w-5" /> : <MoonIcon className="h-5 w-5" />}
    </button>
  );
}
