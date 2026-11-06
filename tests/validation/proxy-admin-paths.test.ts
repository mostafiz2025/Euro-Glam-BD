import { describe, expect, it } from "vitest";

import { isAdminApiPath, isAdminPagePath } from "@/proxy";

/**
 * The proxy's admin routing decision.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The admin surface has **two** halves that must both be closed:
 *
 *   1. `/api/admin/*` — the JSON endpoints. A customer who reaches one
 *      gets a `403` with an error envelope.
 *   2. `/admin/*` — the dashboard pages. A customer who reaches one is
 *      redirected.
 *
 * The second is the one that regresses silently. When the admin surface
 * was API-only, guarding `/api/admin` was enough. The moment pages
 * were added under `/admin`, a proxy that only knew about the API prefix
 * stopped protecting anything the customer could actually *see* — the
 * dashboard shell rendered, the navigation rendered, and only the
 * queries beneath it failed.
 *
 * A layout that redirects a non-admin away is the *authoritative* gate
 * (it re-reads the role from the database), but the proxy should still
 * catch the obvious mistake first. A control that only works in one
 * layer is a control that silently stops working when the other layer
 * changes.
 *
 * The prefix match is anchored to a **path segment**, so `/administrator`
 * is not the dashboard.
 */
describe("isAdminApiPath", () => {
  it("matches the admin API root", () => {
    expect(isAdminApiPath("/api/admin")).toBe(true);
  });

  it("matches every admin API route", () => {
    expect(isAdminApiPath("/api/admin/stats")).toBe(true);
    expect(isAdminApiPath("/api/admin/products")).toBe(true);
    expect(isAdminApiPath("/api/admin/products/abc123/stock")).toBe(true);
    expect(isAdminApiPath("/api/admin/reviews/abc123")).toBe(true);
    expect(isAdminApiPath("/api/admin/orders/abc123/status")).toBe(true);
    expect(isAdminApiPath("/api/admin/sms/log")).toBe(true);
  });

  it("does not match a similarly-named path", () => {
    // The prefix is anchored to a path segment, so a route that merely
    // *starts* with the same letters is a different route.
    expect(isAdminApiPath("/api/administrator")).toBe(false);
    expect(isAdminApiPath("/api/admin-tools")).toBe(false);
  });

  it("does not match the storefront or the customer API", () => {
    expect(isAdminApiPath("/api/products")).toBe(false);
    expect(isAdminApiPath("/api/cart")).toBe(false);
    expect(isAdminApiPath("/api/orders")).toBe(false);
    expect(isAdminApiPath("/api/auth/logout")).toBe(false);
  });
});

describe("isAdminPagePath", () => {
  it("matches the dashboard root", () => {
    expect(isAdminPagePath("/admin")).toBe(true);
  });

  it("matches every admin page", () => {
    expect(isAdminPagePath("/admin/products")).toBe(true);
    expect(isAdminPagePath("/admin/reviews")).toBe(true);
    expect(isAdminPagePath("/admin/orders")).toBe(true);
  });

  it("does not match a similarly-named path", () => {
    // `/administrator` is not the dashboard. Locking a page that has
    // nothing to do with administration would be a bug, not caution.
    expect(isAdminPagePath("/administrator")).toBe(false);
    expect(isAdminPagePath("/admin-tools")).toBe(false);
  });

  it("does not match the storefront pages", () => {
    expect(isAdminPagePath("/")).toBe(false);
    expect(isAdminPagePath("/account")).toBe(false);
    expect(isAdminPagePath("/cart")).toBe(false);
    expect(isAdminPagePath("/checkout")).toBe(false);
    expect(isAdminPagePath("/orders")).toBe(false);
    expect(isAdminPagePath("/forbidden")).toBe(false);
  });

  it("does not match the admin API", () => {
    // The two halves are separate. The API answers with an error
    // envelope; the pages answer with a redirect.
    expect(isAdminPagePath("/api/admin")).toBe(false);
    expect(isAdminPagePath("/api/admin/stats")).toBe(false);
  });
});
