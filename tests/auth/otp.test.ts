import { describe, expect, it } from "vitest";

import { generateOtpCode, hashCode } from "@/lib/auth/otp";
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  otpCodeSchema,
  otpEmailSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from "@/lib/validation/otp";

/**
 * The one-time-password primitives.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * A one-time password is a credential with a short life. Three things
 * have to hold for it to be safe, and each of them is easy to break
 * silently:
 *
 *   1. **It is drawn uniformly.** Six digits from a million possibilities,
 *      with no bias toward the low values. A generator that produced
 *      "000000" more often than "999999" would be a generator with a
 *      smaller effective search space than it looks.
 *
 *   2. **It is never stored in the clear.** Only a hash of it reaches the
 *      database, and the hash is salted per row so that two equal codes
 *      do not look equal on disk.
 *
 *   3. **It is bounded.** It expires, it is single-use, and it has an
 *      attempt limit. Six digits is not a secret on its own — a million
 *      possibilities is a search space, not a wall.
 *
 * The tests below pin the first two down. The third is enforced in the
 * service and covered by the integration suite.
 */
describe("generateOtpCode", () => {
  it("always produces six digits", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it("zero-pads a small value rather than shortening it", () => {
    /*
     * The code is drawn as a *number* and padded, so the leading digit
     * can be zero. A code of "42" would be two characters, and the
     * customer would paste it into a six-box form and fail.
     *
     * The generator cannot be forced to produce a small value from the
     * outside, so what is asserted here is the property that matters:
     * the output length is always exactly six, whatever the draw.
     */
    const lengths = new Set<number>();

    for (let i = 0; i < 500; i += 1) {
      lengths.add(generateOtpCode().length);
    }

    expect([...lengths]).toEqual([OTP_LENGTH]);
  });

  it("does not repeat itself across many draws", () => {
    /*
     * Not a test of randomness quality — just a guard against a
     * generator that has been wired to a constant.
     *
     * The assertion allows for a small number of collisions rather than
     * demanding that every draw is distinct. Two hundred draws from a
     * million values collide with probability around one in two hundred
     * (the birthday bound), so demanding 200 distinct codes would make
     * this test fail occasionally for no reason at all.
     */
    const codes = new Set<string>();

    for (let i = 0; i < 200; i += 1) {
      codes.add(generateOtpCode());
    }

    expect(codes.size).toBeGreaterThan(190);
  });

  it("produces every digit in the leading position", () => {
    /*
     * A biased generator — one that favours the first half of the range
     * — would show up as a missing leading digit. With 1,000 draws over
     * ten digits, every digit should appear.
     */
    const leading = new Set<string>();

    for (let i = 0; i < 1_000; i += 1) {
      leading.add(generateOtpCode()[0]);
    }

    expect(leading.size).toBe(10);
  });
});

describe("hashCode", () => {
  it("is deterministic for the same code and salt", () => {
    expect(hashCode("123456", "otp-1")).toBe(hashCode("123456", "otp-1"));
  });

  it("differs for a different code", () => {
    expect(hashCode("123456", "otp-1")).not.toBe(hashCode("654321", "otp-1"));
  });

  it("differs for the same code under a different salt", () => {
    /*
     * This is the property the salt exists for. Two customers issued the
     * same six digits must not have the same stored value, or the table
     * becomes a lookup of "which account does 123456 belong to?".
     */
    expect(hashCode("123456", "otp-1")).not.toBe(hashCode("123456", "otp-2"));
  });

  it("does not contain the code in the digest", () => {
    expect(hashCode("123456", "otp-1")).not.toContain("123456");
  });

  it("produces a 64-character hex digest", () => {
    expect(hashCode("123456", "otp-1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the OTP limits", () => {
  it("expires the code after ten minutes", () => {
    expect(OTP_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("allows five wrong guesses", () => {
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });

  it("cools the resend down for a minute", () => {
    expect(OTP_RESEND_COOLDOWN_MS).toBe(60 * 1000);
  });
});

describe("otpEmailSchema", () => {
  it("lowercases the address", () => {
    expect(otpEmailSchema.parse("User@Example.com")).toBe("user@example.com");
  });

  it("trims the address", () => {
    expect(otpEmailSchema.parse("  user@example.com  ")).toBe(
      "user@example.com",
    );
  });

  it("rejects an empty address", () => {
    expect(() => otpEmailSchema.parse("")).toThrow();
  });

  it("rejects an address with no domain", () => {
    expect(() => otpEmailSchema.parse("not-an-email")).toThrow();
  });
});

describe("otpCodeSchema", () => {
  it("accepts six digits", () => {
    expect(otpCodeSchema.parse("123456")).toBe("123456");
  });

  it("strips the spaces a copied code comes with", () => {
    /*
     * A code pasted out of an email often arrives with a space in the
     * middle. Telling a customer their code is invalid when they typed
     * it correctly leaves them unable to sign in.
     */
    expect(otpCodeSchema.parse("123 456")).toBe("123456");
    expect(otpCodeSchema.parse(" 123456 ")).toBe("123456");
  });

  it("accepts a leading zero", () => {
    expect(otpCodeSchema.parse("012345")).toBe("012345");
  });

  it("rejects five digits", () => {
    expect(() => otpCodeSchema.parse("12345")).toThrow();
  });

  it("rejects seven digits", () => {
    expect(() => otpCodeSchema.parse("1234567")).toThrow();
  });

  it("rejects letters", () => {
    expect(() => otpCodeSchema.parse("abcdef")).toThrow();
  });

  it("rejects an empty code", () => {
    expect(() => otpCodeSchema.parse("")).toThrow();
  });
});

describe("the request schemas", () => {
  it("accepts a send request", () => {
    expect(sendOtpSchema.parse({ email: "User@Example.com" })).toEqual({
      email: "user@example.com",
      // A request that does not say what the code is for is asking to
      // sign in — that is the older flow, and it is the safer default
      // because a signup code cannot be mistaken for a sign-in one.
      purpose: "SIGNIN",
    });
  });

  it("accepts a verify request", () => {
    expect(
      verifyOtpSchema.parse({ email: "user@example.com", code: "123 456" }),
    ).toEqual({ email: "user@example.com", code: "123456", purpose: "SIGNIN" });
  });

  it("keeps the stated purpose", () => {
    expect(
      sendOtpSchema.parse({ email: "user@example.com", purpose: "SIGNUP" }),
    ).toEqual({ email: "user@example.com", purpose: "SIGNUP" });

    expect(
      verifyOtpSchema.parse({
        email: "user@example.com",
        code: "123456",
        purpose: "SIGNUP",
      }),
    ).toEqual({ email: "user@example.com", code: "123456", purpose: "SIGNUP" });
  });

  it("rejects an unknown purpose", () => {
    expect(() =>
      sendOtpSchema.parse({ email: "user@example.com", purpose: "RESET" }),
    ).toThrow();

    expect(() =>
      verifyOtpSchema.parse({
        email: "user@example.com",
        code: "123456",
        purpose: "RESET",
      }),
    ).toThrow();
  });

  it("rejects a verify request with no code", () => {
    expect(() =>
      verifyOtpSchema.parse({ email: "user@example.com" }),
    ).toThrow();
  });

  it("rejects a send request with no email", () => {
    expect(() => sendOtpSchema.parse({})).toThrow();
  });
});
