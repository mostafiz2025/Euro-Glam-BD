import { describe, expect, it } from "vitest";

import {
  ADMIN_NAV_ITEMS,
  isActiveNavItem,
} from "@/components/admin/shell/admin-nav-items";

/**
 * The admin navigation.
 *
 * The nav is the console's table of contents, so two things matter
 * about it: that every link points at a page that exists, and that the
 * active state is right. A link to a page that does not exist is a
 * 404 with a nav label on it; an active state that is wrong sends the
 * operator to the wrong section believing they are somewhere else.
 */
describe("ADMIN_NAV_ITEMS", () => {
  it("lists every admin section", () => {
    const hrefs = ADMIN_NAV_ITEMS.map((item) => item.href);

    expect(hrefs).toContain("/admin");
    expect(hrefs).toContain("/admin/analytics");
    expect(hrefs).toContain("/admin/products");
    expect(hrefs).toContain("/admin/orders");
    expect(hrefs).toContain("/admin/reviews");
    expect(hrefs).toContain("/admin/promos");
    expect(hrefs).toContain("/admin/categories");
    expect(hrefs).toContain("/admin/concerns");
    expect(hrefs).toContain("/admin/brands");
    expect(hrefs).toContain("/admin/hero-banners");
    expect(hrefs).toContain("/admin/users");
    expect(hrefs).toContain("/admin/audit-logs");
    expect(hrefs).toContain("/admin/settings");
  });

  it("lists all thirteen sections", () => {
    expect(ADMIN_NAV_ITEMS).toHaveLength(13);
  });

  it("places Analytics directly below Dashboard", () => {
    const labels = ADMIN_NAV_ITEMS.map((item) => item.label);

    expect(labels[0]).toBe("Dashboard");
    expect(labels[1]).toBe("Analytics");
  });

  it("has no duplicate hrefs", () => {
    const hrefs = ADMIN_NAV_ITEMS.map((item) => item.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("gives every item a label, a description and an icon", () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.icon).toBeDefined();
    }
  });
});

describe("isActiveNavItem", () => {
  it("matches the dashboard exactly", () => {
    expect(isActiveNavItem("/admin", "/admin")).toBe(true);
    expect(isActiveNavItem("/admin", "/admin/")).toBe(true);
  });

  it("does not match the dashboard on a child path", () => {
    // "/admin/analytics" is its own section, so the Dashboard must not
    // also light up.
    expect(isActiveNavItem("/admin", "/admin/analytics")).toBe(false);
  });

  it("matches a section's whole subtree", () => {
    expect(isActiveNavItem("/admin/orders", "/admin/orders")).toBe(true);
    expect(isActiveNavItem("/admin/orders", "/admin/orders/123")).toBe(true);
  });

  it("does not match a section on a similarly-named sibling", () => {
    // The prefix is anchored to a path segment, so "/admin/ordersx"
    // is not the orders section.
    expect(isActiveNavItem("/admin/orders", "/admin/ordersx")).toBe(false);
  });

  it("matches the analytics section on its own path", () => {
    expect(isActiveNavItem("/admin/analytics", "/admin/analytics")).toBe(
      true,
    );
  });

  it("does not match the analytics section on the dashboard", () => {
    expect(isActiveNavItem("/admin/analytics", "/admin")).toBe(false);
  });
});
