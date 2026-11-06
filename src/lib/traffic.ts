/**
 * The traffic collector.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * There was no traffic data anywhere in the system — no page-view table,
 * no referrer column, no UTM capture. So a "Customer Traffic & Source"
 * breakdown could only have been built by inventing four numbers, and an
 * invented donut is worse than no donut: it looks like data.
 *
 * So the data is collected. This module is the collector's brain: it
 * derives a channel from what the browser knows, and it writes a row.
 *
 * ── The taxonomy is closed ────────────────────────────────────────────────
 *
 * Five buckets. Not "whatever the referrer was" — a closed set, because a
 * donut of forty hosts is not a breakdown, it is a log file with
 * circles. And a closed set means a bucket with no traffic is
 * *reported as zero* rather than being absent, which is a different
 * and more useful claim.
 *
 * ── What is NOT a traffic source ──────────────────────────────────────────
 *
 * **`PaymentMethod` is not a traffic source.**
 *
 * `COD | BKASH | NAGAD | CARD` is *how they paid*, not *where they came
 * from*. Deriving a "Facebook" slice from the orders that happened to
 * be paid by bKash would be a fabrication — and it would be a
 * fabrication that looks entirely plausible on a dashboard, which is
 * the worst kind.
 *
 * So the channel comes from the referrer host and the UTM parameters,
 * and from nowhere else.
 *
 * ── Privacy ───────────────────────────────────────────────────────────────
 *
 * The recorded row contains a bucketed channel, a referrer **host**, a
 * landing path and a pseudonymous visitor id. It contains:
 *
 *   • **no** IP address
 *   • **no** user agent
 *   • **no** raw referrer URL — only its host, so a campaign parameter
 *     or a session token in a query string never reaches the database
 *   • **no** cross-site identifier
 *   • **no** personal data
 *
 * The visitor id is a random value in a first-party cookie. It is not
 * the user id, and it is not a fingerprint: someone who clears their
 * cookies, or uses two browsers, is two visitors. A signed-in
 * customer's traffic is bucketed exactly like anyone else's, and the
 * two are never joined.
 */

/**
 * The traffic channels.
 *
 * A closed set. Every recorded event is in exactly one of these.
 */
export const TRAFFIC_SOURCES = [
  "facebook",
  "organic",
  "direct",
  "email",
  "other",
] as const;

export type TrafficSource = (typeof TRAFFIC_SOURCES)[number];

/**
 * The cookie that carries the visitor id.
 */
export const VISITOR_COOKIE_NAME = "egb_vid";

/**
 * The hosts that mean "Facebook".
 *
 * Matched as a **domain suffix**, so `www.facebook.com`, `m.facebook.com`,
 * `l.facebook.com`, `lm.facebook.com` and the regional domains all match —
 * while `facebook.com.example.org` does not.
 */
const FACEBOOK_DOMAINS = ["facebook.com", "fb.com", "fb.me"];

/**
 * The search engines that mean "organic".
 *
 * Matched as a **domain suffix**, because `google.com` and
 * `google.co.bd` are the same engine and a search referrer is usually on a
 * subdomain (`www.google.com`, `search.yahoo.com`). A bare substring
 * match would also catch `notgoogle.com`, which is not a search engine.
 */
const SEARCH_ENGINE_DOMAINS = [
  "google.com",
  "google.co.uk",
  "google.co.bd",
  "bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "ecosia.org",
  "brave.com",
  "startpage.com",
];

/**
 * The mail providers that mean "email".
 *
 * Matched as a **domain suffix**, because the mail host is a subdomain of
 * the provider's domain: `outlook.live.com`, `gmail.com`.
 *
 * `google.com` is deliberately absent — `mail.google.com` sits on the
 * same registrable domain as Google Search, and a search referrer must
 * land in `organic`, not `email`. The Google mail hosts are covered by
 * the `mail.` subdomain label below, which is checked before the search
 * rule precisely so that `mail.google.com` is email and `www.google.com`
 * is organic.
 */
const MAIL_DOMAINS = [
  "outlook.com",
  "outlook.live.com",
  "hotmail.com",
  "gmail.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
];

/**
 * The subdomains that mean "email", whatever the registrable domain is.
 *
 * `mail.google.com` is a mail client; `mail.example.com` is a mail client
 * too. The `mail.` label is the signal, and it is matched as a **label
 * prefix** rather than a substring, so `notmail.example.com` does not
 * match.
 */
const MAIL_SUBDOMAIN_LABELS = ["mail"];

/**
 * The UTM sources that map directly onto a channel.
 *
 * A campaign that names its source is stating the channel outright, so
 * that statement wins — with one exception, handled below.
 */
const UTM_SOURCE_MAP: Record<string, TrafficSource> = {
  facebook: "facebook",
  fb: "facebook",
  fbc: "facebook",
  meta: "facebook",
  instagram: "other",
  google: "organic",
  bing: "organic",
  youtube: "other",
  email: "email",
  newsletter: "email",
  mail: "email",
};

/**
 * Reduces a URL to its host.
 *
 * Returns `null` when the URL cannot be parsed, and `null` when it has
 * no host — which is the case for a relative URL, and for the literal
 * string "null" that some browsers put in `document.referrer`.
 */
export function extractHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;

  const trimmed = referrer.trim();

  if (trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);

    // A URL with no host is not a referrer we can learn anything
    // from.
    if (!url.hostname) return null;

    // Lower-cased: hostnames are case-insensitive, and "Facebook.com"
    // must match "facebook.com".
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Matches a host against a list of domain suffixes.
 *
 * The match is anchored on a **label boundary**: the host must either be
 * the domain itself, or end with `.` followed by the domain. So
 * `www.google.com` matches `google.com`, `google.com` matches
 * `google.com`, and `notgoogle.com` matches neither.
 */
function matchesDomain(host: string, domains: readonly string[]): boolean {
  return domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/**
 * Matches a host against a list of subdomain labels.
 *
 * The label must be the **first** label of the host, and the host must
 * have at least one more label after it. So `mail.google.com` matches
 * `mail`, and `notmail.google.com` does not.
 */
function matchesSubdomainLabel(
  host: string,
  labels: readonly string[],
): boolean {
  const separator = host.indexOf(".");

  if (separator <= 0) return false;

  const firstLabel = host.slice(0, separator);

  return labels.includes(firstLabel);
}

/**
 * Derives the traffic channel from a referrer and a UTM source.
 *
 * ── The order of the rules ────────────────────────────────────────────────
 *
 * The order is fixed and documented, because a taxonomy that depends on
 * the order is only defensible if the order is stated.
 *
 *   1. **A known UTM source wins.** A campaign that says where it came
 *      from is stating the channel outright.
 *   2. **Facebook's hosts.** A Facebook link is a Facebook click.
 *   3. **A mail subdomain.** A host whose first label is `mail` — such as
 *      `mail.google.com` — is an email client, never a search engine.
 *      This comes before the search rule because `mail.google.com` and
 *      `www.google.com` share a registrable domain, and only the
 *      subdomain label tells them apart.
 *   4. **A search engine.** A search-engine referrer is organic
 *      search.
 *   5. **No referrer at all is direct.** Someone who typed the URL, or
 *      followed a bookmark, or came from a link in an app, arrives with
 *      no referrer. That is what "direct" means.
 *   6. **A mail provider's own domain.** An email client.
 *   7. **Everything else is `other`.**
 *
 * Step 6 comes **after** steps 2–5 deliberately. A Facebook link
 * clicked from an email client is still, in practice, a Facebook click —
 * but the taxonomy is closed and deterministic, so the order is fixed
 * rather than arguable.
 *
 * @param referrer  - The document referrer, if any.
 * @param utmSource - The `utm_source` query parameter, if any.
 */
export function deriveTrafficSource(
  referrer: string | null | undefined,
  utmSource?: string | null,
): TrafficSource {
  const normalisedUtm = utmSource?.trim().toLowerCase() ?? "";

  // ── Rule 1: a known UTM source ──────────────────────────────────────
  if (normalisedUtm.length > 0) {
    const mapped = UTM_SOURCE_MAP[normalisedUtm];

    if (mapped) return mapped;
  }

  const host = extractHost(referrer);

  // ── Rule 4: no referrer is direct ───────────────────────────────────
  //
  // This comes before the host rules because there is no host to match
  // a rule against. The order of the *host* rules among themselves is
  // what matters, and it is fixed below.
  if (host === null) {
    // A UTM source that is not in the map, and no referrer. The
    // campaign named a source we do not recognise, but the visit still
    // happened without a referrer — so it is direct traffic from an
    // unrecognised campaign, not organic.
    return normalisedUtm.length > 0 ? "other" : "direct";
  }

  // ── Rule 2: Facebook ────────────────────────────────────────────────
  if (matchesDomain(host, FACEBOOK_DOMAINS)) {
    return "facebook";
  }

  // ── Rule 5a: a mail subdomain ──────────────────────────────────────
  //
  // Checked before the search rule, because a mail client is never a
  // search engine. `mail.google.com` and `www.google.com` share a
  // registrable domain; the subdomain label is what tells them apart.
  // Without this, a Gmail link would be reported as organic search.
  if (matchesSubdomainLabel(host, MAIL_SUBDOMAIN_LABELS)) {
    return "email";
  }

  // ── Rule 3: a search engine ────────────────────────────────────────
  if (matchesDomain(host, SEARCH_ENGINE_DOMAINS)) {
    return "organic";
  }

  // ── Rule 5b: a mail provider ───────────────────────────────────────
  if (matchesDomain(host, MAIL_DOMAINS)) {
    return "email";
  }

  // ── Rule 6: everything else ────────────────────────────────────────
  return "other";
}

/**
 * Reduces a landing path to something safe to store.
 *
 * The **query string is stripped**. A query string can carry campaign
 * parameters, a session token, or an email address, and none of those
 * belong in a traffic log. The path itself is truncated to the column's
 * limit.
 *
 * A relative path is kept as-is. An absolute URL is reduced to its
 * pathname.
 */
export function normalisePath(path: string | null | undefined): string {
  const trimmed = path?.trim() ?? "";

  if (trimmed.length === 0) return "/";

  let pathname = trimmed;

  try {
    // An absolute URL becomes its pathname.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      pathname = new URL(trimmed).pathname;
    }
  } catch {
    pathname = trimmed;
  }

  // The query string and the fragment never reach the database.
  const withoutQuery = pathname.split("?")[0].split("#")[0];

  const safe = withoutQuery.length > 0 ? withoutQuery : "/";

  return safe.slice(0, 255);
}

/**
 * A traffic event as the collector records it.
 */
export type TrafficEventInput = {
  /** The landing path. */
  readonly path: string;
  /** The document referrer, if any. */
  readonly referrer?: string | null;
  /** The `utm_source` parameter, if any. */
  readonly utmSource?: string | null;
  /** The visitor's pseudonymous id. */
  readonly visitorId: string;
};

/**
 * The recorded event.
 */
export type RecordedTrafficEvent = {
  readonly id: string;
  readonly source: TrafficSource;
  readonly referrerHost: string | null;
  readonly path: string;
  readonly visitorId: string;
  readonly createdAt: Date;
};

/**
 * The function that writes a traffic row.
 *
 * Injected rather than imported, so the taxonomy can be tested without
 * a database — and so the *decision* (which bucket) stays separate from
 * the *write*.
 */
export type TrafficWriter = (
  event: TrafficEventInput,
  derived: {
    readonly source: TrafficSource;
    readonly referrerHost: string | null;
    readonly path: string;
  },
) => Promise<void>;

/**
 * Builds the derived fields for an event.
 *
 * Exposed separately so the write can be tested without touching the
 * database.
 */
export function deriveTrafficEvent(event: TrafficEventInput): {
  readonly source: TrafficSource;
  readonly referrerHost: string | null;
  readonly path: string;
} {
  return {
    source: deriveTrafficSource(event.referrer, event.utmSource),
    referrerHost: extractHost(event.referrer),
    path: normalisePath(event.path),
  };
}

/**
 * The collector.
 *
 * The write is **fire-and-forget**: a failed analytics write must never
 * break a customer's page. The caller wraps this in a try/catch, or
 * passes a writer that does.
 */
export async function recordTrafficEvent(
  event: TrafficEventInput,
  writer: TrafficWriter,
): Promise<void> {
  const derived = deriveTrafficEvent(event);

  await writer(event, derived);
}

/**
 * Generates a pseudonymous visitor id.
 *
 * A random value, derived from nothing about the visitor. Not a
 * fingerprint, not a hash of the user's agent, not the user id.
 */
export function generateVisitorId(): string {
  // `crypto.randomUUID` is available in every runtime this project
  // targets (Node 18+, and every modern browser).
  const bytes = new Uint8Array(16);

  crypto.getRandomValues(bytes);

  // A short, URL-safe form. The id only has to be unique within this
  // cookie's lifetime; it carries no information about the visitor.
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
