import { describe, expect, it } from "vitest";

import { PAYMENT_OPTIONS } from "@/components/commerce/payment-method-selector";
import { PAYMENT_GATEWAY_METHODS } from "@/lib/payments/session";
import { PAYMENT_METHODS } from "@/lib/validation/commerce";

/**
 * The checkout's payment options.
 *
 * The selector's table is exported precisely so it can be checked
 * without a DOM. The **shape** of the choice — two options, one of
 * them cash, one of them the gateway — is a rule about what the shop
 * is willing to offer, and it is the kind of rule that gets broken by
 * a well-meaning edit ("let's also offer Rocket").
 *
 * The tests below are the canaries for the three things that must stay
 * true:
 *
 *   1. The checkout offers **two** options, not four.
 *   2. The online option is a **gateway** method, so the server mints a
 *      session and the customer is handed to SSLCOMMERZ.
 *   3. The online option **bundles** the rails — bKash, Nagad and the
 *      card networks are named in one card, and none of them is a
 *      separate radio button.
 */

/**
 * The option values, in the order they are offered.
 */
function optionValues(): string[] {
  return PAYMENT_OPTIONS.map((option) => option.value);
}

describe("the checkout's payment options", () => {
  it("offers exactly two options", () => {
    // Four options is the old model — one card per operator. The
    // gateway now presents bKash, Nagad and the card networks itself,
    // so the customer is choosing *how* to pay, not *which* operator.
    expect(PAYMENT_OPTIONS).toHaveLength(2);
  });

  it("offers cash on delivery first", () => {
    // COD is the platform's default (DECISIONS.md #4) and the method
    // most of the shop's customers use, so it leads.
    expect(optionValues()[0]).toBe("COD");
  });

  it("names the online option for what it is", () => {
    const online = PAYMENT_OPTIONS[1];

    expect(online).toBeDefined();
    expect(online?.label).toBe("Online Payment");
  });

  it("records the online option as a gateway method", () => {
    // The server mints a gateway session for exactly these methods
    // (`isGatewayMethod`). If the online option recorded something
    // outside that list, the order would be placed with **no** session
    // and the customer would be sent to their order page with no way
    // to pay — a silent dead end.
    const online = PAYMENT_OPTIONS[1];

    expect(online).toBeDefined();
    expect(PAYMENT_GATEWAY_METHODS).toContain(online?.value);
  });

  it("records the cash option as a non-gateway method", () => {
    // The mirror image: COD must NOT be a gateway method, or the shop
    // would try to open a payment session for a cash order.
    const cash = PAYMENT_OPTIONS[0];

    expect(cash).toBeDefined();
    expect(PAYMENT_GATEWAY_METHODS).not.toContain(cash?.value);
  });

  it("bundles bKash, Nagad and the card networks into the online option", () => {
    // The whole point of the bundled option: the customer is told that
    // all three are available, without being asked to choose between
    // them here.
    const online = PAYMENT_OPTIONS[1];

    expect(online?.detail).toMatch(/bKash/i);
    expect(online?.detail).toMatch(/Nagad/i);
    expect(online?.detail).toMatch(/SSLCommerz/i);
  });

  it("offers no separate bKash, Nagad or Card radio buttons", () => {
    // The regression this file exists to prevent. An inline wallet
    // button is a second, nested choice on a page that is supposed to
    // read as one clean decision — and it asks the customer to pick an
    // operator the gateway has not asked them to pick yet.
    expect(optionValues()).not.toContain("BKASH");
    expect(optionValues()).not.toContain("NAGAD");
  });

  it("records every option with a method the server accepts", () => {
    // A typo in an option's value would be a silent failure: the
    // checkout would post a method the order schema rejects, and the
    // customer would see a validation error with no way to tell why.
    for (const option of PAYMENT_OPTIONS) {
      expect(PAYMENT_METHODS).toContain(option.value);
    }
  });

  it("gives every option a label, a description and a detail line", () => {
    // An option with an empty description renders as a bare card with
    // no explanation, which is a guess the customer has to make.
    for (const option of PAYMENT_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
      expect(option.detail.length).toBeGreaterThan(0);
    }
  });

  it("gives every option a distinct value", () => {
    // Two options sharing a value would make the radio group
    // unusable — selecting one would select both, and the customer
    // could not choose the other.
    const values = optionValues();

    expect(new Set(values).size).toBe(values.length);
  });
});
