import { describe, expect, it } from "vitest";

import { bdPhoneSchema, emailSchema } from "@/lib/validation/schemas";

/**
 * Shared validation schema tests.
 *
 * These cover the schemas that Step 3 introduced. The phone schema in
 * particular had a real bug: its regex rejected `01712345678` — the
 * single most common format a Bangladeshi customer types — despite its
 * own docstring claiming to accept it. The test below is the regression
 * guard for that.
 */

describe("bdPhoneSchema", () => {
  it("accepts the local format customers actually type", () => {
    expect(bdPhoneSchema.parse("01712345678")).toBe("+8801712345678");
  });

  it("accepts the +880 format", () => {
    expect(bdPhoneSchema.parse("+8801712345678")).toBe("+8801712345678");
  });

  it("accepts the 880 format without a plus", () => {
    expect(bdPhoneSchema.parse("8801712345678")).toBe("+8801712345678");
  });

  it("accepts the format without any prefix", () => {
    expect(bdPhoneSchema.parse("1712345678")).toBe("+8801712345678");
  });

  it("accepts a hyphenated number", () => {
    expect(bdPhoneSchema.parse("0171-2345678")).toBe("+8801712345678");
  });

  it("accepts a number with spaces", () => {
    expect(bdPhoneSchema.parse("0171 2345678")).toBe("+8801712345678");
  });

  it("normalises every spelling to the same value", () => {
    const forms = [
      "01712345678",
      "+8801712345678",
      "8801712345678",
      "1712345678",
      "0171-2345678",
    ];

    const normalised = new Set(forms.map((form) => bdPhoneSchema.parse(form)));

    // One contact record must not be duplicated across spellings.
    expect(normalised.size).toBe(1);
  });

  it("rejects a number that is too short", () => {
    expect(() => bdPhoneSchema.parse("0171234567")).toThrow();
  });

  it("rejects a number that is too long", () => {
    expect(() => bdPhoneSchema.parse("017123456789")).toThrow();
  });

  it("rejects a non-mobile prefix", () => {
    // 012 is not a valid Bangladeshi mobile operator prefix.
    expect(() => bdPhoneSchema.parse("01212345678")).toThrow();
  });

  it("rejects a non-Bangladeshi country code", () => {
    expect(() => bdPhoneSchema.parse("+14155552671")).toThrow();
  });

  it("rejects letters", () => {
    expect(() => bdPhoneSchema.parse("0171234567a")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => bdPhoneSchema.parse("")).toThrow();
  });
});

describe("emailSchema", () => {
  it("lower-cases the email", () => {
    expect(emailSchema.parse("User@Example.com")).toBe("user@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(emailSchema.parse("  user@example.com  ")).toBe("user@example.com");
  });

  it("rejects an invalid email", () => {
    expect(() => emailSchema.parse("not-an-email")).toThrow();
  });
});
