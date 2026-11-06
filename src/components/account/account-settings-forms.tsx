"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";

/**
 * The customer's own settings forms.
 *
 * ── The rules that govern this file ──────────────────────────────────────
 *
 * **1. Every form patches; it never replaces.**
 *
 * The personal-details form sends only the fields the customer actually
 * touched. That is not a nicety — a form that sent the whole record
 * would blank the phone number every time somebody corrected a typo in
 * their name, because the empty input would be "the new value".
 *
 * **2. The forbidden fields are shown, not hidden.**
 *
 * The email address and the SMS reminders are on the page in a
 * read-only state, each with the reason it cannot be edited here. A
 * customer who cannot find the email field assumes the shop has hidden
 * it; one who sees it greyed out, with the reason, knows it is fixed and
 * why.
 *
 * **3. A field error is shown next to the field that caused it.**
 *
 * The API returns a `fieldErrors` map keyed by the field's path. The
 * message is placed under the input and wired up with `aria-describedby`,
 * so a screen reader announces the error with the field rather than
 * leaving it in a banner nobody is looking at.
 *
 * **4. The forms never write the password.**
 *
 * The password has its own form, its own route, and it asks for the
 * current password. Keeping it in a separate form means the customer is
 * never saving a password change they did not intend.
 */

/**
 * The shape the personal-details form needs.
 */
export type PersonalDetails = {
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly smsOptIn: boolean;
};

/**
 * The customer's personal details.
 */
export function PersonalDetailsForm({
  details,
}: {
  readonly details: PersonalDetails;
}) {
  const [name, setName] = useState(details.name);
  const [phone, setPhone] = useState(details.phone ?? "");

  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  /**
   * Which fields the customer actually changed.
   *
   * The comparison is against the values the page was rendered with, not
   * against the current state — so a customer who types something and
   * then types it back gets an empty patch and a clear "nothing to
   * save" rather than a write.
   */
  const dirty = {
    ...(name.trim() !== details.name ? { name: name.trim() } : {}),
    ...(phone.trim() !== (details.phone ?? "") ? { phone: phone.trim() } : {}),
  };

  const hasChanges = Object.keys(dirty).length > 0;

  async function save() {
    setState("saving");
    setMessage(null);
    setFieldErrors({});

    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dirty),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message: string; details?: { fieldErrors?: Record<string, string[]> } };
      };

      if (!payload.ok) {
        setState("error");
        setMessage(payload.error?.message ?? "That could not be saved.");
        setFieldErrors(payload.error?.details?.fieldErrors ?? {});
        return;
      }

      setState("saved");
      setMessage("Your details have been updated.");
    } catch {
      setState("error");
      setMessage("We could not reach the shop. Please try again.");
    }
  }

  return (
    <section aria-labelledby="personal-heading" className="space-y-5">
      <div>
        <h2
          id="personal-heading"
          className="text-base font-semibold text-foreground"
        >
          Your details
        </h2>

        <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
          The name on your orders and the number we call you about a
          delivery.
        </p>
      </div>

      {/* ── The name ───────────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="profileName"
          className="block text-xs font-semibold text-foreground-muted"
        >
          Full name
        </label>

        <input
          id="profileName"
          name="name"
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setState("idle");
          }}
          autoComplete="name"
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={
            fieldErrors.name ? "profileName-error" : undefined
          }
          className={[
            "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
            "transition-colors placeholder:text-foreground-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            fieldErrors.name
              ? "border-red-300 focus-visible:ring-red-400"
              : "border-border focus-visible:border-brand-400",
          ].join(" ")}
        />

        {fieldErrors.name ? (
          <p
            id="profileName-error"
            role="alert"
            className="mt-1.5 text-xs text-red-600"
          >
            {fieldErrors.name[0]}
          </p>
        ) : null}
      </div>

      {/* ── The phone ──────────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="profilePhone"
          className="block text-xs font-semibold text-foreground-muted"
        >
          Mobile number
        </label>

        <input
          id="profilePhone"
          name="phone"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => {
            setPhone(event.target.value);
            setState("idle");
          }}
          autoComplete="tel"
          placeholder="01712345678"
          aria-invalid={fieldErrors.phone ? true : undefined}
          aria-describedby={
            fieldErrors.phone ? "profilePhone-error" : "profilePhone-hint"
          }
          className={[
            "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
            "transition-colors placeholder:text-foreground-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
            fieldErrors.phone
              ? "border-red-300 focus-visible:ring-red-400"
              : "border-border focus-visible:border-brand-400",
          ].join(" ")}
        />

        {fieldErrors.phone ? (
          <p
            id="profilePhone-error"
            role="alert"
            className="mt-1.5 text-xs text-red-600"
          >
            {fieldErrors.phone[0]}
          </p>
        ) : (
          <p id="profilePhone-hint" className="mt-1.5 text-[11px] text-foreground-muted">
            Leave it empty if you would rather we did not call you.
          </p>
        )}
      </div>

      {/*
        The two fields that cannot be edited here.

        They are shown rather than hidden, and each carries the reason.
        A customer who cannot find the email field assumes the shop has
        hidden it; one who sees it greyed out, with the reason, knows it
        is fixed and why.
      */}
      <dl className="space-y-3 rounded-2xl border border-dashed border-border bg-surface-sunken/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-xs font-semibold text-foreground-muted">
            Email address
          </dt>

          <dd className="break-all text-sm font-medium text-foreground">
            {details.email}
          </dd>
        </div>

        <p className="text-[11px] leading-relaxed text-foreground-muted">
          Your email address is how you sign in and where your order
          confirmations go, so it is fixed. Please contact us and we will
          help you change it.
        </p>

        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-3">
          <dt className="text-xs font-semibold text-foreground-muted">
            Refill reminders
          </dt>

          <dd className="text-sm font-medium text-foreground">
            {details.smsOptIn ? "On" : "Off"}
          </dd>
        </div>

        <p className="text-[11px] leading-relaxed text-foreground-muted">
          Whether we may text you about a refill. That is a decision about
          being messaged, so it is set on your storefront account and not
          here.
        </p>
      </dl>

      {/* ── The save ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void save()}
          disabled={state === "saving" || !hasChanges}
        >
          {state === "saving" ? "Saving…" : "Save changes"}
        </Button>

        {state === "saved" && message ? (
          <p
            role="status"
            className="flex items-center gap-1.5 text-xs font-medium text-green-700"
          >
            <CheckIcon width={14} height={14} />
            {message}
          </p>
        ) : null}

        {state === "error" && message ? (
          <p role="alert" className="text-xs text-red-600">
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
