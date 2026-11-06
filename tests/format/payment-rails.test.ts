import { describe, expect, it } from "vitest";

import {
  MOBILE_BANKING_RAILS,
  NET_BANKING_RAILS,
  RAIL_REASON_NOT_CHOSEN,
  RAIL_REASON_NOT_SUPPORTED,
  gatewayTabForMethod,
  railsForMethod,
} from "@/lib/format/payment-rails";
import { PAYMENT_GATEWAY_METHODS } from "@/lib/payments/session";

/**
 * Payment rail tests.
 *
 * This module is pure — it imports nothing — so it can be tested without
 * a DOM, a browser or React. That is the whole reason the provider
 * tables live in `src/lib/format/` and not inside the modal component.
 *
 * The tests here are the **canaries** for the two rules that are easy to
 * break by accident:
 *
 *   1. The shop can never take an order it cannot settle.
 *   2. The customer can never desynchronise the order from its own
 *      recorded payment method.
 */

describe("the mobile banking rails", () => {
  it("lists five providers", () => {
    expect(MOBILE_BANKING_RAILS).toHaveLength(5);
  });

  it("lists bKash and Nagad, in that order", () => {
    expect(MOBILE_BANKING_RAILS.map((rail) => rail.label)).toEqual([
      "bKash",
      "Nagad",
      "Rocket",
      "Upay",
      "Tap",
    ]);
  });

  it("makes exactly two of them available", () => {
    const available = MOBILE_BANKING_RAILS.filter(
      (rail) => rail.status === "available",
    );

    expect(available).toHaveLength(2);
    expect(available.map((rail) => rail.id)).toEqual(["BKASH", "NAGAD"]);
  });

  it("gives every unavailable rail a non-empty reason", () => {
    // The canary for "a greyed-out tile with no explanation is a dead
    // end the customer cannot reason about".
    for (const rail of MOBILE_BANKING_RAILS) {
      if (rail.status === "unavailable") {
        expect(rail.reason, `${rail.label} needs a reason`).toBeTruthy();
        expect((rail.reason ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("gives every available rail no reason", () => {
    // An available rail with a reason would be a contradiction — the
    // component would have nowhere sensible to render it.
    for (const rail of MOBILE_BANKING_RAILS) {
      if (rail.status === "available") {
        expect(rail.reason, `${rail.label} should have no reason`).toBeUndefined();
      }
    }
  });
});

describe("the net banking rails", () => {
  it("lists five banks", () => {
    expect(NET_BANKING_RAILS).toHaveLength(5);
  });

  it("lists the banks the reference design names", () => {
    expect(NET_BANKING_RAILS.map((rail) => rail.label)).toEqual([
      "Islami Bank",
      "City Touch",
      "MTB",
      "Bank Asia",
      "EBL",
    ]);
  });

  it("makes every one of them unavailable", () => {
    // The canary for the "a tab the customer can click and the server
    // cannot settle is worse than no tab" rule. There is no net-banking
    // rail in the `PaymentMethod` enum, no bank-reference column and no
    // merchant account — so nothing here may ever be actionable.
    for (const rail of NET_BANKING_RAILS) {
      expect(rail.status, `${rail.label} must not be selectable`).toBe(
        "unavailable",
      );
    }
  });

  it("gives every unavailable rail a non-empty reason", () => {
    for (const rail of NET_BANKING_RAILS) {
      expect(rail.reason, `${rail.label} needs a reason`).toBeTruthy();
      expect((rail.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("says the same thing for every bank", () => {
    for (const rail of NET_BANKING_RAILS) {
      expect(rail.reason).toBe(RAIL_REASON_NOT_SUPPORTED);
    }
  });
});

describe("the tab a method opens on", () => {
  it("opens the cards tab for a card order", () => {
    expect(gatewayTabForMethod("CARD")).toBe("cards");
  });

  it("opens the mobile banking tab for bKash and Nagad", () => {
    expect(gatewayTabForMethod("BKASH")).toBe("mobile");
    expect(gatewayTabForMethod("NAGAD")).toBe("mobile");
  });

  it("maps every gateway method to a tab", () => {
    // The gateway methods list cannot drift from the tabs. A method
    // added to the enum must not open a window with no tab selected.
    for (const method of PAYMENT_GATEWAY_METHODS) {
      expect(
        ["cards", "mobile", "net"],
        `${method} must map to a tab`,
      ).toContain(gatewayTabForMethod(method));
    }
  });

  it("falls back to the cards tab for anything it does not know", () => {
    // The function is total. A method the window does not recognise
    // opens a window rather than crashing the checkout.
    expect(gatewayTabForMethod("SOMETHING_NEW")).toBe("cards");
    expect(gatewayTabForMethod("COD")).toBe("cards");
  });
});

describe("the rails resolved against a method", () => {
  it("keeps the recorded method available", () => {
    const rails = railsForMethod("BKASH");

    const bkash = rails.find((rail) => rail.id === "BKASH");

    expect(bkash?.status).toBe("available");
  });

  it("disables the mobile rail that was not chosen", () => {
    // The canary for the reconciliation bug.
    //
    // `settleGatewayPayment` reads `order.paymentMethod` from the
    // database and never accepts a method from the client. So if this
    // grid let the customer switch bKash for Nagad, the settle would
    // succeed while the order row still said `BKASH` — and the shop
    // would reconcile a bKash transfer against a Nagad order.
    const rails = railsForMethod("BKASH");

    const nagad = rails.find((rail) => rail.id === "NAGAD");

    expect(nagad?.status).toBe("unavailable");
    expect(nagad?.reason).toBe(RAIL_REASON_NOT_CHOSEN);
  });

  it("gives the two rails different reasons for different methods", () => {
    const forNagad = railsForMethod("NAGAD");
    const nagad = forNagad.find((rail) => rail.id === "NAGAD");
    const bkash = forNagad.find((rail) => rail.id === "BKASH");

    expect(nagad?.status).toBe("available");
    expect(bkash?.reason).toBe(RAIL_REASON_NOT_CHOSEN);
  });

  it("leaves the unsupported providers unavailable whatever the method", () => {
    // Rocket is not supported by the shop — that is a fact about the
    // shop, not about the order. It must not be flipped to available
    // by the method resolution.
    const rails = railsForMethod("BKASH");

    const rocket = rails.find((rail) => rail.id === "ROCKET");

    expect(rocket?.status).toBe("unavailable");
    expect(rocket?.reason).toBe(RAIL_REASON_NOT_SUPPORTED);
  });

  it("disables both wallets when the order is not a mobile-banking order", () => {
    // A card order did not choose a wallet, so neither wallet is "the
    // method chosen at checkout".
    const rails = railsForMethod("CARD");

    for (const rail of rails) {
      if (rail.status === "available") {
        expect(rail.id).not.toBe("BKASH");
        expect(rail.id).not.toBe("NAGAD");
      }
    }
  });

  it("returns every provider, so the grid never shrinks", () => {
    expect(railsForMethod("BKASH")).toHaveLength(
      MOBILE_BANKING_RAILS.length,
    );
  });
});
