"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { AdminProfile } from "@/lib/admin/profile";

/**
 * The administrator's own profile form.
 *
 * ── What this form edits ─────────────────────────────────────────────────
 *
 * Two fields, and only two:
 *
 *   • The **display name** — the name shown in the top bar and recorded
 *     in every audit entry this admin writes.
 *   • The **telephone number** — how the shop reaches them.
 *
 * ── What it deliberately does not edit ────────────────────────────────────
 *
 * The **email address**, the **role**, and the **SMS consent** are all
 * shown, and all three are read-only. The reasoning is in
 * `src/lib/admin/profile.ts`, and the short version is:
 *
 *   • The email address is the account's **identity**, and the shop owns
 *     an email-verification flow that a self-service form would have to
 *     honour before the change could be trusted. It is shown so the admin
 *     can see which address they are signed in with — not so they can
 *     retype it.
 *
 *   • The role is a **privilege grant**, and a grant is somebody else's
 *     decision.
 *
 *   • The SMS consent is a decision about **being messaged**, not about
 *     what number to be messaged at.
 *
 * Showing a field as read-only, with the reason, is better than hiding
 * it. An admin who cannot find the email field assumes the shop has
 * hidden it; one who sees it greyed out with a note understands that it
 * is fixed and why.
 *
 * ── Why the form sends only what changed ─────────────────────────────────
 *
 * The same partial-update rule the announcement form follows. The admin
 * corrects a typo in the name; the phone number the form happened to be
 * holding is not sent, so it cannot be blanked by accident.
 */
export function ProfileSettingsForm({
  profile,
}: {
  readonly profile: AdminProfile;
}) {
  const router = useRouter();

  const [name, setName] = useState(profile.name);
  const [phone, setPhone] = useState(profile.phone ?? "");

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!hasChanges) return;

    const body: Record<string, unknown> = {};

    if (dirty.name) {
      body.name = name.trim();
    }

    if (dirty.phone) {
      // An empty number clears it — that is a real state, and the
      // service stores it as null.
      body.phone = phone.trim() === "" ? null : phone.trim();
    }

    setPending(true);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/settings/profile", {
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
          text:
            payload.error?.message ??
            "Your profile could not be saved. Please try again.",
        });
        return;
      }

      setDirty({});
      setMessage({
        tone: "good",
        text: "Your profile has been saved and recorded in the audit log.",
      });

      // The top bar shows the name, so the page has to be re-rendered
      // from the server for it to pick the new one up.
      router.refresh();
    } catch {
      setMessage({
        tone: "bad",
        text: "Your profile could not be saved. Please check your connection and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ── The name ──────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="profileName"
          className="block text-sm font-medium text-foreground"
        >
          Your name
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          Shown in the top bar, and recorded against every change you make
          in the audit log.
        </p>

        <div className="mt-2">
          <input
            id="profileName"
            type="text"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              markDirty("name");
            }}
            maxLength={160}
            autoComplete="name"
            placeholder="Ayesha Rahman"
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

      {/* ── The telephone number ──────────────────────────────────── */}
      <div>
        <label
          htmlFor="profilePhone"
          className="block text-sm font-medium text-foreground"
        >
          Your telephone number
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          How the shop reaches you. Leave empty and no number is on file.
        </p>

        <div className="mt-2">
          <input
            id="profilePhone"
            type="tel"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              markDirty("phone");
            }}
            maxLength={20}
            autoComplete="tel"
            placeholder="01819-000000"
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

      {/* ── The fixed fields ──────────────────────────────────────── */}
      <dl className="divide-y divide-border rounded-[var(--radius-card)] border border-border bg-surface-muted">
        <div className="px-4 py-3.5">
          <dt className="text-sm font-medium text-foreground">
            Email address
          </dt>

          <dd className="mt-1 text-xs text-foreground-muted">
            <span className="block break-all text-sm text-foreground">
              {profile.email}
            </span>

            {profile.emailVerifiedAt ? (
              <span className="mt-1 block">
                Verified. This address is where your sign-in details and
                password resets go, so it is the account&apos;s identity —
                ask another administrator to change it for you.
              </span>
            ) : (
              <span className="mt-1 block">
                Not yet verified. This address is where your sign-in
                details and password resets go, so it is the account&apos;s
                identity — ask another administrator to change it for you.
              </span>
            )}
          </dd>
        </div>

        <div className="px-4 py-3.5">
          <dt className="text-sm font-medium text-foreground">Role</dt>

          <dd className="mt-1 text-xs text-foreground-muted">
            <span className="block text-sm text-foreground">
              {profile.role === "ADMIN" ? "Administrator" : profile.role}
            </span>

            <span className="mt-1 block">
              A role change is a privilege grant, so it is made by another
              administrator on the Users page rather than by you here.
            </span>
          </dd>
        </div>

        <div className="px-4 py-3.5">
          <dt className="text-sm font-medium text-foreground">
            SMS reminders
          </dt>

          <dd className="mt-1 text-xs text-foreground-muted">
            <span className="block text-sm text-foreground">
              {profile.smsOptIn ? "Opted in" : "Opted out"}
            </span>

            <span className="mt-1 block">
              Whether the shop may text you about your own orders. That is
              a decision about being messaged rather than about which
              number to use, so it is not changed by editing your profile.
            </span>
          </dd>
        </div>
      </dl>

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
