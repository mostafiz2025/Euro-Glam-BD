"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * The traffic beacon.
 *
 * ── What it does ─────────────────────────────────────────────────────────
 *
 * On every storefront route change, it fires **one** request to
 * `/api/track` carrying what the browser already knows about the visit:
 *
 *   • the landing path
 *   • `document.referrer`
 *   • the `utm_source` query parameter, if the URL carries one
 *
 * The server derives the channel from those values and writes a row. The
 * client never decides the channel — it cannot know whether a referrer is
 * a search engine, and a taxonomy that the browser owns is a taxonomy
 * that changes with the browser.
 *
 * ── Why `sendBeacon` and not `fetch` ─────────────────────────────────────
 *
 * `navigator.sendBeacon` is designed for exactly this: a small payload
 * that must survive the page being unloaded. A customer who clicks
 * "Checkout" and then closes the tab is still counted — with `fetch`, the
 * request is cancelled and the visit is lost.
 *
 * `sendBeacon` also runs **off the main thread**. The analytics write
 * never competes with the render.
 *
 * ── Why it is fire-and-forget ─────────────────────────────────────────────
 *
 * The beacon's return value is ignored. There is no error handler, no
 * retry, no queue. If the request fails, the visit is missing — and a
 * missing visit is an acceptable loss. The alternative, a retry queue
 * with backoff and a localStorage fallback, turns an analytics feature
 * into a piece of infrastructure that can fail visibly and hurt the
 * storefront.
 *
 * The server side is equally forgiving: `/api/track` always returns `202`
 * and never rejects a caller.
 *
 * ── Why the admin console is excluded ─────────────────────────────────────
 *
 * The dashboard's traffic donut is a picture of **customers**, not of
 * everyone who uses the browser. An administrator browsing the inventory
 * list is not a customer, and counting them would inflate the "direct"
 * bucket every time somebody checked the numbers.
 *
 * The admin routes are skipped by pathname. The check is here rather
 * than on the server because the server cannot distinguish a customer
 * from an admin without reading the session — and reading the session on
 * a public beacon would make it request-time for every visitor.
 *
 * ── Why it fires on a route change and not on a timer ─────────────────────
 *
 * The server-side-rendered pages are the pages that matter. The beacon
 * fires when the pathname changes, which means it measures **landings**
 * rather than every client-side interaction. A customer who scrolls
 * through three products contributes three landings; a customer who
 * scrolls through one product contributes one.
 *
 * That is the right unit for a traffic breakdown. "How many people
 * arrived from Facebook" is a question about landings, and a page-view
 * count would answer a different question — one nobody asked.
 */
export function TrafficBeacon() {
  const pathname = usePathname();

  // The last path the beacon reported. A `useRef` rather than state,
  // because the value never drives the render — it only guards against
  // reporting the same landing twice.
  const lastReported = useRef<string | null>(null);

  useEffect(() => {
    // The admin console is not customer traffic.
    if (!pathname || pathname.startsWith("/admin")) return;

    // The same landing, twice — a re-render that did not navigate.
    if (lastReported.current === pathname) return;

    lastReported.current = pathname;

    // The referrer is only meaningful on the **first** landing of a
    // session: after that, `document.referrer` still points at the page
    // the customer came from, which would attribute every subsequent
    // page to the original source. That is arguably right — it is the
    // session's source — but it double-counts the same click across
    // every page, so the *first* landing claims the referrer and the
    // rest are direct.
    const isFirstLanding = window.sessionStorage.getItem("egb-v") === null;

    if (isFirstLanding) {
      try {
        window.sessionStorage.setItem("egb-v", "1");
      } catch {
        // A browser with storage disabled is not a failure. The beacon
        // simply reports every landing as a first landing.
      }
    }

    const referrer = isFirstLanding ? document.referrer : null;

    // The UTM parameters travel with the URL the customer landed on.
    // They are read from the **current** location, not the referrer, so
    // a campaign's own parameters are what is reported.
    const utmSource = readUtmSource();

    const payload = JSON.stringify({
      path: `${pathname}${window.location.search}`,
      referrer,
      utmSource,
    });

    try {
      navigator.sendBeacon("/api/track", new Blob([payload], {
        type: "application/json",
      }));
    } catch {
      // `sendBeacon` throws only if the payload is too large for the
      // beacon queue. There is nothing to recover from here.
    }
  }, [pathname]);

  return null;
}

/**
 * Reads `utm_source` from the current URL.
 *
 * Returns `null` when there is no source, or when the URL cannot be
 * parsed. The value is **not** decoded or validated here — the server
 * does both, and it is the server's decision.
 */
function readUtmSource(): string | null {
  try {
    return new URL(window.location.href).searchParams.get("utm_source");
  } catch {
    return null;
  }
}
