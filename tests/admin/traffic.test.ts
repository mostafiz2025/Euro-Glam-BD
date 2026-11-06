import { describe, expect, it } from "vitest";

import {
  TRAFFIC_SOURCES,
  deriveTrafficEvent,
  deriveTrafficSource,
  extractHost,
  normalisePath,
} from "@/lib/traffic";

/**
 * The traffic taxonomy.
 *
 * The taxonomy is closed and the rules are ordered, so every branch is
 * pinned down here. A taxonomy that only mostly works produces a
 * breakdown that is mostly wrong, and a breakdown that is mostly wrong
 * is worse than none — it looks authoritative.
 */

describe("the traffic taxonomy", () => {
  it("is a closed set of five channels", () => {
    expect(TRAFFIC_SOURCES).toEqual([
      "facebook",
      "organic",
      "direct",
      "email",
      "other",
    ]);
  });
});

describe("deriveTrafficSource", () => {
  it("buckets a Facebook referrer as facebook", () => {
    expect(
      deriveTrafficSource("https://www.facebook.com/somepage"),
    ).toBe("facebook");
  });

  it("buckets a mobile Facebook referrer as facebook", () => {
    expect(
      deriveTrafficSource("https://m.facebook.com/somepage"),
    ).toBe("facebook");
  });

  it("buckets an l.facebook.com referrer as facebook", () => {
    expect(deriveTrafficSource("https://l.facebook.com/l")).toBe("facebook");
  });

  it("buckets a Google referrer as organic", () => {
    expect(
      deriveTrafficSource("https://www.google.com/search?q=skincare"),
    ).toBe("organic");
  });

  it("buckets a regional Google domain as organic", () => {
    // `google.com` and `google.co.bd` are the same engine, and a
    // Bangladeshi shop will see plenty of the latter.
    expect(deriveTrafficSource("https://www.google.co.bd/search")).toBe(
      "organic",
    );
  });

  it("buckets a Bing referrer as organic", () => {
    expect(deriveTrafficSource("https://www.bing.com/search")).toBe(
      "organic",
    );
  });

  it("buckets a Yahoo search referrer as organic", () => {
    expect(deriveTrafficSource("https://search.yahoo.com/search")).toBe(
      "organic",
    );
  });

  it("buckets a Yahoo mail referrer as email", () => {
    // Yahoo's search and Yahoo Mail share a registrable domain. Only
    // the subdomain label tells them apart — and it is what does.
    expect(deriveTrafficSource("https://mail.yahoo.com/d/folders/1")).toBe(
      "email",
    );
  });

  it("does not treat a mail subdomain as a search engine", () => {
    // `mail.google.com` sits on the same registrable domain as Google
    // Search. A mail client is not a search referrer.
    expect(deriveTrafficSource("https://mail.google.com/mail/u/0")).toBe(
      "email",
    );
  });

  it("buckets no referrer as direct", () => {
    expect(deriveTrafficSource(null)).toBe("direct");
  });

  it("buckets an empty referrer as direct", () => {
    expect(deriveTrafficSource("")).toBe("direct");
  });

  it("buckets a Gmail referrer as email", () => {
    expect(deriveTrafficSource("https://mail.google.com/mail/u/0")).toBe(
      "email",
    );
  });

  it("buckets an Outlook referrer as email", () => {
    expect(deriveTrafficSource("https://outlook.live.com/mail/0")).toBe(
      "email",
    );
  });

  it("buckets an unknown host as other", () => {
    expect(deriveTrafficSource("https://some-blog.example/post")).toBe(
      "other",
    );
  });

  it("does not treat a lookalike search host as organic", () => {
    // `notgoogle.com` is not Google. The search-engine rule matches a
    // domain **suffix** on a label boundary, so a domain that merely
    // contains "google" is not bucketed as organic.
    expect(deriveTrafficSource("https://notgoogle.com/")).not.toBe(
      "organic",
    );
  });

  it("does not treat a lookalike mail subdomain as email", () => {
    // The `mail.` label must be the *first* label of the host.
    expect(deriveTrafficSource("https://notmail.google.com/")).not.toBe(
      "email",
    );
  });

  it("does not treat a Facebook lookalike as facebook", () => {
    // The Facebook rule matches a domain suffix on a label boundary, so
    // `facebook.com.example.org` is not Facebook.
    expect(
      deriveTrafficSource("https://facebook.com.example.org/post"),
    ).not.toBe("facebook");
  });

  it("lets a known UTM source win over the referrer", () => {
    // A campaign that says where it came from is stating the channel
    // outright, and rule 1 runs first.
    expect(
      deriveTrafficSource("https://some-blog.example/post", "facebook"),
    ).toBe("facebook");
  });

  it("buckets an email UTM source as email", () => {
    expect(deriveTrafficSource(null, "email")).toBe("email");
  });

  it("buckets a newsletter UTM source as email", () => {
    expect(deriveTrafficSource(null, "newsletter")).toBe("email");
  });

  it("buckets an unrecognised UTM source with no referrer as other", () => {
    // The campaign named a source we do not know, and there is no
    // referrer to fall back on. It is not direct — a direct visit
    // carries no campaign marker at all.
    expect(deriveTrafficSource(null, "some-partner-network")).toBe("other");
  });

  it("ignores a UTM source's casing and whitespace", () => {
    expect(deriveTrafficSource(null, "  Facebook  ")).toBe("facebook");
  });

  it("still reads the referrer when the UTM source is unknown", () => {
    expect(
      deriveTrafficSource("https://www.facebook.com/x", "some-partner"),
    ).toBe("facebook");
  });

  it("buckets a Facebook referrer from an email client as facebook", () => {
    // Rule 2 runs before rule 5, and the order is fixed.
    expect(
      deriveTrafficSource("https://www.facebook.com/x", null),
    ).toBe("facebook");
  });
});

describe("extractHost", () => {
  it("returns the host of an absolute URL", () => {
    expect(extractHost("https://www.facebook.com/page?x=1")).toBe(
      "www.facebook.com",
    );
  });

  it("lower-cases the host", () => {
    expect(extractHost("https://WWW.Facebook.com/page")).toBe(
      "www.facebook.com",
    );
  });

  it("returns null for a relative URL", () => {
    expect(extractHost("/products")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractHost("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(extractHost(null)).toBeNull();
  });

  it("returns null for the literal string some browsers send", () => {
    // Some browsers put the string "null" in `document.referrer`.
    expect(extractHost("null")).toBeNull();
  });

  it("never returns a path or a query string", () => {
    const host = extractHost("https://example.com/some/path?token=secret");

    expect(host).toBe("example.com");
    expect(host).not.toContain("token");
    expect(host).not.toContain("/");
  });
});

describe("normalisePath", () => {
  it("keeps a relative path", () => {
    expect(normalisePath("/products")).toBe("/products");
  });

  it("strips the query string", () => {
    // A query string can carry a campaign parameter, a session token,
    // or an email address. None of those belong in a traffic log.
    expect(normalisePath("/products?utm_source=facebook&email=a@b.com")).toBe(
      "/products",
    );
  });

  it("strips the fragment", () => {
    expect(normalisePath("/products#reviews")).toBe("/products");
  });

  it("reduces an absolute URL to its pathname", () => {
    expect(normalisePath("https://example.com/products?x=1")).toBe(
      "/products",
    );
  });

  it("returns the root for an empty path", () => {
    expect(normalisePath("")).toBe("/");
  });

  it("returns the root for null", () => {
    expect(normalisePath(null)).toBe("/");
  });

  it("truncates a path beyond the column's limit", () => {
    const long = `/${"a".repeat(400)}`;

    expect(normalisePath(long)).toHaveLength(255);
  });
});

describe("deriveTrafficEvent", () => {
  it("records the host, not the full referrer", () => {
    const derived = deriveTrafficEvent({
      path: "/products",
      referrer: "https://www.facebook.com/page?campaign=secret",
      visitorId: "abc",
    });

    expect(derived.source).toBe("facebook");
    expect(derived.referrerHost).toBe("www.facebook.com");
    expect(derived.referrerHost).not.toContain("campaign");
  });

  it("records a null host for direct traffic", () => {
    const derived = deriveTrafficEvent({
      path: "/",
      referrer: null,
      visitorId: "abc",
    });

    expect(derived.source).toBe("direct");
    expect(derived.referrerHost).toBeNull();
  });

  it("strips the query string from the recorded path", () => {
    const derived = deriveTrafficEvent({
      path: "/products?utm_source=facebook",
      visitorId: "abc",
    });

    expect(derived.path).toBe("/products");
  });
});
