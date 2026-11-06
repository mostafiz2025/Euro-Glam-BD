import { describe, expect, it } from "vitest";

import {
  emailMatches,
  normaliseOrderNumber,
  phoneMatches,
  phoneNationalDigits,
} from "@/lib/format/order-tracking";
import {
  isOrderCancelled,
  ORDER_STATUS_LABELS,
  ORDER_STATUS_NOTES,
  ORDER_STATUS_TONES,
  ORDER_TIMELINE_STEPS,
  orderStatusLabel,
  orderStatusNote,
  orderStatusTone,
  orderTimelineIndex,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONES,
  paymentStatusLabel,
  paymentStatusTone,
} from "@/lib/format/order-status";
import {
  MAX_TRACKING_ATTEMPTS_PER_HOUR,
  orderTrackingSchema,
} from "@/lib/validation/tracking";

/**
 * The guest order-tracking vocabulary.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The tracking page is a **public** endpoint, and it has to answer a
 * customer who has typed something by hand on a phone. Three properties
 * carry the whole design, and all three are pure functions:
 *
 *   1. **The order number is normalised, not validated.** The number
 *      travels by SMS and is retyped. "EGB-20261027-A1B2C3",
 *      "egb 20261027 a1b2c3" and "EGB20261027A1B2C3" are the same
 *      number, and a form that refused two of them would be refusing
 *      to help.
 *
 *   2. **A phone is compared on its digits.** The checkout stores
 *      `+8801712345678` and an admin-created telephone order stores
 *      whatever the operator typed. A string comparison would fail to
 *      match the *same* number in two spellings.
 *
 *   3. **The statuses are said in words.** `PROCESSING` is what the
 *      database calls it; "Preparing" is what it means.
 *
 * All three are pure, so none of them needs a database — which is the
 * point of putting them in `src/lib/format` rather than in the service.
 */
describe("normaliseOrderNumber", () => {
  it("leaves the canonical form alone", () => {
    expect(normaliseOrderNumber("EGB-20261027-A1B2C3")).toBe(
      "EGB-20261027-A1B2C3",
    );
  });

  it("upper-cases a number typed in caps-lock", () => {
    expect(normaliseOrderNumber("egb-20261027-a1b2c3")).toBe(
      "EGB-20261027-A1B2C3",
    );
  });

  it("accepts spaces instead of hyphens", () => {
    // The number arrives by SMS and is retyped from a screenshot.
    expect(normaliseOrderNumber("EGB 20261027 A1B2C3")).toBe(
      "EGB-20261027-A1B2C3",
    );
  });

  it("accepts the hyphens stripped entirely", () => {
    // A paste from a document, where the hyphens were formatting.
    expect(normaliseOrderNumber("EGB20261027A1B2C3")).toBe(
      "EGB-20261027-A1B2C3",
    );
  });

  it("ignores surrounding whitespace", () => {
    expect(normaliseOrderNumber("  EGB-20261027-A1B2C3  ")).toBe(
      "EGB-20261027-A1B2C3",
    );
  });

  it("returns null for a number that is not shaped like one", () => {
    // `null` is a real answer, not a failure: the caller answers exactly
    // as it answers for a number that was never issued, so the endpoint
    // cannot be used to probe the shape of the shop's order numbers.
    expect(normaliseOrderNumber("not an order number")).toBeNull();
    expect(normaliseOrderNumber("12345")).toBeNull();
    expect(normaliseOrderNumber("")).toBeNull();
  });

  it("rejects a number with the wrong number of digits", () => {
    expect(normaliseOrderNumber("EGB-2026102-A1B2C3")).toBeNull();
    expect(normaliseOrderNumber("EGB-202610271-A1B2C3")).toBeNull();
  });

  it("rejects a number whose random part is the wrong length", () => {
    expect(normaliseOrderNumber("EGB-20261027-A1B2")).toBeNull();
    expect(normaliseOrderNumber("EGB-20261027-A1B2C3D")).toBeNull();
  });

  it("rejects a random part that is not hexadecimal", () => {
    // The shop's numbers use hex, so "GG" is not one of them.
    expect(normaliseOrderNumber("EGB-20261027-GG12ZZ")).toBeNull();
  });

  it("rejects a number with the wrong prefix", () => {
    expect(normaliseOrderNumber("ABC-20261027-A1B2C3")).toBeNull();
  });

  it("rejects a number with no date in it", () => {
    expect(normaliseOrderNumber("EGB-A1B2C3")).toBeNull();
  });
});

describe("phoneNationalDigits", () => {
  it("strips the country code from the international form", () => {
    // The checkout's normalised form.
    expect(phoneNationalDigits("+8801712345678")).toBe("1712345678");
  });

  it("strips the trunk prefix from the national form", () => {
    // The form a customer types.
    expect(phoneNationalDigits("01712345678")).toBe("1712345678");
  });

  it("leaves a bare national number alone", () => {
    expect(phoneNationalDigits("1712345678")).toBe("1712345678");
  });

  it("drops the separators a human writes", () => {
    expect(phoneNationalDigits("0171-2345678")).toBe("1712345678");
    expect(phoneNationalDigits("+880 1712 345678")).toBe("1712345678");
    expect(phoneNationalDigits("(01712) 345678")).toBe("1712345678");
  });

  it("returns the digits of a number it does not recognise", () => {
    // A landline, or a country code the shop has never seen. It simply
    // will not match — a false match would be far worse.
    expect(phoneNationalDigits("+44 20 7946 0958")).toBe("442079460958");
  });

  it("returns nothing for a value with no digits", () => {
    expect(phoneNationalDigits("")).toBe("");
    expect(phoneNationalDigits("not a number")).toBe("");
  });
});

describe("phoneMatches", () => {
  it("matches the two spellings the shop actually stores", () => {
    /*
     * The whole reason the comparison is on digits rather than on the
     * string. The checkout writes `+8801712345678`; an admin-created
     * telephone order carries whatever the operator typed. Both are the
     * same number, and both have to match the same order.
     */
    expect(phoneMatches("+8801712345678", "01712345678")).toBe(true);
    expect(phoneMatches("01712345678", "+8801712345678")).toBe(true);
  });

  it("matches a number typed with separators", () => {
    expect(phoneMatches("0171-2345678", "+8801712345678")).toBe(true);
    expect(phoneMatches("01712 345678", "01712345678")).toBe(true);
  });

  it("matches the national form against itself", () => {
    expect(phoneMatches("1712345678", "1712345678")).toBe(true);
  });

  it("does not match a different number", () => {
    expect(phoneMatches("01712345678", "01912345678")).toBe(false);
  });

  it("does not match a prefix of a number", () => {
    // The last four digits are the memorable part, and a match on a
    // prefix would let anybody who saw a parcel label look the order up.
    expect(phoneMatches("01712345678", "0171234567")).toBe(false);
  });

  it("never matches an empty number", () => {
    /*
     * "No phone on file" must not be treated as "the phone matches".
     * The account's phone is optional, and an order whose address has
     * no phone must not become an order anybody can look up by saying
     * nothing.
     */
    expect(phoneMatches("", "01712345678")).toBe(false);
    expect(phoneMatches("01712345678", "")).toBe(false);
    expect(phoneMatches("", "")).toBe(false);
  });
});

describe("emailMatches", () => {
  it("matches the same address", () => {
    expect(emailMatches("sara@example.com", "sara@example.com")).toBe(true);
  });

  it("ignores case", () => {
    // A customer typing their own address on a phone will get the case
    // wrong; the mailbox is the same one.
    expect(emailMatches("Sara@Example.com", "sara@example.com")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(emailMatches("  sara@example.com  ", "sara@example.com")).toBe(true);
  });

  it("does not match a different address", () => {
    expect(emailMatches("sara@example.com", "sara@other.com")).toBe(false);
  });

  it("never matches an empty address", () => {
    // The same rule as the phone: an absent detail is not a match.
    expect(emailMatches("", "sara@example.com")).toBe(false);
    expect(emailMatches("sara@example.com", "")).toBe(false);
    expect(emailMatches("", "")).toBe(false);
  });
});

describe("orderTrackingSchema", () => {
  it("accepts an order number and a contact detail", () => {
    const result = orderTrackingSchema.parse({
      orderNumber: "EGB-20261027-A1B2C3",
      contact: "sara@example.com",
    });

    expect(result.orderNumber).toBe("EGB-20261027-A1B2C3");
    expect(result.contact).toBe("sara@example.com");
  });

  it("trims the values", () => {
    const result = orderTrackingSchema.parse({
      orderNumber: "  EGB-20261027-A1B2C3  ",
      contact: "  sara@example.com  ",
    });

    expect(result.orderNumber).toBe("EGB-20261027-A1B2C3");
    expect(result.contact).toBe("sara@example.com");
  });

  it("refuses an empty order number", () => {
    const result = orderTrackingSchema.safeParse({
      orderNumber: "   ",
      contact: "sara@example.com",
    });

    expect(result.success).toBe(false);
  });

  it("refuses an empty contact detail", () => {
    /*
     * The contact detail is the secret. A request without one is not a
     * request to look anything up.
     */
    const result = orderTrackingSchema.safeParse({
      orderNumber: "EGB-20261027-A1B2C3",
      contact: "   ",
    });

    expect(result.success).toBe(false);
  });

  it("refuses a missing contact detail", () => {
    const result = orderTrackingSchema.safeParse({
      orderNumber: "EGB-20261027-A1B2C3",
    });

    expect(result.success).toBe(false);
  });

  it("refuses an absurdly long order number", () => {
    const result = orderTrackingSchema.safeParse({
      orderNumber: "E".repeat(200),
      contact: "sara@example.com",
    });

    expect(result.success).toBe(false);
  });

  it("refuses an absurdly long contact detail", () => {
    // An email address is up to 255 characters; anything longer is not
    // one, and it is not a phone number either.
    const result = orderTrackingSchema.safeParse({
      orderNumber: "EGB-20261027-A1B2C3",
      contact: "a".repeat(300),
    });

    expect(result.success).toBe(false);
  });

  it("strips a key the client tried to smuggle in", () => {
    /*
     * The body carries an order number and a contact detail and nothing
     * else. A `status` or `userId` key is dropped rather than honoured,
     * so a client cannot ask the server for a different answer.
     */
    const result = orderTrackingSchema.parse({
      orderNumber: "EGB-20261027-A1B2C3",
      contact: "sara@example.com",
      status: "DELIVERED",
      userId: "someone-elses-id",
    });

    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("userId");
  });
});

describe("the tracking limit", () => {
  it("is a number the shop can live with", () => {
    /*
     * Ten failures an hour is enough for a customer who has genuinely
     * forgotten their order number — which is rare — and small enough
     * that a script cannot grind a contact detail against a known order
     * number for free.
     */
    expect(MAX_TRACKING_ATTEMPTS_PER_HOUR).toBe(10);
  });
});

describe("the customer-facing order status", () => {
  it("names every status the enum holds", () => {
    expect(ORDER_STATUS_LABELS.PENDING).toBe("Order placed");
    expect(ORDER_STATUS_LABELS.PROCESSING).toBe("Preparing");
    expect(ORDER_STATUS_LABELS.SHIPPED).toBe("On the way");
    expect(ORDER_STATUS_LABELS.DELIVERED).toBe("Delivered");
    expect(ORDER_STATUS_LABELS.CANCELLED).toBe("Cancelled");
  });

  it("says what is happening, not what the code is", () => {
    /*
     * A customer who reads "PROCESSING" learns nothing: they do not know
     * whether their parcel is being packed, has been packed, or is
     * waiting for a courier.
     */
    expect(orderStatusLabel("PROCESSING")).toBe("Preparing");
    expect(orderStatusLabel("PENDING")).toBe("Order placed");
  });

  it("falls back to the raw code for a status it does not know", () => {
    // A blank label would render a blank chip; the raw code is honest.
    expect(orderStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("explains every status in a sentence", () => {
    for (const status of Object.keys(ORDER_STATUS_LABELS)) {
      expect(ORDER_STATUS_NOTES[status]).toBeTruthy();
    }
  });

  it("falls back to a sentence for a status it does not know", () => {
    const note = orderStatusNote("SOMETHING_NEW");

    expect(note.length).toBeGreaterThan(0);
    expect(note).not.toBe("SOMETHING_NEW");
  });

  it("gives every status a tone, so a chip is never unstyled", () => {
    for (const status of Object.keys(ORDER_STATUS_LABELS)) {
      expect(ORDER_STATUS_TONES[status]).toBeTruthy();
    }

    // An unknown status gets the neutral tone rather than no classes at
    // all — a chip with no border reads as a rendering fault.
    expect(orderStatusTone("SOMETHING_NEW")).toBe(
      "bg-surface-muted text-foreground-muted border-border",
    );
  });
});

describe("the payment status", () => {
  it("names every status the enum holds", () => {
    expect(PAYMENT_STATUS_LABELS.PENDING).toBe("Awaiting payment");
    expect(PAYMENT_STATUS_LABELS.PAID).toBe("Paid");
    expect(PAYMENT_STATUS_LABELS.FAILED).toBe("Payment failed");
    expect(PAYMENT_STATUS_LABELS.REFUNDED).toBe("Refunded");
  });

  it("gives every status a tone", () => {
    for (const status of Object.keys(PAYMENT_STATUS_LABELS)) {
      expect(PAYMENT_STATUS_TONES[status]).toBeTruthy();
    }

    expect(paymentStatusTone("SOMETHING_NEW")).toBe(
      "bg-surface-muted text-foreground-muted border-border",
    );
  });

  it("falls back to the raw code for a status it does not know", () => {
    expect(paymentStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("the fulfilment timeline", () => {
  it("is the journey every order takes", () => {
    expect(ORDER_TIMELINE_STEPS.map((step) => step.key)).toEqual([
      "PENDING",
      "PROCESSING",
      "SHIPPED",
      "DELIVERED",
    ]);
  });

  it("places each status on the journey", () => {
    expect(orderTimelineIndex("PENDING")).toBe(0);
    expect(orderTimelineIndex("PROCESSING")).toBe(1);
    expect(orderTimelineIndex("SHIPPED")).toBe(2);
    expect(orderTimelineIndex("DELIVERED")).toBe(3);
  });

  it("has no place for a cancelled order", () => {
    /*
     * A cancelled order is not on the journey. Rendering the timeline as
     * if it were would tell the customer their parcel is "on the way"
     * when it was cancelled.
     */
    expect(orderTimelineIndex("CANCELLED")).toBe(-1);
    expect(isOrderCancelled("CANCELLED")).toBe(true);
    expect(isOrderCancelled("SHIPPED")).toBe(false);
  });

  it("describes every step", () => {
    for (const step of ORDER_TIMELINE_STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.description.length).toBeGreaterThan(0);
    }
  });
});
