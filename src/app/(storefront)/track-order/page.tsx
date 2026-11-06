import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { OrderTrackingForm } from "@/components/commerce/order-tracking-form";
import { ChevronRightIcon, ClockIcon, TruckIcon } from "@/components/ui/icons";
import { listPublicSiteSettings } from "@/lib/catalog/site-settings";

/**
 * The order-tracking page.
 *
 * ── Why this page is public ───────────────────────────────────────────────
 *
 * The customer who most needs to know where their parcel is — the one
 * who ordered as a guest, or who never made an account — is by
 * definition **not signed in**. So this page lives in the storefront
 * group, where the shop's chrome is, and it asks for nothing but the
 * order number and a contact detail.
 *
 * ── Why it lives inside the `(storefront)` group ──────────────────────────
 *
 * The footer's "Track an order" link pointed at a URL that did not
 * exist. It was a dead link in the one part of the page where a
 * customer goes when something has gone wrong — which is the worst
 * place for a dead link, and the reason this page exists.
 *
 * Putting it inside the group is what gives it the shop's header, its
 * footer and its contact details. A bare page with no chrome would be
 * a page a customer cannot get back from.
 *
 * ── Why the page does not read the order itself ──────────────────────────
 *
 * The page is **static**. It does not read the order, the settings, or
 * anything else on the way in — the lookup happens when the customer
 * submits the form, through the public API.
 *
 * That is not merely a matter of taste. A page that read the order on
 * the way in would have to either take the order number from the URL —
 * which puts it in the address bar, in the browser history and in the
 * referrer of every link the customer clicks afterwards — or read the
 * session, which defeats the purpose of a guest page.
 *
 * So the order number is typed, and the answer arrives over `fetch`.
 */

/**
 * The page metadata.
 */
export const metadata: Metadata = {
  title: "Track Your Order",
  description:
    "Check where your Euro Glam BD order is. Enter your order number and the email address or phone number on the order.",
};

/**
 * The reassurance points.
 *
 * Three, because three is what a customer actually worries about:
 * where it is, how long it takes, and what happens if it goes wrong.
 */
const REASSURANCES = [
  {
    icon: TruckIcon,
    title: "Where it is now",
    body: "We show the stage your parcel has reached — placed, packed, dispatched or delivered.",
  },
  {
    icon: ClockIcon,
    title: "How long it takes",
    body: "Delivered across Bangladesh in 2–4 working days, and you can check any time.",
  },
  {
    icon: ChevronRightIcon,
    title: "If it goes wrong",
    body: "Write to our support desk and a person will pick it up — not a robot.",
  },
] as const;

/**
 * The order-tracking page.
 *
 * The page's shell — the breadcrumb, the headings and the reassurance
 * points — is static and prerendered. The **support email** is read from
 * the database, because it is the shop's own words about where to write,
 * and a hard-coded address is wrong the moment the shop's mailbox
 * changes.
 *
 * The read is streamed behind its own `<Suspense>` boundary so the
 * page itself stays prerendered — the same rule the footer's contact
 * details follow, for the same reason.
 */
export default function TrackOrderPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
      {/* ── The breadcrumb ───────────────────────────────────────────── */}
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
              Track an order
            </span>
          </li>
        </ol>
      </nav>

      {/* ── The page header ──────────────────────────────────────────── */}
      <div className="mb-7">
        <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Track your order
        </h1>

        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-foreground-muted">
          Enter your order number and the email address or phone number on the
          order. We will tell you exactly where your parcel has reached — no
          account needed.
        </p>
      </div>

      {/* ── The form ─────────────────────────────────────────────────── */}
      <Suspense fallback={<TrackingFormSkeleton />}>
        <TrackingFormSection />
      </Suspense>

      {/* ── The reassurance points ───────────────────────────────────── */}
      <ul className="mt-10 grid gap-5 sm:grid-cols-3">
        {REASSURANCES.map((point) => {
          const Icon = point.icon;

          return (
            <li key={point.title}>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 text-brand-600">
                <Icon width={16} height={16} />
              </span>

              <h2 className="mt-3 text-sm font-semibold text-foreground">
                {point.title}
              </h2>

              <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
                {point.body}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The form, with the support email loaded.
 *
 * The email is read **inside** the boundary rather than in the page, so
 * the read is request-bound and the page around it stays prerendered.
 */
async function TrackingFormSection() {
  const settings = await listPublicSiteSettings().catch((error: unknown) => {
    console.error("[storefront] The support email failed to load:", error);

    return null;
  });

  return <OrderTrackingForm supportEmail={settings?.supportEmail || undefined} />;
}

/**
 * The placeholder shown while the form's section loads.
 */
function TrackingFormSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      <div className="h-11 animate-pulse rounded-xl bg-surface-muted" />
      <div className="h-11 animate-pulse rounded-xl bg-surface-muted" />
      <div className="h-13 animate-pulse rounded-full bg-surface-muted" />
    </div>
  );
}
