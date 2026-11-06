"use client";

/**
 * The six-digit code input.
 *
 * ── Why this is its own component ─────────────────────────────────────────
 *
 * Two flows need it — the sign-in code and the registration
 * verification — and they need it to behave **identically**. A code box
 * that accepted spaces in one flow and not the other would be a
 * difference the customer has to learn rather than a difference they
 * never notice.
 *
 * So the behaviour lives here, once:
 *
 *   • `inputMode="numeric"` — the phone keyboard on a mobile device,
 *     which has no letters on it. Without this the customer is shown a
 *     full keyboard and has to find the number row.
 *
 *   • `pattern="[0-9]{6}"` — the browser's own check, which fires before
 *     the form is submitted. It is a convenience, not the authority; the
 *     server validates the code again.
 *
 *   • `autoComplete="one-time-code"` — the platform's autofill for SMS
 *     and email codes, which on iOS and Android can fill the field
 *     straight out of the notification.
 *
 *   • `maxLength={6}` — the code is six digits, and a field that
 *     accepts more only lets the customer type a mistake.
 *
 * The label, the error and the `aria-*` wiring are here too, so the
 * error is announced when the field takes focus rather than leaving the
 * customer to hunt for it.
 */

/**
 * The props for the code field.
 */
export type OtpCodeFieldProps = {
  readonly id?: string;
  readonly label?: string;
  readonly error?: string;
  readonly autoFocus?: boolean;
};

export function OtpCodeField({
  id = "code",
  label = "Six-digit code",
  error,
  autoFocus = false,
}: OtpCodeFieldProps) {
  const errorId = `${id}-error`;

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
        type="text"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        placeholder="123456"
        autoComplete="one-time-code"
        autoFocus={autoFocus}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={[
          "mt-1.5 h-11 w-full rounded-xl border bg-surface px-3.5 text-sm text-foreground",
          "tracking-[0.4em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
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
    </div>
  );
}
