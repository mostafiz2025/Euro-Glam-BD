import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { OtpSignInForm } from "@/components/commerce/otp-sign-in-form";
import { ChevronRightIcon } from "@/components/ui/icons";

/**
 * The email sign-in page.
 *
 * The customer gives an email address and the shop mails them a six-digit
 * code. No password, nothing to remember, nothing to store.
 *
 * The form is a client component because it needs `useSearchParams` for
 * the `next` parameter — so it is wrapped in a `<Suspense>` boundary,
 * which is what Next.js requires for that hook under Cache Components.
 */

/**
 * The page metadata.
 */
export const metadata: Metadata = {
  title: "Sign In With a Code",
  description:
    "Sign in to your Euro Glam BD account with a six-digit code we email to you.",
};

export default function SignInCodePage() {
  return (
    <div className="mx-auto max-w-md px-4 py-10 sm:px-6 sm:py-14">
      <nav aria-label="Breadcrumb" className="mb-4">
        <ol className="flex items-center gap-1.5 text-xs text-foreground-muted">
          <li>
            <Link
              href="/"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Home
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>
          <li>
            <span aria-current="page" className="font-medium text-foreground">
              Sign In
            </span>
          </li>
        </ol>
      </nav>

      <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        Sign in with a code
      </h1>

      <p className="mt-1.5 text-sm text-foreground-muted">
        Give us your email address and we will send you a six-digit code.
        No password needed.
      </p>

      <div className="mt-7">
        <Suspense fallback={<FormSkeleton />}>
          <OtpSignInForm />
        </Suspense>
      </div>

      <p className="mt-6 text-center text-xs text-foreground-muted">
        Would rather use a password?{" "}
        <Link
          href="/login"
          className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
        >
          Sign in with your password
        </Link>
      </p>
    </div>
  );
}

/**
 * The placeholder shown while the form's client code loads.
 */
function FormSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className="h-11 animate-pulse rounded-xl bg-surface-muted" />
      <div className="h-11 animate-pulse rounded-xl bg-surface-muted" />
      <div className="h-13 animate-pulse rounded-full bg-surface-muted" />
    </div>
  );
}
