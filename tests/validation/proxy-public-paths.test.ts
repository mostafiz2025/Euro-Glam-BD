import { describe, expect, it } from "vitest";

import { isPublicApiPath, isPublicPath } from "@/proxy";

/**
 * The proxy's public-API decision.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The proxy is a **fast filter**. It rejects an obvious mistake before
 * the request reaches the database; the route handler's guard is what
 * actually authorises the action. Both exist, and the proxy's value
 * depends entirely on being *right* about what is public.
 *
 * The property that matters:
 *
 *   1. The catalogue is public. A signed-out visitor must be able to
 *      browse, search and read a product page without an account.
 *   2. A **write** under a public prefix is not public. The review
 *      submission lives at `/api/products/{id}/reviews`, which sits
 *      inside the public `/api/products` prefix, and it mutates
 *      state.
 *
 * The second is the one that regresses silently. `/api/products` was
 * added to the public list so the storefront could read the catalogue,
 * and the moment a write endpoint was placed inside that prefix, the
 * prefix started granting access it never should have. Nothing about
 * the change looks wrong — the storefront still browses fine, the
 * tests still pass, and the only symptom is that an anonymous review
 * submission travels all the way to the database before being
 * rejected.
 *
 * These tests pin the decision down so that the next write endpoint
 * added under a public prefix has to be *deliberately* added to the
 * carve-out, rather than swept in by a prefix match.
 */
describe("isPublicApiPath", () => {
  // ── The catalogue is public ─────────────────────────────────────────────

  it("treats the product list as public", () => {
    expect(isPublicApiPath("/api/products")).toBe(true);
  });

  it("treats a single product as public", () => {
    expect(isPublicApiPath("/api/products/abc123")).toBe(true);
  });

  it("treats the category list as public", () => {
    expect(isPublicApiPath("/api/categories")).toBe(true);
  });

  it("treats a single category as public", () => {
    expect(isPublicApiPath("/api/categories/skincare")).toBe(true);
  });

  // ── A write under a public prefix is not public ─────────────────────────

  it("does not treat the review submission as public", () => {
    // The whole point. This path is inside the public `/api/products`
    // prefix, and it writes a row.
    expect(isPublicApiPath("/api/products/abc123/reviews")).toBe(false);
  });

  it("does not treat the review submission as public for any product id", () => {
    // The carve-out is a pattern, not a literal. A literal `[id]` would
    // match nothing and the carve-out would do nothing at all.
    expect(isPublicApiPath("/api/products/1/reviews")).toBe(false);
    expect(isPublicApiPath("/api/products/clyp-xyz/reviews")).toBe(false);
    expect(
      isPublicApiPath("/api/products/clk_123-ABC_xyz/reviews"),
    ).toBe(false);
  });

  it("does not treat a reviews path with extra segments as public", () => {
    expect(isPublicApiPath("/api/products/abc123/reviews/42")).toBe(false);
    expect(isPublicApiPath("/api/products/abc123/reviews/42/approve")).toBe(
      false,
    );
  });

  // ── The carve-out must not over-reach ───────────────────────────────────

  it("still treats a product whose name contains 'reviews' as public", () => {
    // The pattern anchors the segment. A product id is not a path
    // segment containing slashes, so this cannot be a review path.
    expect(isPublicApiPath("/api/products/reviews")).toBe(true);
  });

  it("does not treat a similarly-named path as a review path", () => {
    expect(isPublicApiPath("/api/products/abc123/review")).toBe(true);
    expect(isPublicApiPath("/api/products/abc123/reviewsx")).toBe(true);
  });

  // ── The guest order-tracking endpoint ──────────────────────────────────

  it("treats the order-tracking endpoint as public", () => {
    /*
     * The endpoint is public by necessity, not by convenience. The
     * customer who most needs to know where their parcel is — the one who
     * ordered as a guest, or who never made an account — is by definition
     * not signed in, and a session requirement would make the endpoint
     * answer only to the customers who do not need it.
     *
     * It is bounded by something else entirely: the contact detail on the
     * order, plus an hourly limit counted in the database.
     */
    expect(isPublicApiPath("/api/order-tracking")).toBe(true);
  });

  it("treats the whole order-tracking subtree as public", () => {
    // Nothing else lives under the prefix today, and the prefix match is
    // what makes a future read there work without another edit.
    expect(isPublicApiPath("/api/order-tracking/history")).toBe(true);
  });

  it("does not treat a similarly-named path as order-tracking", () => {
    // The prefix match is anchored to a segment boundary.
    expect(isPublicApiPath("/api/order-tracker")).toBe(false);
    expect(isPublicApiPath("/api/orders/abc123")).toBe(false);
  });

  // ── The email sign-in paths ────────────────────────────────────────────

  it("treats the OTP endpoints as public", () => {
    /*
     * The two OTP endpoints are the sign-in path for a customer who has
     * no session yet. Requiring a session to obtain a session would make
     * the flow impossible.
     *
     * They are bounded by something else entirely: the mailed code,
     * which is attempt-limited, single-use and expires. See
     * `src/lib/auth/otp.ts`.
     *
     * They live in `PUBLIC_PATHS` rather than `PUBLIC_API_PREFIXES`
     * because each is an exact endpoint, not a subtree — there is no
     * `/api/auth/*` tree that is public, because `/api/auth/session` and
     * `/api/auth/refresh` are not.
     */
    expect(isPublicPath("/api/auth/send-otp")).toBe(true);
    expect(isPublicPath("/api/auth/verify-otp")).toBe(true);
  });

  it("does not treat the rest of the auth API as public", () => {
    expect(isPublicPath("/api/auth/refresh")).toBe(false);
    expect(isPublicPath("/api/auth/session")).toBe(false);
    expect(isPublicPath("/api/auth/password-reset")).toBe(false);
  });

  it("does not sweep the whole auth tree in with a prefix match", () => {
    /*
     * The public auth paths are matched exactly (or as a prefix of
     * themselves). A path that merely starts with "/api/auth" is a
     * different endpoint and must not be granted a session exemption
     * by accident.
     */
    expect(isPublicPath("/api/auth/admin/users")).toBe(false);
    expect(isPublicPath("/api/authentication")).toBe(false);
  });

  // ── Paths outside the catalogue are never public here ───────────────────

  it("does not treat the cart as public", () => {
    expect(isPublicApiPath("/api/cart")).toBe(false);
  });

  it("does not treat the orders as public", () => {
    expect(isPublicApiPath("/api/orders")).toBe(false);
    expect(isPublicApiPath("/api/orders/abc123")).toBe(false);
  });

  it("does not treat the customer's own account as public", () => {
    /*
     * The profile and the password are the two most sensitive things a
     * customer owns. Neither may be reachable without a session — the
     * proxy's fast filter rejects an anonymous call before it reaches
     * the database, and `requireCustomer()` in the route handler is what
     * actually authorises it.
     */
    expect(isPublicApiPath("/api/account/profile")).toBe(false);
    expect(isPublicApiPath("/api/account/password")).toBe(false);
  });

  it("does not sweep the whole account tree in with a prefix match", () => {
    /*
     * The prefix match is anchored to a segment boundary. A path that
     * merely starts with "/api/account" is a different endpoint and must
     * not be granted a session exemption by accident.
     */
    expect(isPublicApiPath("/api/accounting")).toBe(false);
    expect(isPublicApiPath("/api/account")).toBe(false);
  });

  it("does not treat an admin path as public", () => {
    expect(isPublicApiPath("/api/admin/reviews")).toBe(false);
  });
});
