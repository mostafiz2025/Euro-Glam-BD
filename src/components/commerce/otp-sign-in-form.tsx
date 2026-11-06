"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { OtpCodeField } from "@/components/commerce/otp-code-field";
import { Button } from "@/components/ui/button";
import { destinationAfterSignIn, safeNext } from "@/lib/auth/destination";

/**
 * The email one-time-password sign-in form.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The form has two steps, and the step is the state.**
 *
 * The customer gives an address, the shop mails a code, the customer
 * types the code. So the component holds the address it is working on
 * and whether the code has been requested — and nothing else. The
 * address is *not* re-read from the input when the code is verified,
 * because the input has been replaced by the code box by then and
 * reading it back would be reading a field that no longer exists.
 *
 * **2. The API envelope is checked before the data is read.**
 *
 * Every endpoint returns `{ ok: true, data }` or
 * `{ ok: false, error: { code, message } }`. Reading `data` without
 * checking `ok` first is the classic way to show `undefined` in the UI
 * and call it a success.
 *
 * **3. The code is never echoed back.**
 *
 * A code that has been typed and rejected is cleared, so the credential
 * is not left in the DOM. The same rule the password form follows.
 *
 * **4. An admin lands in the console.**
 *
 * The verification response carries the user's **role**, and that role
 * decides where the browser goes — the same rule the password form
 * follows, and the same helper (`destinationAfterSignIn`) applies it.
 */
export function OtpSignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Where to go after signing in. Only a *relative* path is honoured, so
  // the parameter cannot be used to redirect someone off-site.
  const next = safeNext(searchParams.get("next"));

  /**
   * Reads the error out of the standard envelope.
   */
  function readError(
    result: {
      ok: boolean;
      error?: {
        message?: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
    },
    fallback: string,
  ): string {
    setFieldErrors(
      Object.fromEntries(
        Object.entries(result.error?.details?.fieldErrors ?? {}).map(
          ([key, messages]) => [key, messages?.[0] ?? "This value is not valid."],
        ),
      ),
    );

    return result.error?.message ?? fallback;
  }

  /**
   * Requests a code for the address.
   */
  function requestCode(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const address = String(data.get("email") ?? "").trim();

    startTransition(async () => {
      setError(null);
      setFieldErrors({});
      setNotice(null);

      try {
        const response = await fetch("/api/auth/send-otp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: address, purpose: "SIGNIN" }),
        });

        const result = (await response.json()) as {
          ok: boolean;
          error?: { message?: string };
        };

        if (!result.ok) {
          setError(readError(result, "We could not send the code."));

          return;
        }

        setEmail(address);
        setStep("code");
        setNotice(
          `We sent a six-digit code to ${address}. It is valid for ten minutes.`,
        );
      } catch {
        setError("We could not reach the server. Please try again.");
      }
    });

    // The form element is captured before the transition starts, so the
    // reference survives the async boundary.
    void form;
  }

  /**
   * Verifies the code and signs the customer in.
   */
  function verifyCode(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);
    const code = String(data.get("code") ?? "");

    startTransition(async () => {
      setError(null);
      setFieldErrors({});

      try {
        const response = await fetch("/api/auth/verify-otp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code, purpose: "SIGNIN" }),
        });

        const result = (await response.json()) as {
          ok: boolean;
          data?: { user?: { id: string; email: string; role: string } };
          error?: { message?: string };
        };

        if (!result.ok) {
          setError(readError(result, "That code is not valid."));

          // Clear the code so a credential is not left in the DOM.
          const codeField = form.elements.namedItem("code");

          if (codeField instanceof HTMLInputElement) {
            codeField.value = "";
          }

          return;
        }

        /*
         * The session cookie is set by the response, so a plain
         * navigation picks it up.
         *
         * The role decides the destination — an admin belongs in the
         * console, and everybody else goes to `next`.
         */
        const role = result.data?.user?.role;
        const destination = destinationAfterSignIn(role, next);

        router.push(destination);
        router.refresh();
      } catch {
        setError("We could not reach the server. Please try again.");
      }
    });
  }

  if (step === "code") {
    return (
      <form onSubmit={verifyCode} noValidate className="space-y-4">
        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            {error}
          </div>
        ) : null}

        {notice ? (
          <div
            role="status"
            className="rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900"
          >
            {notice}
          </div>
        ) : null}

        <OtpCodeField error={fieldErrors.code} autoFocus />

        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          disabled={isPending}
        >
          {isPending ? "Signing in…" : "Sign in"}
        </Button>

        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setError(null);
              setNotice(null);
            }}
            className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
          >
            Use a different email
          </button>

          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              setStep("email");
              setError(null);
              setNotice(null);
            }}
            className="font-medium text-foreground-muted underline underline-offset-2 hover:text-foreground"
          >
            Send another code
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={requestCode} noValidate className="space-y-4">
      {error ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      ) : null}

      <Field
        id="email"
        label="Email"
        type="email"
        error={fieldErrors.email}
        autoComplete="email"
        required
      />

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        disabled={isPending}
      >
        {isPending ? "Sending the code…" : "Email me a sign-in code"}
      </Button>

      <p className="text-center text-xs text-foreground-muted">
        No password needed. We will mail you a six-digit code that is valid
        for ten minutes.
      </p>
    </form>
  );
}

/**
 * One labelled field.
 *
 * The error is wired to the input with `aria-describedby` and
 * `aria-invalid`, so a screen reader announces the problem when the
 * field takes focus rather than leaving the customer to hunt for it.
 */
function Field({
  id,
  label,
  type = "text",
  error,
  autoComplete,
  inputMode,
  pattern,
  maxLength,
  placeholder,
  required,
}: {
  readonly id: string;
  readonly label: string;
  readonly type?: string;
  readonly error?: string;
  readonly autoComplete?: string;
  readonly inputMode?: "numeric" | "text" | "tel" | "email" | "url" | "search";
  readonly pattern?: string;
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly required?: boolean;
}) {
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
        type={type}
        inputMode={inputMode}
        pattern={pattern}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
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
    </div>
  );
}
