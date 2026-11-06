import { describe, expect, it } from "vitest";

import {
  paidByLabel,
  paidByShortLabel,
  paymentMethodLabel,
  paymentMethodNote,
} from "@/lib/format/payment";

/**
 * The customer-facing payment labels.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The order page shows the same payment in two places, and the two want
 * different words:
 *
 *   - The **summary line** says what the customer chose: "bKash",
 *     "Nagad", "Card Payment".
 *   - The **paid badge** says that it is done **and** by what: "Paid by
 *     bKash", "Paid by Nagad", "Card Payment".
 *
 * The badge names the rail because that is the question a customer asks
 * when they check their bank statement: *which one was I debited by?*
 * A badge reading only "Paid" cannot answer it, and a badge reading
 * "Card Payment" on a bKash payment is not merely unhelpful — it looks
 * wrong.
 *
 * These labels are pure functions over the `PaymentMethod` enum, so
 * they need no database and no browser. That is deliberate: the whole
 * point of `src/lib/format/payment.ts` is to be the **one** place that
 * knows how to say a method in English.
 */
describe("the payment method label", () => {
  it("names every method the enum holds", () => {
    expect(paymentMethodLabel("COD")).toBe("Cash on Delivery");
    expect(paymentMethodLabel("BKASH")).toBe("bKash");
    expect(paymentMethodLabel("NAGAD")).toBe("Nagad");
    expect(paymentMethodLabel("CARD")).toBe("Card Payment");
  });

  it("falls back to the raw code for a method it does not know", () => {
    // A blank label would render an empty row; the raw code is at least
    // honest about what the database says.
    expect(paymentMethodLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("the paid badge label", () => {
  it("names bKash", () => {
    // The customer checks their statement. The statement says bKash.
    // The badge must say the same word.
    expect(paidByLabel("BKASH")).toBe("Paid by bKash");
  });

  it("names Nagad", () => {
    expect(paidByLabel("NAGAD")).toBe("Paid by Nagad");
  });

  it("says 'Card Payment' for a card", () => {
    // A card payment has no provider to name — the customer chose
    // "pay by card", so the badge says what they chose. Adding "Paid by
    // card" would be claiming a rail the customer did not pick.
    expect(paidByLabel("CARD")).toBe("Card Payment");
  });

  it("says 'Cash on Delivery' for cash", () => {
    // There is no "paid by cash" — the money is collected at the door,
    // and a cash order is never marked paid. The label still has to
    // exist, so the badge can never render "Paid by undefined".
    expect(paidByLabel("COD")).toBe("Cash on Delivery");
  });

  it("falls back to the raw code for a method it does not know", () => {
    expect(paidByLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("never says 'Paid by undefined' for anything", () => {
    // The canary. An undefined leaking into the badge would be a
    // visible bug on the page a customer lands on after paying.
    for (const method of ["COD", "BKASH", "NAGAD", "CARD", "", "UNKNOWN"]) {
      expect(paidByLabel(method)).not.toContain("undefined");
      expect(paidByLabel(method).length).toBeGreaterThan(0);
    }
  });
});

describe("the short paid label", () => {
  it("drops the 'Paid by' for the mobile wallets", () => {
    // The short form is for the tighter places — a notification, an
    // admin row — where "Paid by bKash" does not fit.
    expect(paidByShortLabel("BKASH")).toBe("bKash");
    expect(paidByShortLabel("NAGAD")).toBe("Nagad");
  });

  it("keeps the full form for a card", () => {
    expect(paidByShortLabel("CARD")).toBe("Card Payment");
    expect(paidByShortLabel("COD")).toBe("Cash on Delivery");
  });

  it("never says 'Paid by undefined' for anything", () => {
    for (const method of ["COD", "BKASH", "NAGAD", "CARD", "", "UNKNOWN"]) {
      expect(paidByShortLabel(method)).not.toContain("undefined");
    }
  });
});

describe("the payment note", () => {
  it("says the money is in when the gateway settled it", () => {
    expect(paymentMethodNote("BKASH", true)).toContain("confirmed");
    expect(paymentMethodNote("NAGAD", true)).toContain("confirmed");
    expect(paymentMethodNote("CARD", true)).toContain("confirmed");
  });

  it("says it will be verified when the gateway has not settled it", () => {
    // A pending mobile-banking order has not been paid yet — the
    // customer is told the truth about what happens next.
    expect(paymentMethodNote("BKASH", false)).toContain("verify");
    expect(paymentMethodNote("NAGAD", false)).toContain("verify");
  });

  it("never promises a confirmation for an unsettled card order", () => {
    // A card order that has not settled is still waiting on the
    // gateway, and the note must not imply the money is in.
    expect(paymentMethodNote("CARD", false)).not.toContain("confirmed");
  });

  it("always has something to say", () => {
    for (const method of ["COD", "BKASH", "NAGAD", "CARD", "UNKNOWN"]) {
      expect(paymentMethodNote(method).length).toBeGreaterThan(0);
    }
  });
});
