import { describe, expect, it } from "vitest";

import {
  cardBrandLabel,
  detectCardBrand,
  formatCardNumber,
  formatCvc,
  formatExpiry,
  isValidCardHolder,
  isValidCardNumber,
  isValidCvc,
  isValidExpiry,
} from "@/lib/format/card";

/**
 * The card module.
 *
 * These tests need no browser, because the module is pure arithmetic on
 * strings — which is exactly why it lives in `src/lib/format/` and not
 * in `src/lib/validation/`.
 *
 * The centre of gravity here is the **Luhn check**. A card field that
 * only counted digits would accept `4242 4242 4242 4241` — the right
 * shape, the right length, and not a card number at all. So the
 * checksum is proved in **both** directions: a known-good number
 * passes, and the same number with its last digit changed does not.
 */

describe("the card brand", () => {
  it("recognises Visa by its leading 4", () => {
    expect(detectCardBrand("4242424242424242")).toBe("visa");
    expect(detectCardBrand("4")).toBe("visa");
  });

  it("recognises the original Mastercard range, 51 to 55", () => {
    expect(detectCardBrand("5100000000000000")).toBe("mastercard");
    expect(detectCardBrand("5500000000000000")).toBe("mastercard");
  });

  it("recognises the Mastercard range the network added later", () => {
    // The 2221–2720 range. It is not optional: a Mastercard issued in
    // that range is a real card, and guessing "unknown" for it would
    // tell the customer the wrong CVC length.
    expect(detectCardBrand("2221000000000000")).toBe("mastercard");
    expect(detectCardBrand("2720000000000000")).toBe("mastercard");
  });

  it("does not mistake the edges of the Mastercard range for Mastercard", () => {
    // 2220 is below the range; 2721 is above it. A number just outside
    // the range is not a Mastercard, and claiming it was would be a
    // guess.
    expect(detectCardBrand("2220000000000000")).not.toBe("mastercard");
    expect(detectCardBrand("2721000000000000")).not.toBe("mastercard");
  });

  it("recognises American Express by its 34 and 37 prefixes", () => {
    expect(detectCardBrand("340000000000009")).toBe("amex");
    expect(detectCardBrand("370000000000009")).toBe("amex");
  });

  it("recognises Discover by its 6011, 65 and 644 to 649 prefixes", () => {
    expect(detectCardBrand("6011000000000000")).toBe("discover");
    expect(detectCardBrand("6500000000000000")).toBe("discover");
    expect(detectCardBrand("6440000000000000")).toBe("discover");
    expect(detectCardBrand("6490000000000000")).toBe("discover");
  });

  it("never guesses a brand it does not know", () => {
    // A card from a network this shop has not heard of is a perfectly
    // ordinary thing to type. A wrong guess is worse than no answer:
    // the customer would be told their card is a Mastercard and then
    // told the CVC is three digits when it needs four.
    expect(detectCardBrand("9999999999999999")).toBe("unknown");
    expect(detectCardBrand("30569309025904")).toBe("unknown");
    expect(detectCardBrand("")).toBe("unknown");
  });

  it("ignores the separators the customer types", () => {
    expect(detectCardBrand("4242 4242 4242 4242")).toBe("visa");
    expect(detectCardBrand("4242-4242-4242-4242")).toBe("visa");
  });

  it("has a human-readable label for every brand", () => {
    expect(cardBrandLabel("visa")).toBe("Visa");
    expect(cardBrandLabel("mastercard")).toBe("Mastercard");
    expect(cardBrandLabel("amex")).toBe("American Express");
    expect(cardBrandLabel("discover")).toBe("Discover");
    expect(cardBrandLabel("unknown")).toBe("Card");
  });
});

describe("the card number format", () => {
  it("groups the digits in fours", () => {
    expect(formatCardNumber("4242424242424242")).toBe("4242 4242 4242 4242");
  });

  it("groups the digits as they are typed", () => {
    expect(formatCardNumber("4242")).toBe("4242");
    expect(formatCardNumber("42424")).toBe("4242 4");
    expect(formatCardNumber("42424242")).toBe("4242 4242");
  });

  it("drops the separators the customer pasted", () => {
    expect(formatCardNumber("4242-4242-4242-4242")).toBe("4242 4242 4242 4242");
    expect(formatCardNumber("4242 4242 4242 4242")).toBe("4242 4242 4242 4242");
  });

  it("caps the number at nineteen digits", () => {
    // 19 is the longest number in circulation, so nothing longer can be
    // real — and a pasted paragraph must not produce an unbounded
    // string.
    const formatted = formatCardNumber("4".repeat(30));

    expect(formatted.replace(/\D/g, "")).toHaveLength(19);
  });
});

describe("the expiry format", () => {
  it("inserts the separator after the month", () => {
    expect(formatExpiry("09")).toBe("09");
    expect(formatExpiry("0928")).toBe("09/28");
    expect(formatExpiry("092")).toBe("09/2");
  });

  it("caps the expiry at four digits", () => {
    expect(formatExpiry("092820").replace(/\D/g, "")).toHaveLength(4);
  });
});

describe("the CVC format", () => {
  it("keeps the digits only", () => {
    expect(formatCvc("12a3")).toBe("123");
    expect(formatCvc(" 1 2 3 ")).toBe("123");
  });

  it("caps the code at four digits", () => {
    // Four is the American Express length, and a shorter cap would
    // truncate a valid Amex code.
    expect(formatCvc("123456")).toBe("1234");
  });
});

describe("the card number checksum", () => {
  it("accepts a real card number", () => {
    expect(isValidCardNumber("4242424242424242")).toBe(true);
    expect(isValidCardNumber("4242 4242 4242 4242")).toBe(true);
  });

  it("rejects the same number with one digit changed", () => {
    // This is the test that makes the field a real card field rather
    // than a digit counter. Without the checksum, this number would be
    // accepted — it has the right shape and the right length, and it is
    // not a card number at all.
    expect(isValidCardNumber("4242424242424241")).toBe(false);
  });

  it("rejects a number of the wrong length", () => {
    expect(isValidCardNumber("424242424242")).toBe(false);
    expect(isValidCardNumber("424242424242424242424242")).toBe(false);
  });

  it("rejects an empty number", () => {
    expect(isValidCardNumber("")).toBe(false);
  });

  it("rejects a number carrying letters", () => {
    expect(isValidCardNumber("4242abcd4242efgh")).toBe(false);
  });

  it("accepts a fifteen-digit American Express number", () => {
    // Amex is 15 digits, not 16. Rejecting it would reject a valid
    // card.
    expect(isValidCardNumber("378282246310005")).toBe(true);
  });
});

describe("the expiry", () => {
  /**
   * A fixed "now", so the rule can be tested without depending on the
   * day the suite runs.
   */
  const now = new Date("2026-10-15T00:00:00.000Z");

  it("accepts a future month", () => {
    expect(isValidExpiry("11/26", now)).toBe(true);
    expect(isValidExpiry("12/26", now)).toBe(true);
    expect(isValidExpiry("01/27", now)).toBe(true);
  });

  it("accepts the current month", () => {
    // A card whose expiry is this month is still valid until the end
    // of it. Rejecting it would reject a card that works today.
    expect(isValidExpiry("10/26", now)).toBe(true);
  });

  it("rejects a month that has passed", () => {
    expect(isValidExpiry("09/26", now)).toBe(false);
  });

  it("rejects a year that has passed", () => {
    expect(isValidExpiry("10/25", now)).toBe(false);
  });

  it("rejects a month that is not a month", () => {
    expect(isValidExpiry("00/26", now)).toBe(false);
    expect(isValidExpiry("13/26", now)).toBe(false);
    expect(isValidExpiry("99/26", now)).toBe(false);
  });

  it("rejects an incomplete expiry", () => {
    expect(isValidExpiry("10", now)).toBe(false);
    expect(isValidExpiry("", now)).toBe(false);
  });
});

describe("the security code", () => {
  it("accepts three digits for Visa", () => {
    expect(isValidCvc("123", "visa")).toBe(true);
  });

  it("accepts four digits for American Express", () => {
    // A three-digit Amex code is a typo, not a short code.
    expect(isValidCvc("1234", "amex")).toBe(true);
    expect(isValidCvc("123", "amex")).toBe(false);
  });

  it("rejects a four-digit code for Visa", () => {
    // The length genuinely differs, so a four-digit Visa code is a
    // typo too.
    expect(isValidCvc("1234", "visa")).toBe(false);
  });

  it("rejects letters", () => {
    expect(isValidCvc("12a", "visa")).toBe(false);
  });
});

describe("the card holder name", () => {
  it("accepts a name as it appears on a card", () => {
    expect(isValidCardHolder("Ayesha Rahman")).toBe(true);
    expect(isValidCardHolder("Anne-Marie O'Neill")).toBe(true);
    expect(isValidCardHolder("  Ayesha Rahman  ")).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(isValidCardHolder("")).toBe(false);
    expect(isValidCardHolder("   ")).toBe(false);
  });

  it("rejects a name that is one character long", () => {
    expect(isValidCardHolder("A")).toBe(false);
  });

  it("rejects punctuation that cannot appear on a printed card", () => {
    expect(isValidCardHolder("Ayesha <script>")).toBe(false);
    expect(isValidCardHolder("Ayesha123")).toBe(false);
  });
});
