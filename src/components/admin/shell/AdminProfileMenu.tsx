"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { LogoutButton } from "@/components/admin/logout-button";
import { SettingsIcon, UserIcon } from "@/components/ui/icons";

/**
 * The administrator's profile menu.
 *
 * ── Why the settings live behind a menu, and not on the bar ───────────────
 *
 * The top bar is already carrying four things — the way back to the shop,
 * the notification bell, the theme switch and the way out. A fifth
 * labelled button makes it crowded on a laptop screen and impossible on a
 * phone.
 *
 * But the settings **cannot** live only in the sidebar either. The
 * sidebar is a *navigation* menu: it lists the sections of the admin
 * console. Settings is not a section in the same sense — it is the place
 * the admin goes for *their own* account and the shop's configuration,
 * and the top bar is where "my account" belongs. An admin on the orders
 * page who wants to fix their own phone number should not have to hunt
 * through the nav list for it.
 *
 * So the profile control sits in the **header**, where the admin's name
 * already is, and the settings link sits inside it.
 *
 * ── Why the name is the trigger ───────────────────────────────────────────
 *
 * The admin's name is already in the top bar, and it is the one thing
 * that identifies *who* is signed in. Turning it into the menu trigger
 * costs no vertical space — the name was there anyway — and it gives the
 * admin a familiar affordance: click your own name to get to your own
 * account.
 *
 * ── Why the menu closes on Escape and on a click outside ───────────────────
 *
 * A menu that traps the pointer is a menu the operator has to reload out
 * of. Three ways out — the keyboard's Escape, a click elsewhere, and
 * choosing an item — is the standard set, and all three are here.
 *
 * ── Why the trigger is a button, not a link ────────────────────────────────
 *
 * It *acts* — it opens a panel — rather than navigating. A link styled
 * as a button would go somewhere, and there is nowhere for it to go: the
 * menu's contents are the destinations.
 */
export function AdminProfileMenu({
  userName,
  userEmail,
}: {
  /** The signed-in administrator's name. */
  readonly userName: string;
  /** The signed-in administrator's email address. */
  readonly userEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const containerRef = useRef<HTMLDivElement>(null);

  /*
   * Close on Escape.
   *
   * The listener is only attached while the menu is open, so a closed
   * menu costs nothing.
   */
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  /*
   * Close on a click outside.
   *
   * The listener is on the **document**, so the check is "is the click
   * inside the menu container?". A click on the trigger itself is
   * outside the panel but inside the container, so it is ignored here and
   * handled by the trigger's own toggle.
   */
  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      const container = containerRef.current;
      if (!container) return;

      if (!container.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  /*
   * The settings page is the one page the admin should not have to reach
   * through a menu that is already open. So navigating to it closes the
   * menu — which the links' own `onClick` handlers do, rather than an
   * effect watching the pathname.
   *
   * The effect would have been the obvious way to write it, and it would
   * have been worse: calling `setState` synchronously inside an effect
   * triggers a cascading render, and the lint rule
   * `react-hooks/set-state-in-effect` flags it for good reason. The
   * pathname is not a thing to *react* to here — it is a thing to *read*
   * to decide which entry is highlighted.
   */
  const settingsActive =
    pathname === "/admin/settings" || pathname.startsWith("/admin/settings/");

  /*
   * The initials for the avatar.
   *
   * Two letters, taken from the first and last word of the name — so
   * "Ayesha Rahman" reads "AR" rather than "A" or "Ay". A single letter
   * is a poor identifier in a list of admins, and the full name in a
   * circle is unreadable at this size.
   *
   * The fallbacks matter because an admin's name is free text: it may be
   * one word, and it may begin with whitespace.
   */
  const initials = userName
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${userName}`}
        className={[
          "inline-flex h-10 items-center gap-2 rounded-full pl-1 pr-2 sm:pr-3",
          "transition-colors duration-200",
          "hover:bg-surface-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
          "focus-visible:ring-offset-surface",
        ].join(" ")}
      >
        {/*
          The avatar.

          It replaces the bare name on a narrow screen, where the bar has
          no room for both. The name is still in the accessible name of
          the button, so nothing is lost to a screen reader.
        */}
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[11px] font-bold text-white"
        >
          {initials || "A"}
        </span>

        {/*
          The name. Hidden on the narrowest screens, where the avatar
          alone carries it.
        */}
        <span className="hidden max-w-[10rem] truncate text-sm text-foreground-muted sm:inline">
          {userName}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className={[
            "absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-[var(--radius-card)]",
            "border border-border bg-surface shadow-lift",
          ].join(" ")}
        >
          {/*
            The identity block.

            It says who is signed in — the name and the address the
            account was created with. The email is shown **read-only**:
            it is the account's identity, and the profile form does not
            change it, so showing it here sets the expectation that it is
            fixed rather than inviting a hunt for the field.
          */}
          <div className="border-b border-border px-4 py-3">
            <p className="truncate text-sm font-medium text-foreground">
              {userName}
            </p>

            <p className="mt-0.5 truncate text-xs text-foreground-muted">
              {userEmail}
            </p>
          </div>

          {/*
            The settings link.

            A **link**, because it navigates. It is marked with
            `aria-current` when the settings page is the one being shown,
            so the menu says where the admin already is.
          */}
          <Link
            href="/admin/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            aria-current={settingsActive ? "page" : undefined}
            className={[
              "flex items-center gap-3 px-4 py-2.5 text-sm",
              "transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
              settingsActive
                ? "bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"
                : "text-foreground-muted hover:bg-surface-muted hover:text-foreground",
            ].join(" ")}
          >
            <SettingsIcon className="h-4 w-4" />

            <span>Settings</span>
          </Link>

          {/*
            The account link.

            It goes to the same page's **profile** section, which is the
            one part of the settings that is about the admin rather than
            about the shop. It is a separate entry so the two ideas —
            "my details" and "the shop's configuration" — are both one
            click away, rather than making the admin open the settings
            and then scroll to find their own name.
          */}
          <Link
            href="/admin/settings#profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={[
              "flex items-center gap-3 px-4 py-2.5 text-sm",
              "text-foreground-muted transition-colors duration-200",
              "hover:bg-surface-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500",
            ].join(" ")}
          >
            <UserIcon className="h-4 w-4" />

            <span>My profile</span>
          </Link>

          {/*
            The way out.

            The logout is a **button** inside the menu, not a link: it
            runs an action rather than navigating. The `LogoutButton`
            component renders its own label, so the row is built around
            it rather than the other way round.
          */}
          <div className="border-t border-border px-4 py-3">
            <LogoutButton className="w-full justify-center" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
