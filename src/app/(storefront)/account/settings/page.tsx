import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AddressForm } from "@/components/account/address-form";
import { PersonalDetailsForm } from "@/components/account/account-settings-forms";
import { PasswordForm } from "@/components/account/password-form";
import { ButtonLink } from "@/components/ui/button";
import { ChevronRightIcon } from "@/components/ui/icons";
import { getCustomerProfile } from "@/lib/account/profile";
import { getOptionalUser, type SessionUser } from "@/lib/auth/guards";

/**
 * The customer's account settings.
 *
 * ── What this page is for ─────────────────────────────────────────────────
 *
 * The `/account` page is the customer's **dashboard**: their orders, and a
 * read-only summary of their details. This page is the place those
 * details are **edited**.
 *
 * The split is deliberate. An account page that mixes a read-only summary
 * with a pile of editable forms makes it hard to tell what is a fact
 * about the account and what is a form waiting to be submitted. Two
 * pages, two jobs.
 *
 * ── Why the page is not prerendered ───────────────────────────────────────
 *
 * It belongs to a user, so it cannot be. Under Cache Components a
 * session-gated route must declare that it may block, with
 * `export const instant = false`.
 */

/**
 * The page metadata.
 */
export const metadata: Metadata = {
  title: "Account Settings",
  description: "Update your name, number, delivery address and password.",
};

/**
 * This route is allowed to block.
 *
 * The settings belong to a user, so they cannot be prerendered.
 */
export const instant = false;

/**
 * The settings page.
 */
export default async function AccountSettingsPage() {
  // The page depends on who is asking, so it is rendered at request
  // time and the session is read outside the `<Suspense>` boundary.
  await connection();

  const user = await getOptionalUser();

  if (!user) {
    return <SignedOut />;
  }

  const profile = await getCustomerProfile(user.id).catch(
    (error: unknown) => {
      console.error("[storefront] Customer profile failed:", error);
      return null;
    },
  );

  if (!profile) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 px-6 py-12 text-center">
          <h1 className="font-serif text-2xl font-bold text-foreground">
            We could not load your details
          </h1>

          <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
            Please refresh the page and try again. If it keeps happening,
            get in touch and we will sort it out.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
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
            <Link
              href="/account"
              className="transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Your Account
            </Link>
          </li>

          <li aria-hidden="true">
            <ChevronRightIcon width={12} height={12} className="text-neutral-300" />
          </li>

          <li>
            <span aria-current="page" className="font-medium text-foreground">
              Settings
            </span>
          </li>
        </ol>
      </nav>

      <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        Account settings
      </h1>

      <p className="mt-1.5 text-sm text-foreground-muted">
        Keep your details current so your deliveries reach you.
      </p>

      <div className="mt-8 space-y-6">
        <Card>
          <PersonalDetailsForm
            details={{
              name: profile.name,
              email: profile.email,
              phone: profile.phone,
              smsOptIn: profile.smsOptIn,
            }}
          />
        </Card>

        <Card>
          <AddressForm
            address={profile.defaultAddress}
            customerName={profile.name}
            customerPhone={profile.phone}
          />
        </Card>

        <Card>
          <PasswordForm />
        </Card>
      </div>
    </div>
  );
}

/**
 * The card a form sits in.
 */
function Card({ children }: { readonly children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-card)] sm:p-6">
      {children}
    </section>
  );
}

/**
 * What a signed-out visitor sees.
 *
 * The settings are private, so there is nothing to show. The page says so
 * plainly and points at the way in, rather than rendering a 401.
 */
function SignedOut() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface px-6 py-16 text-center">
        <h1 className="font-serif text-2xl font-bold text-foreground">
          Account settings
        </h1>

        <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-muted">
          Sign in to update your name, number, delivery address and
          password.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <ButtonLink
            href="/login?next=%2Faccount%2Fsettings"
            variant="primary"
            size="sm"
          >
            Sign in
          </ButtonLink>

          <ButtonLink href="/register" variant="outline" size="sm">
            Create an account
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}

/**
 * The session user, re-exported for the type above.
 */
export type { SessionUser };
