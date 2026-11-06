import { describe, expect, it } from "vitest";

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  assertPasswordLength,
  hashPassword,
  isPasswordLengthValid,
  verifyPassword,
} from "@/lib/auth/password";

/**
 * Password utility tests.
 */

describe("password", () => {
  describe("hashPassword / verifyPassword", () => {
    it("verifies a correct password", async () => {
      const hash = await hashPassword("correct horse battery staple");

      expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    });

    it("rejects an incorrect password", async () => {
      const hash = await hashPassword("correct horse battery staple");

      expect(await verifyPassword("wrong password", hash)).toBe(false);
    });

    it("rejects a password that differs only in case", async () => {
      const hash = await hashPassword("CorrectHorse");

      expect(await verifyPassword("correcthorse", hash)).toBe(false);
    });

    it("rejects a password that differs only in trailing whitespace", async () => {
      const hash = await hashPassword("correcthorse");

      expect(await verifyPassword("correcthorse ", hash)).toBe(false);
    });

    it("produces a different hash each time (salted)", async () => {
      const a = await hashPassword("same password");
      const b = await hashPassword("same password");

      // The salts differ, so the hashes must too — but both must verify.
      expect(a).not.toBe(b);
      expect(await verifyPassword("same password", a)).toBe(true);
      expect(await verifyPassword("same password", b)).toBe(true);
    });

    it("stores a bcrypt hash, not the plaintext", async () => {
      const hash = await hashPassword("my-secret-password");

      expect(hash).not.toContain("my-secret-password");
      expect(hash.startsWith("$2")).toBe(true);
    });
  });

  describe("verifyPassword with malformed hashes", () => {
    it("returns false rather than throwing for an empty hash", async () => {
      expect(await verifyPassword("anything", "")).toBe(false);
    });

    it("returns false rather than throwing for a non-bcrypt hash", async () => {
      expect(await verifyPassword("anything", "not-a-bcrypt-hash")).toBe(false);
    });

    it("returns false for a non-string hash", async () => {
      expect(
        await verifyPassword("anything", undefined as unknown as string),
      ).toBe(false);
    });
  });

  describe("length rules", () => {
    it("accepts a password at the minimum length", () => {
      const password = "a".repeat(MIN_PASSWORD_LENGTH);

      expect(isPasswordLengthValid(password)).toBe(true);
      expect(() => assertPasswordLength(password)).not.toThrow();
    });

    it("rejects a password below the minimum length", () => {
      const password = "a".repeat(MIN_PASSWORD_LENGTH - 1);

      expect(isPasswordLengthValid(password)).toBe(false);
      expect(() => assertPasswordLength(password)).toThrow(/at least/);
    });

    it("rejects a password above the maximum length", () => {
      const password = "a".repeat(MAX_PASSWORD_LENGTH + 1);

      expect(isPasswordLengthValid(password)).toBe(false);
      expect(() => assertPasswordLength(password)).toThrow(/at most/);
    });

    it("rejects a password longer than bcrypt's 72-byte limit", () => {
      // 72 ASCII characters is exactly at the limit; 73 must be rejected.
      // bcrypt silently truncates beyond 72 bytes, so two passwords sharing
      // a 72-byte prefix would otherwise be interchangeable.
      const atLimit = "a".repeat(72);
      expect(() => assertPasswordLength(atLimit)).not.toThrow();

      const overLimit = "a".repeat(73);
      expect(() => assertPasswordLength(overLimit)).toThrow(/72 bytes/);
    });

    it("measures the 72-byte limit in UTF-8 bytes, not characters", () => {
      // Each of these characters is 3 bytes in UTF-8.
      const emoji = "😀".repeat(25); // 75 bytes, 25 characters
      expect(emoji.length).toBeLessThan(MAX_PASSWORD_LENGTH);
      expect(() => assertPasswordLength(emoji)).toThrow(/72 bytes/);
    });
  });
});
