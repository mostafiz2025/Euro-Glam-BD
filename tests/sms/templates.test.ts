import { describe, expect, it } from "vitest";

import {
  buildDepletionReminderBody,
  buildManualResendBody,
  buildOrderLink,
} from "@/lib/sms/templates";

/**
 * The SMS body.
 *
 * Two rules govern this file, and both are security rules:
 *
 *   1. **A body must never contain a shipping address.** An SMS is
 *      forwarded, and it sits in a phone's notification list where
 *      anyone glancing at the screen can read it. A full name, a street
 *      address and a phone number are three separate pieces of personal
 *      data, and none of them is needed to say "your product is running
 *      out".
 *
 *   2. **There is no "Reply STOP to opt out" line.** The system cannot
 *      yet honour a STOP, so the line would be a promise it cannot keep
 *      — and a promise it cannot keep is worse than no instruction at
 *      all, because a customer who replies STOP has been told their
 *      objection was received, and then nothing happens.
 */

const input = {
  orderNumber: "EGB-20261027-A1B2C3",
  productName: "Niacinamide 10% Serum",
  orderId: "order-1",
};

describe("buildDepletionReminderBody", () => {
  it("names the product", () => {
    expect(buildDepletionReminderBody(input)).toContain(
      "Niacinamide 10% Serum",
    );
  });

  it("names the order number", () => {
    expect(buildDepletionReminderBody(input)).toContain(
      "EGB-20261027-A1B2C3",
    );
  });

  it("includes the order link", () => {
    expect(buildDepletionReminderBody(input)).toContain(
      "/orders/order-1",
    );
  });

  it("is deterministic", () => {
    expect(buildDepletionReminderBody(input)).toBe(
      buildDepletionReminderBody(input),
    );
  });

  it("contains no shipping address", () => {
    const body = buildDepletionReminderBody(input);

    // The words that would signal an address.
    for (const marker of [
      "address",
      "Address",
      "house",
      "House",
      "road",
      "Road",
      "street",
      "Street",
      "flat",
      "Flat",
      "block",
      "Block",
      "floor",
      "Floor",
      "postcode",
      "Postcode",
      "zip",
      "Dhaka",
      "dhaka",
    ]) {
      expect(body).not.toContain(marker);
    }
  });

  it("contains no phone number", () => {
    const body = buildDepletionReminderBody(input);

    expect(body).not.toContain("+880");
    expect(body).not.toMatch(/\b01[3-9]\d{8}\b/);
  });

  it("contains no opt-out instruction", () => {
    const body = buildDepletionReminderBody(input);

    expect(body).not.toMatch(/STOP/i);
    expect(body).not.toMatch(/opt out/i);
    expect(body).not.toMatch(/unsubscribe/i);
  });

  it("contains no customer name", () => {
    // The template does not receive one, so it cannot leak one. This
    // is a guard against a future change adding a name parameter.
    const body = buildDepletionReminderBody(input);

    expect(body).not.toMatch(/Dear/);
    expect(body).not.toMatch(/Hello/);
  });
});

describe("buildManualResendBody", () => {
  it("carries the same content as the automated reminder", () => {
    // A manual resend is a reminder the admin sent by hand, not a
    // different message.
    expect(buildManualResendBody(input)).toBe(
      buildDepletionReminderBody(input),
    );
  });

  it("contains no opt-out instruction", () => {
    expect(buildManualResendBody(input)).not.toMatch(/STOP/i);
  });
});

describe("buildOrderLink", () => {
  it("builds a link from the site URL", () => {
    const link = buildOrderLink("order-1");

    expect(link).toMatch(/^https?:\/\/.+\/orders\/order-1$/);
  });

  it("never leaves a trailing slash on the site URL", () => {
    const original = process.env.NEXT_PUBLIC_SITE_URL;

    try {
      process.env.NEXT_PUBLIC_SITE_URL = "https://example.com///";

      expect(buildOrderLink("order-1")).toBe(
        "https://example.com/orders/order-1",
      );
    } finally {
      if (original === undefined) {
        delete process.env.NEXT_PUBLIC_SITE_URL;
      } else {
        process.env.NEXT_PUBLIC_SITE_URL = original;
      }
    }
  });

  it("falls back to the default site URL when the variable is unset", () => {
    const original = process.env.NEXT_PUBLIC_SITE_URL;

    try {
      delete process.env.NEXT_PUBLIC_SITE_URL;

      expect(buildOrderLink("order-1")).toBe(
        "https://euroglambd.com/orders/order-1",
      );
    } finally {
      if (original !== undefined) {
        process.env.NEXT_PUBLIC_SITE_URL = original;
      }
    }
  });
});
