import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The tracking page's surface.
 *
 * ── What is being protected ──────────────────────────────────────────────
 *
 * Three properties carry the guest tracking flow, and all three are
 * visible in the source:
 *
 *   1. **The page is inside the storefront group.** The customer who
 *      most needs to know where their parcel is is by definition not
 *      signed in, so the page has to be a **public** page — and a
 *      public page outside the storefront group is a page with no
 *      header, no footer and no way back.
 *
 *   2. **The page does not read the order on the way in.** It is
 *      static: the lookup happens when the customer submits the form.
 *      A page that read the order on the way in would have to take the
 *      order number from the URL — which puts it in the address bar, in
 *      the browser history and in the referrer of every link the
 *      customer clicks afterwards.
 *
 *   3. **The client checks the envelope before it reads the payload.**
 *      A client that reads `result.order` without checking `ok` will
 *      throw a `TypeError` on an error response, and the customer will
 *      see "cannot read properties of undefined" instead of the reason
 *      their order was not found.
 *
 * ── Why these tests read the source rather than the rendered page ────────
 *
 * The rendered page is the real proof, but it needs a running server and
 * a database. The properties being protected are properties of the
 * *shape* of the flow — where the page lives, and what the client does
 * with a response — and the shape is written in the source.
 */
function readCode(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const APP_DIR = path.join(process.cwd(), "src", "app");
const STOREFRONT_GROUP = path.join(APP_DIR, "(storefront)");
const TRACKING_PAGE = path.join(STOREFRONT_GROUP, "track-order", "page.tsx");
const TRACKING_FORM = path.join(
  process.cwd(),
  "src",
  "components",
  "commerce",
  "order-tracking-form.tsx",
);
const TRACKING_ROUTE = path.join(APP_DIR, "api", "order-tracking", "route.ts");

describe("the tracking page", () => {
  const code = readCode(TRACKING_PAGE);

  it("lives inside the storefront group", () => {
    // Outside the group it would render with no header, no footer and no
    // way back — which is exactly what a customer who is worried about
    // their parcel needs.
    expect(fs.existsSync(TRACKING_PAGE)).toBe(true);
  });

  it("asks for an order number and a contact detail", () => {
    /*
     * The page explains what the customer needs before the form asks
     * for it. The words are split across lines by JSX, so the assertion
     * is made on the parts that do not straddle a line break.
     */
    expect(code).toContain("Enter your order number");
    expect(code).toContain("email address or phone number");
  });

  it("does not take the order number from the URL", () => {
    /*
     * The order number travels by SMS and is retyped. It also must not
     * end up in the browser history or in the referrer of every link
     * the customer clicks afterwards.
     */
    expect(code).not.toContain("searchParams");
    expect(code).not.toContain("useSearchParams");
  });

  it("streams the form behind its own Suspense boundary", () => {
    /*
     * The support email is read from the database, and the read is
     * request-bound so the page around it stays prerendered — the same
     * rule the footer's contact details follow.
     */
    expect(code).toContain("<Suspense fallback=");
  });

  it("says no account is needed", () => {
    /*
     * The customer who most needs this page is the one who has no
     * account. The phrase is split across lines by JSX, so the
     * whitespace is collapsed before the assertion.
     */
    expect(code.replace(/\s+/g, " ")).toContain("no account needed");
  });
});

describe("the tracking form", () => {
  const code = readCode(TRACKING_FORM);

  it("checks the envelope before it reads the payload", () => {
    /*
     * A client that reads `result.order` without checking `ok` will
     * throw a `TypeError` on an error response, and the customer will
     * see "cannot read properties of undefined" instead of the reason
     * their order was not found.
     */
    const okIndex = code.indexOf("if (!payload.ok)");
    const orderIndex = code.indexOf("payload.data?.order");

    expect(okIndex).toBeGreaterThan(-1);
    expect(orderIndex).toBeGreaterThan(-1);
    expect(okIndex).toBeLessThan(orderIndex);
  });

  it("shows the server's own message rather than guessing", () => {
    /*
     * The server answers a wrong order number and a wrong contact
     * detail with the same message, and the form shows that message
     * verbatim. A form that tried to work out which of the two was
     * wrong would tell an attacker which half of the guess to keep.
     */
    expect(code).toContain("payload.error?.message ??");
  });

  it("sends only the order number and the contact detail", () => {
    // The contact detail is compared against what is on the order, and
    // the comparison happens on the server, where the client cannot
    // influence it.
    expect(code).toContain("JSON.stringify({ orderNumber, contact })");
  });

  it("cannot be double-fired", () => {
    /*
     * Ten failed attempts are the hourly limit, and a customer who taps
     * twice would burn two of them for one question.
     */
    expect(code).toContain("isPending");
    expect(code).toContain("disabled={isPending}");
  });

  it("says when the shop could not be reached", () => {
    // A network failure is not a "not found", and conflating the two
    // would tell a customer their order does not exist.
    expect(code).toContain("We could not reach the shop");
  });

  it("offers the support address beside a failure", () => {
    // A customer whose order number has been mislaid needs a way to
    // reach a human, and the tracking page is where they will look.
    expect(code).toContain("mailto:${supportEmail}");
  });

  it("renders the timeline, the items and the total", () => {
    expect(code).toContain("ORDER_TIMELINE_STEPS");
    expect(code).toContain("formatPaisa");
    expect(code).toContain("orderStatusNote");
  });

  it("hides the timeline for a cancelled order", () => {
    /*
     * A cancelled order is not on the journey. Rendering the timeline as
     * if it were would tell the customer their parcel is "on the way"
     * when it was cancelled.
     */
    expect(code).toContain('const cancelled = order.status === "CANCELLED"');
    expect(code).toContain("{!cancelled ? (");
  });

  it("does not import the server service into the browser bundle", () => {
    /*
     * The order's shape is declared locally rather than imported, so
     * the client bundle does not pull the service — and with it Prisma —
     * into the browser.
     */
    expect(code).not.toContain("@/lib/orders/tracking");
    expect(code).not.toContain("@prisma/client");
  });
});

describe("the tracking route", () => {
  const code = readCode(TRACKING_ROUTE);

  it("opts out of prerendering", () => {
    /*
     * This route reads the database on every request. `connection()`
     * MUST be called outside the try block: its rejection is the signal
     * that aborts prerendering.
     */
    expect(code).toContain("await connection();");
  });

  it("answers every failure with the same 404", () => {
    /*
     * A mistyped order number, a number that was never issued, and a
     * correct number with the wrong contact detail all produce the same
     * answer. If they produced different answers, the endpoint would be
     * an enumeration oracle over the shop's order numbers.
     */
    expect(code).toContain("ApiError.notFound(");
    expect(code).toContain(
      "We could not find an order matching that number and contact detail.",
    );
  });

  it("validates the body before doing any work", () => {
    expect(code).toContain("orderTrackingSchema.parse(body)");
  });

  it("returns only what a tracking page needs", () => {
    // Not the payment transaction ids, not the gateway handles, not the
    // delivery notes.
    expect(code).toContain("return ok({ order })");
  });
});
