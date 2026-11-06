import { SignJWT, jwtVerify, type JWTPayload } from "jose";

import type { UserRole } from "@prisma/client";

/**
 * JWT utilities.
 *
 * Design notes:
 *
 *  • The secret is read from the environment and validated at module load.
 *    A missing or short secret must fail loudly at startup, not silently
 *    produce tokens signed with a guessable key.
 *
 *  • `jose` is used rather than `jsonwebtoken` because it runs unchanged on
 *    the Edge runtime (needed by `middleware.ts`) and has no Node-specific
 *    native dependencies.
 *
 *  • Tokens are HS256 (symmetric). The same secret both signs and verifies,
 *    so it must never be exposed to the client.
 */

export const SESSION_COOKIE_NAME = "egb_session";

/** Default token lifetime: 7 days, in seconds. */
export const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * The claims carried by a session token.
 *
 * `role` is included so the middleware can authorise admin routes without
 * a database round-trip. It is NOT sufficient on its own — see
 * `requireAdmin` in guards.ts, which re-reads the role from the database.
 * The claim is an optimisation; the database is the authority.
 */
export type SessionClaims = {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
};

const encoder = new TextEncoder();

/**
 * Resolves the signing secret.
 *
 * Throws if the secret is missing or shorter than 32 bytes. HS256 keys
 * shorter than the hash output weaken the signature; 32 bytes is the
 * minimum for a 256-bit key.
 */
function getSecret(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET;

  if (!secret) {
    throw new Error(
      "AUTH_JWT_SECRET is not set. Add it to .env — generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    );
  }

  if (secret.length < 32) {
    throw new Error(
      `AUTH_JWT_SECRET must be at least 32 characters (got ${secret.length}).`,
    );
  }

  return encoder.encode(secret);
}

/**
 * Resolves the token lifetime in seconds.
 */
export function getTtlSeconds(): number {
  const raw = process.env.AUTH_JWT_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `AUTH_JWT_TTL_SECONDS must be a positive integer (got "${raw}").`,
    );
  }

  return parsed;
}

/**
 * Signs a session token.
 *
 * `expiresIn` is set by `jose` from the `ttl` argument; `iat` and a
 * matching `exp` are added automatically.
 */
export async function signToken(
  claims: SessionClaims,
  ttlSeconds: number = getTtlSeconds(),
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    email: claims.email,
    name: claims.name,
    role: claims.role,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + ttlSeconds)
    .setIssuer("euro-glam-bd")
    .setAudience("euro-glam-bd-web")
    /**
     * A unique token identifier.
     *
     * `iat` has one-second resolution, so two tokens minted for the same
     * user within the same second would otherwise be byte-identical. The
     * `jti` guarantees every issued token is distinct, which lets a
     * future revocation list key on it and gives log correlation a
     * stable handle.
     *
     * `crypto.randomUUID()` is the Web Crypto global, not `node:crypto` —
     * this module is imported by the Edge middleware, where Node built-ins
     * are unavailable.
     */
    .setJti(crypto.randomUUID())
    .sign(getSecret());
}

/**
 * Verifies a session token and returns its claims.
 *
 * Returns `null` for any failure — expired, tampered, wrong signature,
 * wrong issuer/audience, malformed. The caller must not distinguish between
 * these cases in any user-facing message: telling an attacker *why* a token
 * was rejected is free reconnaissance.
 */
export async function verifyToken(
  token: string | undefined | null,
): Promise<SessionClaims | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
      issuer: "euro-glam-bd",
      audience: "euro-glam-bd-web",
    });

    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.name !== "string" ||
      (payload.role !== "CUSTOMER" && payload.role !== "ADMIN")
    ) {
      return null;
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };
  } catch {
    return null;
  }
}

/**
 * Decodes a token WITHOUT verifying its signature.
 *
 * Intended for diagnostics only — reading a token's expiry to debug a
 * session issue. Never use the result to make an authorisation decision.
 */
export async function decodeToken(
  token: string | undefined | null,
): Promise<JWTPayload | null> {
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
      issuer: "euro-glam-bd",
      audience: "euro-glam-bd-web",
    });
    return payload;
  } catch {
    return null;
  }
}
