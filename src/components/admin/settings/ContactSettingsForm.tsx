"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import type { AdminSiteSettings } from "@/lib/admin/site-settings";

/**
 * The contact-details form.
 *
 * ── What this form edits ─────────────────────────────────────────────────
 *
 * The four facts a customer needs in order to reach the shop:
 *
 *   • The **support email** — the mailbox their question goes to.
 *   • The **support telephone** — the number they can ring.
 *   • The **opening hours** — when anyone will answer.
 *   • The **store address** — where the counter is.
 *
 * They used to be strings in the footer component. That made them wrong
 * the moment the shop's mailbox changed, and they are the details a
 * customer calls or writes to when they have paid for something they
 * cannot see — so being wrong about them is not a cosmetic problem.
 *
 * ── Why every field may be empty ─────────────────────────────────────────
 *
 * A field that is empty means **the footer does not show that line**.
 *
 * It does not mean "show an empty line", and it does not mean "show a
 * placeholder". A shop that has not told us its opening hours gets no
 * hours line; a shop with no counter gets no address.
 *
 * The alternative — a placeholder like "Opening hours: —" — makes the
 * footer look broken and makes the shop look like nobody answers. The
 * absence of a line is honest; a placeholder is not.
 *
 * ── Why the address is one field ─────────────────────────────────────────
 *
 * A store address is an address, and addresses are not a set of
 * structured parts that every shop fills in the same way. Some shops
 * have a floor and a unit; some have a landmark and a floor; some have
 * two lines and a landmark. So the field is free text, and the shop
 * breaks it into lines however they like.
 *
 * ── Why the phone is a display string ─────────────────────────────────────
 *
 * The shop writes its number the way it reads it — "01819-000000",
 * "+880 1819-000000". The footer's `tel:` link is built from the
 * digits alone, so the display can be pretty and the link still
 * dials.
 */
export function ContactSettingsForm({
  settings,
}: {
  readonly settings: AdminSiteSettings | null;
}) {
  const router = useRouter();

  const [email, setEmail] = useState(settings?.supportEmail ?? "");
  const [phone, setPhone] = useState(settings?.supportPhone ?? "");
  const [hours, setHours] = useState(settings?.supportHours ?? "");
  const [address, setAddress] = useState(settings?.storeAddress ?? "");

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

    if (dirty.supportEmail) {
      body.supportEmail = email.trim();
    }

    if (dirty.supportPhone) {
      body.supportPhone = phone.trim();
    }

    if (dirty.supportHours) {
      body.supportHours = hours.trim();
    }

    if (dirty.storeAddress) {
      body.storeAddress = address.trim();
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
          text:
            payload.error?.message ??
            "The contact details could not be saved. Please try again.",
        });
        return;
      }

      setDirty({});
      setMessage({
        tone: "good",
        text: "The contact details have been saved and recorded in the audit log.",
      });

      router.refresh();
    } catch {
      setMessage({
        tone: "bad",
        text: "The contact details could not be saved. Please check your connection and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label
          htmlFor="supportEmail"
          className="block text-sm font-medium text-foreground"
        >
          Support email
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          Where a customer&apos;s questions go. Leave empty and the footer
          shows no email line.
        </p>

        <div className="mt-2">
          <input
            id="supportEmail"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              markDirty("supportEmail");
            }}
            maxLength={255}
            placeholder="hello@euroglam.bd"
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="supportPhone"
          className="block text-sm font-medium text-foreground"
        >
          Support telephone
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          Written the way your customers should read it — the link behind
          it dials the digits either way.
        </p>

        <div className="mt-2">
          <input
            id="supportPhone"
            type="tel"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              markDirty("supportPhone");
            }}
            maxLength={40}
            placeholder="01819-000000"
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="supportHours"
          className="block text-sm font-medium text-foreground"
        >
          Opening hours
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          A sentence, in your own words — “Saturday to Thursday, 10am–8pm”.
        </p>

        <div className="mt-2">
          <input
            id="supportHours"
            value={hours}
            onChange={(event) => {
              setHours(event.target.value);
              markDirty("supportHours");
            }}
            maxLength={120}
            placeholder="Mon–Sat, 9am–8pm"
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="storeAddress"
          className="block text-sm font-medium text-foreground"
        >
          Store address
        </label>

        <p className="mt-0.5 text-xs text-foreground-muted">
          Where your counter is. Break it into lines however you like — the
          footer keeps your line breaks.
        </p>

        <div className="mt-2">
          <textarea
            id="storeAddress"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              markDirty("storeAddress");
            }}
            rows={3}
            maxLength={400}
            placeholder={"House 12, Road 5\nDhanmondi, Dhaka 1209"}
            className="w-full rounded-[var(--radius-card)] border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
        </div>
      </div>

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
