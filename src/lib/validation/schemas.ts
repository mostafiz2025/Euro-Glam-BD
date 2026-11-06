import { z } from "zod";

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth/password";

/**
 * Shared Zod schemas for request validation.
 *
 * Every route handler parses its input through one of these before it
 * touches the database. Client-supplied data is never trusted, and the
 * schema is the single definition of what a valid request looks like.
 */

/**
 * Email addresses, normalised to lowercase.
 *
 * Lowercasing is applied in the transform so that "User@Example.com" and
 * "user@example.com" cannot become two accounts. The unique index on
 * `User.email` is what actually enforces uniqueness — the transform just
 * makes the comparison meaningful.
 */
export const emailSchema = z
  .string()
  .trim()
  .min(1, "Email is required.")
  .max(255, "Email is too long.")
  .email("Enter a valid email address.")
  .transform((value) => value.toLowerCase());

/**
 * Passwords.
 *
 * Only length and character-class rules are enforced. Composition rules
 * ("must contain a symbol") push users toward predictable substitutions
 * like `Password1!`, which measurably weakens the password. A long
 * passphrase is stronger and easier to remember.
 */
export const passwordSchema = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  )
  .max(
    MAX_PASSWORD_LENGTH,
    `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
  );

/**
 * Bangladeshi mobile numbers.
 *
 * Accepts the formats customers actually type:
 *   01712345678
 *   +8801712345678
 *   0171-2345678
 *   8801712345678
 *
 * Normalised to the +880XXXXXXXXX form so that a single contact record
 * cannot be duplicated across these spellings.
 */
export const bdPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine(
    (value) => /^(?:\+?880|0)?1[3-9]\d{8}$/.test(value),
    "Enter a valid Bangladeshi mobile number (e.g. 01712345678).",
  )
  .transform((value) => {
    // Strip the local `0` prefix, then normalise everything to +880.
    if (value.startsWith("+")) return value;

    const national = value.startsWith("0") ? value.slice(1) : value;

    return `+880${national.startsWith("880") ? national.slice(3) : national}`;
  });

export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters.")
    .max(160, "Name is too long."),
  email: emailSchema,
  phone: bdPhoneSchema.optional(),
  password: passwordSchema,
  /**
   * Explicit SMS consent (locked decision #9).
   *
   * Defaults to false and is only ever set true by an explicit opt-in.
   */
  smsOptIn: z.boolean().default(false),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
