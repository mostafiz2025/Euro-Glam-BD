import { describe, expect, it } from "vitest";

import {
  orderIdFromPath,
  productIdFromPath,
} from "@/lib/catalog/existence";

/**
 * Proxy path-parsing tests.
 *
 * The proxy decides whether a request is for a product page or an order
 * page, and it does that by matching the pathname. If the match is too
 * greedy, the proxy asks the API about a resource that does not exist —
 * and a request that should have been answered with a `404` is
 * answered with a `200` instead.
 *
 * These tests pin the matching down.
 */
describe("productIdFromPath", () => {
  it("extracts the id from a product path", () => {
    expect(productIdFromPath("/products/abc123")).toBe("abc123");
  });

  it("ignores the listing page", () => {
    expect(productIdFromPath("/products")).toBeNull();
  });

  it("ignores a nested path", () => {
    // `/products/abc/reviews` is not a product page. Matching it would
    // send the proxy asking the catalogue about "abc/reviews".
    expect(productIdFromPath("/products/abc/reviews")).toBeNull();
  });

  it("ignores an unrelated path", () => {
    expect(productIdFromPath("/cart")).toBeNull();
    expect(productIdFromPath("/account")).toBeNull();
    expect(productIdFromPath("/api/products/abc")).toBeNull();
  });

  it("rejects an empty id", () => {
    expect(productIdFromPath("/products/")).toBeNull();
    expect(productIdFromPath("/products/%20")).toBeNull();
  });

  it("decodes a percent-encoded id", () => {
    expect(productIdFromPath("/products/abc%20def")).toBe("abc def");
  });

  it("ignores a trailing slash", () => {
    // A trailing slash makes the segment "abc/" — the id, with a slash
    // stuck to it. It is not the same id, so it must not match.
    expect(productIdFromPath("/products/abc/")).toBeNull();
  });

  it("does not throw on a malformed percent-escape", () => {
    /*
     * `decodeURIComponent` throws a `URIError` on a percent sign that is
     * not followed by two hex digits. Those segments arrive on real
     * requests — a mistyped link, a crawler probing for escaping, a
     * truncated bookmark — and the proxy decodes the segment on every
     * product page request.
     *
     * An uncaught `URIError` in the proxy is a **500**: the route dies
     * before the page renders, instead of showing a not-found page.
     *
     * A malformed segment is not a product id, so the answer is `null` —
     * the same answer given for a path that does not match at all. The
     * proxy then makes no existence check, and the page renders its own
     * not-found UI.
     */
    expect(() => productIdFromPath("/products/%")).not.toThrow();
    expect(productIdFromPath("/products/%")).toBeNull();
    expect(productIdFromPath("/products/%zz")).toBeNull();
    expect(productIdFromPath("/products/%E0%A4")).toBeNull();
  });
});

describe("orderIdFromPath", () => {
  it("extracts the id from an order path", () => {
    expect(orderIdFromPath("/orders/xyz789")).toBe("xyz789");
  });

  it("ignores the account page", () => {
    expect(orderIdFromPath("/account")).toBeNull();
    expect(orderIdFromPath("/orders")).toBeNull();
  });

  it("ignores an unrelated path", () => {
    expect(orderIdFromPath("/cart")).toBeNull();
    expect(orderIdFromPath("/api/orders/abc")).toBeNull();
  });

  it("rejects an empty id", () => {
    expect(orderIdFromPath("/orders/")).toBeNull();
    expect(orderIdFromPath("/orders/%20")).toBeNull();
  });

  it("decodes a percent-encoded id", () => {
    expect(orderIdFromPath("/orders/abc%20def")).toBe("abc def");
  });

  it("ignores a nested path", () => {
    expect(orderIdFromPath("/orders/abc/items")).toBeNull();
  });

  it("does not throw on a malformed percent-escape", () => {
    // Same reasoning as the product matcher: a malformed escape must
    // read as "not an order page", never as a server error.
    expect(() => orderIdFromPath("/orders/%")).not.toThrow();
    expect(orderIdFromPath("/orders/%")).toBeNull();
    expect(orderIdFromPath("/orders/%zz")).toBeNull();
  });
});

describe("the two matchers do not overlap", () => {
  it("a product path is not an order path", () => {
    expect(orderIdFromPath("/products/abc")).toBeNull();
  });

  it("an order path is not a product path", () => {
    expect(productIdFromPath("/orders/abc")).toBeNull();
  });
});
