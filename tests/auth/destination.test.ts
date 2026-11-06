import { describe, expect, it } from "vitest";

import {
  ADMIN_HOME,
  destinationAfterSignIn,
  safeNext,
} from "@/lib/auth/destination";

/**
 * Where a signed-in user is sent.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * Two properties, and they pull in opposite directions:
 *
 *   1. **An admin lands in the console.** An administrator who signs in
 *      must end up at `/admin` without typing the path by hand. This is
 *      the bug this module exists to fix: the role was returned by the
 *      API and then thrown away, so every sign-in went to `next` — which
 *      defaulted to the storefront.
 *
 *   2. **A `next` parameter cannot redirect off-site.** It arrives from
 *      the query string, so it is attacker-controlled. It may only ever
 *      be a relative path *inside* this site.
 *
 * The precedence between them is the interesting part: **the role wins.**
 * A `next` exists to honour a *customer's* interrupted journey. An
 * admin has no such journey, so a `next` that points them at the
 * storefront is a leftover, not a request.
 */

describe("safeNext keeps the redirect inside the site", () => {
  it("passes a genuine relative path through", () => {
    expect(safeNext("/cart")).toBe("/cart");
    expect(safeNext("/products?sort=new")).toBe("/products?sort=new");
    expect(safeNext("/admin/orders")).toBe("/admin/orders");
  });

  it("falls back to the homepage when there is nothing to honour", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("rejects an absolute URL", () => {
    // An absolute URL would send the customer to another site entirely.
    expect(safeNext("https://evil.example/steal")).toBe("/");
    expect(safeNext("http://evil.example")).toBe("/");
  });

  it("rejects a protocol-relative URL", () => {
    // `//host` is read by the browser as a URL with that host — it is
    // the classic way to smuggle an off-site redirect past a naive
    // "must start with a slash" check.
    expect(safeNext("//evil.example")).toBe("/");
  });

  it("rejects a backslash-prefixed protocol-relative URL", () => {
    // Some browsers normalise `/\` to `//`, so this is the same attack
    // with a different spelling.
    expect(safeNext("/\\evil.example")).toBe("/");
  });

  it("rejects a scheme that is not a path", () => {
    expect(safeNext("javascript:alert(1)")).toBe("/");
    expect(safeNext("data:text/html,<script>alert(1)</script>")).toBe("/");
  });
});

describe("destinationAfterSignIn sends an admin to the console", () => {
  it("sends an admin to /admin", () => {
    expect(destinationAfterSignIn("ADMIN", null)).toBe(ADMIN_HOME);
  });

  it("sends an admin to /admin even when a next parameter is present", () => {
    // The role wins. A `next` is a customer's interrupted journey; an
    // admin's destination is the console.
    expect(destinationAfterSignIn("ADMIN", "/")).toBe(ADMIN_HOME);
    expect(destinationAfterSignIn("ADMIN", "/cart")).toBe(ADMIN_HOME);
    expect(destinationAfterSignIn("ADMIN", "/products")).toBe(ADMIN_HOME);
  });

  it("sends an admin to /admin even when the next parameter is off-site", () => {
    // Belt and braces: the role short-circuits before the guard, so
    // there is nothing for a hostile parameter to influence.
    expect(destinationAfterSignIn("ADMIN", "https://evil.example")).toBe(
      ADMIN_HOME,
    );
  });
});

describe("destinationAfterSignIn honours a customer's next parameter", () => {
  it("sends a customer to the next path", () => {
    expect(destinationAfterSignIn("CUSTOMER", "/cart")).toBe("/cart");
  });

  it("sends a customer with no next parameter to the homepage", () => {
    expect(destinationAfterSignIn("CUSTOMER", null)).toBe("/");
  });

  it("sends a customer with an off-site next parameter to the homepage", () => {
    expect(destinationAfterSignIn("CUSTOMER", "https://evil.example")).toBe("/");
    expect(destinationAfterSignIn("CUSTOMER", "//evil.example")).toBe("/");
  });

  it("treats an unknown or missing role as a customer", () => {
    // The role is not trusted beyond the two known values. A response
    // without a role must not be able to claim admin, and must not
    // crash the redirect either.
    expect(destinationAfterSignIn(undefined, "/cart")).toBe("/cart");
    expect(destinationAfterSignIn(null, "/cart")).toBe("/cart");
    expect(destinationAfterSignIn("SOMETHING_ELSE", "/cart")).toBe("/cart");
  });
});
