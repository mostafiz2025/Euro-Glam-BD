import bcrypt from "bcryptjs";

/**
 * Password hashing helpers.
 *
 * `bcryptjs` is used rather than the native `bcrypt` package: the native
 * build requires a C++ toolchain on Windows and frequently fails to
 * install. `bcryptjs` is pure JavaScript with no native dependency and
 * produces identical hashes — the algorithm, not the binding, is what
 * matters for security.
 */

/**
 * bcrypt work factor.
 *
 * 12 is the current sensible balance: roughly 250–400ms per hash on
 * typical server hardware, which is slow enough to make offline cracking
 * expensive and fast enough for a responsive login.
 *
 * bcrypt truncates input at 72 bytes. We reject longer inputs rather than
 * silently ignoring the tail, so two different long passwords cannot
 * produce the same hash.
 */
const BCRYPT_COST = 12;
const BCRYPT_MAX_BYTES = 72;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Hashes a plaintext password.
 *
 * @throws if the password is outside the allowed length range.
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Verifies a plaintext password against a stored hash.
 *
 * Returns `false` rather than throwing for a malformed stored hash — a
 * corrupt row in the database should deny access, not crash the login
 * route.
 */
export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  if (typeof passwordHash !== "string" || passwordHash.length === 0) {
    return false;
  }

  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}

/**
 * Checks the minimum length requirement only.
 *
 * Used at the registration boundary, where the message can be specific.
 */
export function isPasswordLengthValid(password: string): boolean {
  return (
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

/**
 * Enforces the password length bounds.
 *
 * @throws RangeError when the password is too short or too long.
 */
export function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new RangeError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }

  // bcrypt silently truncates beyond 72 bytes, so two passwords sharing a
  // 72-byte prefix would be interchangeable. Reject rather than truncate.
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_BYTES) {
    throw new RangeError(
      `Password must be at most ${BCRYPT_MAX_BYTES} bytes when UTF-8 encoded.`,
    );
  }
}
