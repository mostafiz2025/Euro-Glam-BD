"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { OtpCodeField } from "@/components/commerce/otp-code-field";
import { Button } from "@/components/ui/button";
import { destinationAfterSignIn, safeNext } from "@/lib/auth/destination";

/**
 * The registration verification step.
 *
 * ── What this step is ─────────────────────────────────────────────────────
 *
 * The customer has submitted the registration form. The account exists,
 * but it is **unverified**: the shop has not yet proved it can reach
 * them. This component asks for the six-digit code that was mailed to
 * the address they registered with, and the code is what makes the
 * account usable.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The code is never echoed back.**
 *
 * A code that has been typed and rejected is cleared, so the credential
 * is not left in the DOM. The same rule the password form follows.
 *
 * **2. The address is held in state, not re-read from the input.**
 *
 * By this step the form's fields have been replaced by the code box, so
 * reading the email back from the form would be reading a field that no
 * longer exists. The address is captured when the registration is
 * submitted.
 *
 * **3. The API envelope is checked before the data is read.**
 *
 * Reading `data` without checking `ok` first is the classic way to show
 * `undefined` in the UI and call it a success.
 *
 * **4. The code can be requested again.**
 *
 * The code expires after ten minutes, and the mail server has a bad
 * minute sometimes. A customer who cannot get a new code is stuck, so
 * the button is right there.
 */
export function RegisterVerificationForm({
  email,
  verificationSent,
}: {
  readonly email: string;
  readonly verificationSent: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Where to go after the account is verified. Only a *relative* path is
  // honoured, so the parameter cannot be used to redirect someone
  // off-site.
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
          ([key, messages]) => [
            key,
            messages?.[0] ?? "This value is not valid.",
          ],
        ),
      ),
    );

    return result.error?.message ?? fallback;
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
          body: JSON.stringify({ email, code, purpose: "SIGNUP" }),
        });

        const result = (await response.json()) as {
          ok: boolean;
          data?: {
            user?: { id: string; email: string; role: string };
            firstVerification?: boolean;
          };
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

  /**
   * Asks for another code.
   *
   * The first code may have expired, or the mail may never have
   * arrived. The customer needs a way out that does not involve
   * creating a second account.
   */
  function resendCode(): void {
    startTransition(async () => {
      setError(null);
      setNotice(null);

      try {
        const response = await fetch("/api/auth/send-otp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, purpose: "SIGNUP" }),
        });

        const result = (await response.json()) as {
          ok: boolean;
          error?: { message?: string };
        };

        if (!result.ok) {
          setError(readError(result, "We could not send another code."));

          return;
        }

        setNotice(
          `We sent another six-digit code to ${email}. It is valid for ten minutes.`,
        );
      } catch {
        setError("We could not reach the server. Please try again.");
      }
    });
  }

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

      {!verificationSent ? (
        <div
          role="alert"
          className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          We could not send the verification email. Your account has been
          created — use the button below to send the code again.
        </div>
      ) : (
        <div className="rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
          We sent a six-digit code to <strong>{email}</strong>. Enter it
          below to finish setting up your account.
        </div>
      )}

      <OtpCodeField error={fieldErrors.code} autoFocus />

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        disabled={isPending}
      >
        {isPending ? "Verifying…" : "Verify my email"}
      </Button>

      <div className="flex items-center justify-between text-xs">
        <button
          type="button"
          onClick={resendCode}
          disabled={isPending}
          className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800 disabled:opacity-50"
        >
          Send another code
        </button>

        <button
          type="button"
          onClick={() => {
            setError(null);
            setNotice(null);
          }}
          className="font-medium text-foreground-muted underline underline-offset-2 hover:text-foreground"
        >
          Use a different email
        </button>
      </div>

      <p className="text-center text-xs text-foreground-muted">
        The code is valid for ten minutes and can be used once.
      </p>
    </form>
  );
}
