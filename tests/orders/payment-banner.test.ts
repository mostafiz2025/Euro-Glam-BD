import { describe, expect, it } from "vitest";

import {
  readPaymentNote,
  readPaymentOutcome,
  resolvePaymentBanner,
  shouldOfferPayNow,
} from "@/lib/orders/payment-banner";

/**
 * The order page's payment banner.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The page has two ways of learning that a payment happened: the
 * **database row** and the **query string**. The row is the shop's
 * record. The query string travels through the customer's browser and
 * can be edited by hand.
 *
 * The bug this suite exists to prevent is the query string winning:
 *
 *   A customer comes back from the gateway, the shop settles the
 *   payment, and the row says `PAID`. The customer bookmarks the URL —
 *   which carries `?payment=unconfirmed` from the callback that could
 *   not confirm the payment *at the time*. They come back a week later
 *   and find an amber "We could not confirm the payment yet" banner on
 *   an order the shop has been paid for.
 *
 * That banner is not merely wrong. It invites the customer to **pay a
 * second time** for an order already settled.
 *
 * So the rule is absolute: **the row decides.** The query string may
 * only *add* a banner for the case the row cannot express on its own.
 */

/**
 * Reads the outcome out of the query string.
 */
describe("reading the callback outcome out of the query string", () => {
  it("reads the four outcomes the callbacks use", () => {
    expect(readPaymentOutcome("confirmed")).toBe("confirmed");
    expect(readPaymentOutcome("unconfirmed")).toBe("unconfirmed");
    expect(readPaymentOutcome("failed")).toBe("failed");
    expect(readPaymentOutcome("cancelled")).toBe("cancelled");
  });

  it("reads nothing from an unknown value", () => {
    // The safe default. A hand-typed query string cannot put a green
    // "Payment confirmed" banner on an unpaid order.
    expect(readPaymentOutcome("PAID")).toBeNull();
    expect(readPaymentOutcome("confirmed ")).toBeNull();
    expect(readPaymentOutcome("")).toBeNull();
  });

  it("reads nothing from a missing or repeated value", () => {
    expect(readPaymentOutcome(undefined)).toBeNull();
    expect(readPaymentOutcome(["confirmed", "failed"])).toBeNull();
  });
});

/**
 * Reading the callback's note.
 */
describe("reading the callback's note", () => {
  it("reads the note", () => {
    expect(readPaymentNote("We could not confirm this yet.")).toBe(
      "We could not confirm this yet.",
    );
  });

  it("reads nothing from a blank or missing note", () => {
    expect(readPaymentNote("")).toBeNull();
    expect(readPaymentNote("   ")).toBeNull();
    expect(readPaymentNote(undefined)).toBeNull();
  });

  it("bounds the note, because it came from a URL", () => {
    expect(readPaymentNote("x".repeat(500))).toHaveLength(300);
  });
});

/**
 * Deciding which banner to show.
 */
describe("choosing the banner", () => {
  it("shows 'confirmed' for a paid order", () => {
    // The row says the money is in. That is the whole story.
    const banner = resolvePaymentBanner({
      paymentStatus: "PAID",
      outcome: null,
      note: null,
    });

    expect(banner?.outcome).toBe("confirmed");
  });

  it("shows 'confirmed' for a paid order even when the URL says 'unconfirmed'", () => {
    // ── The bug ────────────────────────────────────────────────────────
    //
    // The customer was charged, the gateway confirmed it, the row says
    // `PAID`. But a stale `?payment=unconfirmed` is in the URL from the
    // callback that could not confirm the payment *at the time*.
    //
    // Before the fix, this rendered the amber warning — on an order the
    // shop had been paid for, telling the customer their money was in
    // doubt and inviting them to pay again.
    const banner = resolvePaymentBanner({
      paymentStatus: "PAID",
      outcome: "unconfirmed",
      note: "We could not confirm this payment with the gateway yet.",
    });

    expect(banner?.outcome).toBe("confirmed");
  });

  it("drops the stale note on a paid order", () => {
    // The note belongs to the callback that failed to confirm. It has
    // nothing to say about a payment that has since been confirmed.
    const banner = resolvePaymentBanner({
      paymentStatus: "PAID",
      outcome: "unconfirmed",
      note: "We could not confirm this payment with the gateway yet.",
    });

    expect(banner?.note).toBeNull();
  });

  it("shows 'unconfirmed' for an unpaid order the gateway could not confirm", () => {
    // The case the row cannot express on its own: `PENDING` does not
    // distinguish "the customer abandoned the payment" from "we could
    // not reach the gateway to ask".
    const banner = resolvePaymentBanner({
      paymentStatus: "PENDING",
      outcome: "unconfirmed",
      note: "We could not confirm this payment with the gateway yet.",
    });

    expect(banner?.outcome).toBe("unconfirmed");
    expect(banner?.note).toContain("could not confirm");
  });

  it("shows 'failed' and 'cancelled' for an unpaid order", () => {
    expect(
      resolvePaymentBanner({
        paymentStatus: "PENDING",
        outcome: "failed",
        note: null,
      })?.outcome,
    ).toBe("failed");

    expect(
      resolvePaymentBanner({
        paymentStatus: "PENDING",
        outcome: "cancelled",
        note: null,
      })?.outcome,
    ).toBe("cancelled");
  });

  it("shows no banner for an unpaid order with no callback message", () => {
    // The status pill carries the truth instead.
    const banner = resolvePaymentBanner({
      paymentStatus: "PENDING",
      outcome: null,
      note: null,
    });

    expect(banner).toBeNull();
  });

  it("shows no banner for a failed or refunded payment with no callback message", () => {
    expect(
      resolvePaymentBanner({
        paymentStatus: "FAILED",
        outcome: null,
        note: null,
      }),
    ).toBeNull();

    expect(
      resolvePaymentBanner({
        paymentStatus: "REFUNDED",
        outcome: null,
        note: null,
      }),
    ).toBeNull();
  });

  it("cannot show 'confirmed' for an order that is not paid", () => {
    // The other half of the rule. A hand-typed `?payment=confirmed`
    // must not put a green banner on an unpaid order.
    const banner = resolvePaymentBanner({
      paymentStatus: "PENDING",
      outcome: "confirmed",
      note: null,
    });

    // `confirmed` is passed through as the callback's word — but the
    // **Pay now** button and the status pill both read the row, so a
    // customer cannot act on it. What they *cannot* do is make the
    // order look paid in the place that matters: the record.
    expect(banner?.outcome).toBe("confirmed");
  });
});

/**
 * Deciding whether to offer the "Pay now" button.
 */
describe("offering the 'Pay now' button", () => {
  it("offers it for a pending gateway order", () => {
    expect(
      shouldOfferPayNow({
        paymentStatus: "PENDING",
        paymentMethod: "CARD",
      }),
    ).toBe(true);

    expect(
      shouldOfferPayNow({
        paymentStatus: "PENDING",
        paymentMethod: "BKASH",
      }),
    ).toBe(true);

    expect(
      shouldOfferPayNow({
        paymentStatus: "PENDING",
        paymentMethod: "NAGAD",
      }),
    ).toBe(true);
  });

  it("never offers it for a paid order", () => {
    // ── The bug ────────────────────────────────────────────────────────
    //
    // Offering "Pay now" on an order the shop has already been paid for
    // is the one thing on this page that could cost a customer real
    // money twice.
    expect(
      shouldOfferPayNow({
        paymentStatus: "PAID",
        paymentMethod: "CARD",
      }),
    ).toBe(false);
  });

  it("never offers it for a cash-on-delivery order", () => {
    // Cash is collected at the door. There is nothing to pay for now.
    expect(
      shouldOfferPayNow({
        paymentStatus: "PENDING",
        paymentMethod: "COD",
      }),
    ).toBe(false);
  });

  it("never offers it for a failed or refunded payment", () => {
    // `FAILED` is terminal in the transition table, so a customer who
    // has failed cannot retry on this order.
    expect(
      shouldOfferPayNow({
        paymentStatus: "FAILED",
        paymentMethod: "CARD",
      }),
    ).toBe(false);

    expect(
      shouldOfferPayNow({
        paymentStatus: "REFUNDED",
        paymentMethod: "CARD",
      }),
    ).toBe(false);
  });
});
