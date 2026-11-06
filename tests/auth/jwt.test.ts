import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  DEFAULT_TTL_SECONDS,
  decodeToken,
  getTtlSeconds,
  signToken,
  verifyToken,
} from "@/lib/auth/jwt";
import type { UserRole } from "@prisma/client";

/**
 * JWT security tests.
 *
 * These cover the properties that actually matter for session security:
 * a token cannot be forged, tampered with, or replayed past its expiry.
 * "It compiles" proves none of that.
 */

const SECRET = "test-secret-that-is-at-least-32-bytes-long-abc";

const claims = {
  sub: "user_123",
  email: "user@example.com",
  name: "Test User",
  role: "CUSTOMER" as UserRole,
};

describe("jwt", () => {
  let originalSecret: string | undefined;
  let originalTtl: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.AUTH_JWT_SECRET;
    originalTtl = process.env.AUTH_JWT_TTL_SECONDS;
    process.env.AUTH_JWT_SECRET = SECRET;
    delete process.env.AUTH_JWT_TTL_SECONDS;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.AUTH_JWT_SECRET;
    } else {
      process.env.AUTH_JWT_SECRET = originalSecret;
    }

    if (originalTtl === undefined) {
      delete process.env.AUTH_JWT_TTL_SECONDS;
    } else {
      process.env.AUTH_JWT_TTL_SECONDS = originalTtl;
    }
  });

  describe("signToken / verifyToken round trip", () => {
    it("returns the original claims for a valid token", async () => {
      const token = await signToken(claims);
      const result = await verifyToken(token);

      expect(result).not.toBeNull();
      expect(result?.sub).toBe("user_123");
      expect(result?.email).toBe("user@example.com");
      expect(result?.name).toBe("Test User");
      expect(result?.role).toBe("CUSTOMER");
    });

    it("produces a different token each time (unique jti)", async () => {
      const a = await signToken(claims);
      const b = await signToken(claims);

      // `iat` has one-second resolution, so without a `jti` two tokens
      // minted in the same second would be byte-identical.
      expect(a).not.toBe(b);
      expect((await verifyToken(a))?.sub).toBe((await verifyToken(b))?.sub);
    });

    it("issues a distinct jti for every token", async () => {
      const tokens = await Promise.all(
        Array.from({ length: 25 }, () => signToken(claims)),
      );

      const jtis = await Promise.all(
        tokens.map(async (token) => (await decodeToken(token))?.jti),
      );

      expect(jtis.every(Boolean)).toBe(true);
      expect(new Set(jtis).size).toBe(jtis.length);
    });

    it("sets an expiry exactly the requested TTL in the future", async () => {
      const ttl = 3600;
      const token = await signToken(claims, ttl);
      const payload = await decodeToken(token);

      expect(typeof payload?.exp).toBe("number");
      expect(typeof payload?.iat).toBe("number");
      expect((payload!.exp as number) - (payload!.iat as number)).toBe(ttl);
    });
  });

  describe("tamper resistance", () => {
    it("rejects a token whose payload was modified", async () => {
      const token = await signToken(claims);

      const [header, , signature] = token.split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({
          sub: "attacker_999",
          email: "attacker@example.com",
          name: "Attacker",
          role: "ADMIN",
          iss: "euro-glam-bd",
          aud: "euro-glam-bd-web",
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      ).toString("base64url");

      const forged = `${header}.${forgedPayload}.${signature}`;

      // The payload no longer matches the signature.
      expect(await verifyToken(forged)).toBeNull();
    });

    it("rejects a token whose role was escalated to ADMIN", async () => {
      const customerToken = await signToken(claims);

      const [header, payload, signature] = customerToken.split(".");
      const decoded = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      );
      decoded.role = "ADMIN";

      const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

      expect(await verifyToken(forged)).toBeNull();
    });

    it("rejects a token signed with a different secret", async () => {
      const token = await signToken(claims);

      process.env.AUTH_JWT_SECRET = "a-completely-different-secret-32-bytes-long";

      expect(await verifyToken(token)).toBeNull();
    });

    it("rejects an unsigned 'alg: none' token", async () => {
      const header = Buffer.from(
        JSON.stringify({ alg: "none", typ: "JWT" }),
      ).toString("base64url");

      const payload = Buffer.from(
        JSON.stringify({
          sub: "attacker_999",
          email: "attacker@example.com",
          name: "Attacker",
          role: "ADMIN",
          iss: "euro-glam-bd",
          aud: "euro-glam-bd-web",
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url");

      expect(await verifyToken(`${header}.${payload}.`)).toBeNull();
    });
  });

  describe("malformed input", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["empty string", ""],
      ["not a jwt", "garbage"],
      ["two segments", "aaa.bbb"],
      ["four segments", "aaa.bbb.ccc.ddd"],
    ])("returns null for %s", async (_label, input) => {
      expect(await verifyToken(input)).toBeNull();
    });
  });

  describe("expiry", () => {
    it("rejects an expired token", async () => {
      // A token that expired one second ago.
      const expired = await signToken(claims, -1);

      expect(await verifyToken(expired)).toBeNull();
    });

    it("rejects a token that expired in the past via a negative TTL", async () => {
      const expired = await signToken(claims, -3600);

      expect(await verifyToken(expired)).toBeNull();
    });
  });

  describe("secret validation", () => {
    it("throws when the secret is missing", async () => {
      delete process.env.AUTH_JWT_SECRET;

      await expect(signToken(claims)).rejects.toThrow(
        /AUTH_JWT_SECRET is not set/,
      );
    });

    it("throws when the secret is shorter than 32 characters", async () => {
      process.env.AUTH_JWT_SECRET = "too-short";

      await expect(signToken(claims)).rejects.toThrow(
        /at least 32 characters/,
      );
    });
  });

  describe("getTtlSeconds", () => {
    it("defaults to 7 days", () => {
      expect(getTtlSeconds()).toBe(DEFAULT_TTL_SECONDS);
      expect(DEFAULT_TTL_SECONDS).toBe(604800);
    });

    it("reads a valid override", () => {
      process.env.AUTH_JWT_TTL_SECONDS = "3600";
      expect(getTtlSeconds()).toBe(3600);
    });

    it("throws on a non-positive value", () => {
      process.env.AUTH_JWT_TTL_SECONDS = "0";
      expect(() => getTtlSeconds()).toThrow(/positive integer/);
    });

    it("throws on a non-numeric value", () => {
      process.env.AUTH_JWT_TTL_SECONDS = "forever";
      expect(() => getTtlSeconds()).toThrow(/positive integer/);
    });
  });
});
