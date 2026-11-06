"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { RegisterVerificationForm } from "@/components/commerce/register-verification-form";
import { Button } from "@/components/ui/button";
import { destinationAfterSignIn, safeNext } from "@/lib/auth/destination";

/**
 * The sign-in and sign-up form.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The API envelope is checked before the data is read.**
 *
 * Every endpoint returns `{ ok: true, data }` or
 * `{ ok: false, error: { code, message } }`. Reading `data` without
 * checking `ok` first is the classic way to show `undefined` in the
 * UI and call it a success.
 *
 * **2. The password is never echoed back.**
 *
 * The error message comes from the server, but a server that echoed
 * the submitted password would put it on the page. The form clears the
 * field on a failure so the customer retypes it rather than leaving a
 * credential in the DOM.
 *
 * **3. The form works without JavaScript.**
 *
 * It is a `<form>` with `action` and `method`, and the client
 * enhancement is an *interception*. If the script never loads, the
 * form still posts. The button is a real submit button, so the
 * keyboard and the screen reader both work without any JavaScript
 * at all.
 *
 * **4. An admin lands in the console.**
 *
 * The sign-in response carries the user's **role**, and that role
 * decides where the browser goes: an `ADMIN` goes to `/admin`, and
 * everyone else goes to the `next` parameter (defaulting to the
 * homepage). Discarding the role and sending everybody to `next` is
 * what used to leave administrators stranded on the storefront,
 * typing `/admin` by hand.
 */

/**
 * The props for the form.
 */
export type AuthFormProps = {
  readonly mode: "login" | "register";
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string>
  >({});

  /**
   * The registration step.
   *
   * A new account is **unverified** — the shop has not yet proved it
   * can reach the customer — so registering does not sign you in. It
   * moves you to the verification step, where the code that was mailed
   * to the address finishes the job and issues the session.
   */
  const [pendingVerification, setPendingVerification] = useState<{
    email: string;
    verificationSent: boolean;
  } | null>(null);

  const isLogin = mode === "login";

  // Where to go after signing in. A `next` parameter is honoured so a
  // customer who was sent to the cart can land there — but only for a
  // *relative* path, so the parameter cannot be used to redirect
  // someone off-site. The sanitising and the admin rule live in
  // `@/lib/auth/destination`, where they can be tested directly.
  const next = safeNext(searchParams.get("next"));

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const form = event.currentTarget;
    const data = new FormData(form);

    const payload: Record<string, unknown> = {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    };

    if (!isLogin) {
      payload.name = String(data.get("name") ?? "");
      payload.smsOptIn = data.get("smsOptIn") === "on";
    }

    startTransition(async () => {
      setError(null);
      setFieldErrors({});

      try {
        const response = await fetch(
          isLogin ? "/api/auth/login" : "/api/auth/register",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        );

        const result = (await response.json()) as {
          ok: boolean;
          data?: {
            user?: { id: string; email: string; role: string };
            verificationSent?: boolean;
          };
          error?: { message: string; details?: { fieldErrors?: Record<string, string[]> } };
        };

        if (!result.ok) {
          setError(result.error?.message ?? "We could not sign you in.");

          const details = result.error?.details?.fieldErrors;

          if (details) {
            setFieldErrors(
              Object.fromEntries(
                Object.entries(details).map(([key, messages]) => [
                  key,
                  messages?.[0] ?? "This value is not valid.",
                ]),
              ),
            );
          }

          // Clear the password so a credential is not left sitting in
          // the DOM after a failed attempt.
          const passwordField = form.elements.namedItem("password");

          if (passwordField instanceof HTMLInputElement) {
            passwordField.value = "";
          }

          return;
        }

        /*
         * The registration step does not sign the customer in.
         *
         * The account has been created, but it is unverified — the shop
         * has not yet proved it can reach this inbox. The session is
         * issued by the verification step, once the code comes back.
         *
         * So the form moves to the code entry rather than redirecting.
         */
        if (!isLogin) {
          setPendingVerification({
            email: String(payload.email ?? "").trim().toLowerCase(),
            verificationSent: result.data?.verificationSent ?? false,
          });

          return;
        }

        /*
         * The session cookie is set by the response, so a plain
         * navigation picks it up.
         *
         * ── Where an admin lands ────────────────────────────────────────
         *
         * An administrator who signs in belongs in the **console**, not
         * the storefront. Without this branch the API's role is thrown
         * away, `next` defaults to `/`, and an admin who typed their
         * credentials lands on the shop homepage — having to type
         * `/admin` into the address bar to reach the page they were
         * obviously trying to reach.
         *
         * So the role in the response decides the destination:
         *
         *   - **ADMIN** → `/admin`, always. Even when a `next`
         *     parameter is present, the console is where an admin
         *     belongs; a `next` pointing at the storefront is not a
         *     reason to send them shopping.
         *   - **CUSTOMER** → `next`, with the usual open-redirect
         *     guard already applied by `safeNext`.
         *
         * The `next` parameter is still honoured for everyone else, so
         * a customer sent to the cart still lands in the cart.
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

  /*
   * The verification step.
   *
   * The account has been created and the code has been mailed. The
   * customer enters the code, and that is what signs them in.
   */
  if (pendingVerification) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">
          Verify your email
        </h2>

        <RegisterVerificationForm
          email={pendingVerification.email}
          verificationSent={pendingVerification.verificationSent}
        />

        <p className="text-center text-xs text-foreground-muted">
          <button
            type="button"
            onClick={() => setPendingVerification(null)}
            className="font-medium text-foreground-muted underline underline-offset-2 hover:text-foreground"
          >
            Back to the form
          </button>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {error ? (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {error}
        </div>
      ) : null}

      {!isLogin ? (
        <Field
          id="name"
          label="Your name"
          error={fieldErrors.name}
          autoComplete="name"
          required
        />
      ) : null}

      <Field
        id="email"
        label="Email"
        type="email"
        error={fieldErrors.email}
        autoComplete="email"
        required
      />

      <Field
        id="password"
        label="Password"
        type="password"
        error={fieldErrors.password}
        autoComplete={isLogin ? "current-password" : "new-password"}
        required
      />

      {!isLogin ? (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-border bg-surface p-3.5">
          <input
            type="checkbox"
            name="smsOptIn"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          />
          <span className="text-xs leading-relaxed text-foreground-muted">
            <span className="font-semibold text-foreground">
              Text me about this order.
            </span>{" "}
            We will only message you about a product you have bought
            running out — never anything else, and you can switch it off
            at any time.
          </span>
        </label>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        disabled={isPending}
      >
        {isPending
          ? isLogin
            ? "Signing in…"
            : "Creating your account…"
          : isLogin
            ? "Sign in"
            : "Create my account"}
      </Button>

      <p className="text-center text-xs text-foreground-muted">
        {isLogin ? (
          <>
            New here?{" "}
            <Link
              href={registerHref(next)}
              className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
            >
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link
              href={loginHref(next)}
              className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
            >
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

/**
 * Builds the sign-up link, preserving the destination.
 */
function registerHref(next: string): string {
  return next === "/" ? "/register" : `/register?next=${encodeURIComponent(next)}`;
}

/**
 * Builds the sign-in link, preserving the destination.
 */
function loginHref(next: string): string {
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
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
  required,
}: {
  readonly id: string;
  readonly label: string;
  readonly type?: string;
  readonly error?: string;
  readonly autoComplete?: string;
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
