import { connection } from "next/server";
import { Suspense } from "react";

import { HeadsetIcon, MailIcon, MapPinIcon } from "@/components/ui/icons";
import { listPublicSiteSettings } from "@/lib/catalog/site-settings";
import { phoneHref } from "@/lib/format/colors";

/**
 * The footer's contact details.
 *
 * ── Why this is its own component ─────────────────────────────────────────
 *
 * The footer's contact details are the shop's **own words** about how to
 * reach it, and they used to be strings in the footer component:
 *
 *   • `hello@euroglam.bd`
 *   • `Mon–Sat, 9am–8pm`
 *
 * That made them wrong the moment the shop's mailbox changed, and it
 * made them wrong for the only reason that matters to a customer: they
 * are the details a customer calls or writes to when they have paid
 * for something they cannot see.
 *
 * So they are read from `site_settings` — the same row the marquee
 * comes from, because they are the same kind of fact: what the shop
 * says about itself.
 *
 * ── Why it is streamed ────────────────────────────────────────────────────
 *
 * The read is a database round-trip, and the footer is on **every**
 * page of the storefront. Under Cache Components a bare database read
 * in the shell would opt the whole storefront out of the prerender —
 * the home page, the catalogue, every product — so that one row of
 * contact details could change.
 *
 * So the read is marked **request-bound** with `connection()` and sits
 * behind its own `<Suspense>` boundary. The footer's chrome — the
 * trust row, the link columns, the newsletter — stays prerendered and
 * ships instantly, and only the four contact lines stream in.
 *
 * ── A missing detail is a missing line ────────────────────────────────────
 *
 * A shop that has not told us its opening hours shows no hours line.
 * It does not show "Opening hours: —".
 *
 * An empty line in a footer reads as a mistake, and a shop whose
 * contact details are half-configured looks like a shop nobody
 * answers. The absence of a line is honest; a placeholder is not.
 *
 * ── The store address keeps its line breaks ───────────────────────────────
 *
 * The address is free text, and the shop may have written it across
 * several lines. It is rendered with `whitespace-pre-line`, because an
 * address read as one run-on line is an address nobody can copy into a
 * delivery app.
 */

/**
 * The contact details, with the data loaded.
 */
async function FooterContactContent() {
  // `connection()` MUST be called outside any try block: its rejection
  // is the signal that aborts the prerender.
  await connection();

  /*
   * The read is wrapped in its own try/catch.
   *
   * The footer's rule is that the page must render even when the
   * database is unavailable, and the footer is on every page: a footer
   * that threw would take the whole storefront down for a detail
   * nobody is reading yet.
   */
  const settings = await listPublicSiteSettings().catch((error: unknown) => {
    console.error("[storefront] Footer contact details failed:", error);

    return null;
  });

  const email = settings?.supportEmail ?? "";
  const phone = settings?.supportPhone ?? "";
  const hours = settings?.supportHours ?? "";
  const address = settings?.storeAddress ?? "";

  /*
   * Nothing to say.
   *
   * A shop that has configured no contact details renders no list at
   * all, rather than an empty `<ul>` with the footer's spacing around
   * it.
   */
  if (email === "" && phone === "" && hours === "" && address === "") {
    return null;
  }

  const telHref = phoneHref(phone);

  return (
    <ul className="mt-6 space-y-3 text-sm text-white/70">
      {hours !== "" ? (
        <li className="flex items-start gap-2.5">
          <HeadsetIcon
            width={16}
            height={16}
            className="mt-0.5 shrink-0 text-brand-300"
          />
          <span>{hours}</span>
        </li>
      ) : null}

      {/*
        The telephone.

        The href is built from the **digits** alone, so "01819-000000"
        reads the way the shop wrote it and still dials. See `phoneHref`.
      */}
      {phone !== "" ? (
        <li className="flex items-center gap-2.5">
          <HeadsetIcon
            width={16}
            height={16}
            className="shrink-0 text-brand-300"
          />
          {telHref === null ? (
            <span>{phone}</span>
          ) : (
            <a
              href={telHref}
              className="transition-colors hover:text-white focus-visible:outline-none focus-visible:text-white"
            >
              {phone}
            </a>
          )}
        </li>
      ) : null}

      {/*
        The support email.

        The `mailto:` is built from the address itself, and the address
        is validated as an email before it is stored — so it cannot
        carry a `javascript:` scheme into the href.
      */}
      {email !== "" ? (
        <li className="flex items-center gap-2.5">
          <MailIcon
            width={16}
            height={16}
            className="shrink-0 text-brand-300"
          />
          <a
            href={`mailto:${email}`}
            className="transition-colors hover:text-white focus-visible:outline-none focus-visible:text-white"
          >
            {email}
          </a>
        </li>
      ) : null}

      {/*
        The store's counter.
      */}
      {address !== "" ? (
        <li className="flex items-start gap-2.5">
          <MapPinIcon
            width={16}
            height={16}
            className="mt-0.5 shrink-0 text-brand-300"
          />
          <span className="whitespace-pre-line">{address}</span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The footer's contact details section.
 *
 * The fallback reserves the space the block usually takes — four short
 * lines — so the footer's columns do not jump when the real details
 * arrive. It is invisible: it is `aria-hidden`, it is not the content,
 * and it disappears the moment the content replaces it.
 */
export function FooterContactSection() {
  return (
    <Suspense fallback={<FooterContactFallback />}>
      <FooterContactContent />
    </Suspense>
  );
}

/**
 * The placeholder for the contact details.
 */
function FooterContactFallback() {
  return (
    <ul aria-hidden="true" className="mt-6 space-y-3">
      {[0, 1].map((index) => (
        <li key={index} className="flex items-center gap-2.5">
          <span className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-white/10" />
          <span className="h-3 w-36 animate-pulse rounded-full bg-white/10" />
        </li>
      ))}
    </ul>
  );
}
