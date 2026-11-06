"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CheckIcon } from "@/components/ui/icons";

/**
 * The change-password form.
 *
 * ── Why the current password is asked for ─────────────────────────────────
 *
 * A password change that does not ask for the current password lets
 * anybody who walks up to an unlocked device change the password and
 * lock the real owner out. The current password is the proof that the
 * person making the request is the person who owns the account — and it
 * is what stops a shared shop counter or a family laptop from being a
 * permanent takeover.
 *
 * ── Why it is its own form ────────────────────────────────────────────────
 *
 * The personal details and the password do not save together. If they
 * did, a form holding all of them would be a form that could save a
 * password change the customer never asked for — and a customer who
 * edited their name would, without noticing, be running a password
 * change they had not confirmed.
 *
 * ── The rules the fields enforce ──────────────────────────────────────────
 *
 *   • The new password must be at least 8 characters.
 *   • The two new-password fields must match.
 *   • The new password must differ from the current one.
 *
 * The last two are checked by the **server**, not only here. The client
 * check is a courtesy that saves a round trip; the server check is the
 * rule.
 */
export function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const mismatch =
    confirmPassword.length > 0 && confirmPassword !== newPassword;

  async function save() {
    setState("saving");
    setMessage(null);
    setFieldErrors({});

    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        error?: {
          message: string;
          details?: { fieldErrors?: Record<string, string[]> };
        };
      };

      if (!payload.ok) {
        setState("error");
        setMessage(payload.error?.message ?? "That could not be saved.");
        setFieldErrors(payload.error?.details?.fieldErrors ?? {});
        return;
      }

      // The form is cleared, so the new password is not left sitting in
      // a field on a screen somebody may walk away from.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");

      setState("saved");
      setMessage("Your password has been changed.");
    } catch {
      setState("error");
      setMessage("We could not reach the shop. Please try again.");
    }
  }

  return (
    <section aria-labelledby="password-heading" className="space-y-5">
      <div>
        <h2
          id="password-heading"
          className="text-base font-semibold text-foreground"
        >
          Password
        </h2>

        <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
          Choose something you have not used here before. A short
          passphrase is stronger than a short complicated word.
        </p>
      </div>

      <PasswordField
        id="currentPassword"
        label="Current password"
        value={currentPassword}
        onChange={setCurrentPassword}
        error={fieldErrors.currentPassword?.[0]}
        autoComplete="current-password"
      />

      <PasswordField
        id="newPassword"
        label="New password"
        value={newPassword}
        onChange={setNewPassword}
        error={fieldErrors.newPassword?.[0]}
        autoComplete="new-password"
        hint="At least 8 characters."
      />

      <PasswordField
        id="confirmPassword"
        label="Confirm new password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        error={
          fieldErrors.confirmPassword?.[0] ??
          (mismatch ? "The two passwords do not match." : undefined)
        }
        autoComplete="new-password"
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void save()}
          disabled={
            state === "saving" ||
            currentPassword.length === 0 ||
            newPassword.length === 0 ||
            confirmPassword.length === 0 ||
            mismatch
          }
        >
          {state === "saving" ? "Changing…" : "Change password"}
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

/**
 * One labelled password field.
 */
function PasswordField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  autoComplete,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error?: string;
  readonly hint?: string;
  readonly autoComplete?: string;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-semibold text-foreground-muted"
      >
        {label}
      </label>

      <input
        id={id}
        name={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={[
          "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
          "transition-colors placeholder:text-foreground-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          error
            ? "border-red-300 focus-visible:ring-red-400"
            : "border-border focus-visible:border-brand-400",
        ].join(" ")}
      />

      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : null}

      {hint ? (
        <p id={hintId} className="mt-1.5 text-[11px] text-foreground-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
