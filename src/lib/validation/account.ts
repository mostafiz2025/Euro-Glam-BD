import { z } from "zod";

import { bdPhoneSchema, emailSchema, passwordSchema } from "./schemas";
import { shippingAddressSchema } from "./commerce";

/**
 * Validation schemas for the **customer's own account**.
 *
 * ── Where this file sits ──────────────────────────────────────────────────
 *
 * The validation layer has three vocabularies, one per audience:
 *
 *   • `commerce.ts` — the catalogue, the cart and the checkout.
 *   • `admin.ts` — the console.
 *   • **`account.ts`** — the signed-in customer's own record.
 *
 * They are deliberately separate files rather than one shared file with
 * optional sections. A customer's request body and an administrator's
 * request body are different documents, and merging them would mean every
 * consumer had to know which half of the merged schema applied to it.
 *
 * ── The rule that governs this file ───────────────────────────────────────
 *
 * **Invalid input is rejected, never silently ignored.**
 *
 * A Zod object *strips* unknown keys rather than rejecting them. So a
 * key this file wants to **refuse** has to be declared as
 * `z.unknown().optional()` and checked in a `superRefine` — otherwise
 * `email` in a profile body would vanish in silence, the request would
 * report success, and the customer would believe their address had
 * changed when it had not.
 */

/**
 * A customer's display name.
 *
 * Two characters at the low end (a two-letter name is real), and the same
 * 160-character ceiling as the column.
 */
export const customerNameSchema = z
  .string()
  .trim()
  .min(2, "Enter your name.")
  .max(160, "That name is too long.");

/**
 * A customer's saved delivery address.
 *
 * This is the **same** schema the checkout uses. That is the whole point
 * of reusing it: the address saved on the account and the address typed
 * at checkout have one definition of shape, so the two cannot drift apart
 * and a saved address can never fail to satisfy the checkout.
 *
 * The `notes` field is deliberately **not** part of a saved address. A
 * delivery note belongs to a particular delivery ("please call before
 * arriving"), not to a home address that will be reused for years.
 *
 * ── Why `notes` is refused rather than stripped ──────────────────────────
 *
 * `z.object()` **strips** an unknown key rather than rejecting it. So an
 * `omit()` alone would silently throw the note away — the request would
 * report success, the note would vanish, and nothing would say so.
 *
 * The key is therefore declared as `z.unknown().optional()` and refused
 * in the `superRefine` below. The parsed output never contains it, and a
 * body that carries it produces an error rather than a silently
 * shortened address.
 */
export const savedAddressSchema = shippingAddressSchema
  .omit({ notes: true })
  .extend({
    /**
     * Whether this is the address the checkout should pre-fill.
     *
     * The flag is accepted here and applied by the service, so the
     * account ends up with **at most one** default address. Saving a
     * second address with the flag on moves the flag, rather than
     * leaving two rows claiming to be the default.
     */
    isDefault: z.boolean().default(true),

    /*
     * The delivery note is declared so it can be **refused**. Its value
     * does not matter — only its presence does.
     */
    notes: z.unknown().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.notes !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notes"],
        message:
          "A delivery note belongs to the order, not to a saved address.",
      });
    }
  });

export type SavedAddressInput = z.infer<typeof savedAddressSchema>;

/**
 * The keys a customer may **not** change about themselves.
 *
 * Each one is refused with a message that says why, because "that request
 * is not allowed" is not something a customer can act on.
 */
export const CUSTOMER_PROFILE_FORBIDDEN_KEYS = [
  /**
   * The email address.
   *
   * The email is the account's **identity** — the sign-in key and the
   * destination of every password reset and order confirmation. The shop
   * owns an email verification flow (the `EmailOtp` table), so a
   * self-service change would have to prove the new address before it
   * could be trusted. Until that is wired up, the honest answer is to
   * refuse the field rather than accept it and skip the proof.
   */
  "email",
  /**
   * The role.
   *
   * A privilege grant is somebody else's decision. A self-service role
   * field would let any customer promote themselves to an administrator.
   */
  "role",
  /**
   * The SMS consent flag.
   *
   * `smsOptIn` is the only flag that authorises an SMS send, and it is a
   * decision about **being messaged** rather than about what number to be
   * messaged at. It is set once, on the storefront's own consent flow, so
   * that the shop never has to ask twice and never has to guess.
   */
  "smsOptIn",
  /**
   * The user id.
   *
   * The id the write applies to comes from the **session**, and is not in
   * the request at all. A body that names an id is a body that is trying
   * to write to somebody else's row.
   */
  "id",
  /**
   * The password hash.
   *
   * The password is changed through the password route, which asks for
   * the current password first. A body that carried a `passwordHash` would
   * be a request to set a hash directly, and nothing in the system should
   * be able to do that.
   */
  "passwordHash",
  /**
   * The email verification timestamp.
   *
   * An unverified account is an account whose address nobody has proved.
   * The customer cannot tick that box themselves.
   */
  "emailVerifiedAt",
] as const;

/**
 * Refuses any of the forbidden keys on a customer profile body.
 *
 * The check fires only when a key is **present**. A body that carries
 * none of them — which is every legitimate body — is unaffected.
 */
function refuseForbiddenProfileFields(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const messages: Record<
    (typeof CUSTOMER_PROFILE_FORBIDDEN_KEYS)[number],
    string
  > = {
    email:
      "Your email address is your account's identity, so it cannot be changed here. Please contact us and we will help you change it.",
    role: "Your account role cannot be changed here.",
    smsOptIn:
      "Your SMS reminders cannot be changed here. That is a decision about being messaged, so it is set on your storefront account.",
    id: "That field cannot be changed here. Your account is changed by the signed-in customer alone.",
    passwordHash:
      "That field cannot be changed here. Use the change-password form to set a new password.",
    emailVerifiedAt:
      "That field cannot be changed here. It is set by the shop when you verify your email address.",
  };

  for (const key of CUSTOMER_PROFILE_FORBIDDEN_KEYS) {
    if (value[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: messages[key],
      });
    }
  }
}

/**
 * The body of a customer profile update.
 *
 * Every field is **optional**, and the update is a **patch**: a field
 * that is absent is left exactly as it was. That is what lets the form
 * send only the fields the customer actually touched, so correcting a typo
 * in the name cannot silently blank the phone number the form happened to
 * be holding.
 */
export const customerProfileUpdateSchema = z
  .object({
    /**
     * The customer's display name.
     */
    name: customerNameSchema.optional(),

    /**
     * The customer's telephone number.
     *
     * An **empty string** clears it — "no number on file" is a real
     * state and is different from "not known".
     *
     * The number is normalised to the `+880XXXXXXXXX` form by
     * `bdPhoneSchema`, so the same number cannot be stored twice in two
     * spellings.
     */
    phone: z.union([bdPhoneSchema, z.literal("")]).optional(),

    /**
     * The customer's saved delivery address.
     *
     * `null` clears it. An object sets it.
     */
    address: z.union([savedAddressSchema, z.null()]).optional(),

    /*
     * The forbidden keys are declared so they can be **refused**. They
     * are `z.unknown()` rather than typed fields because their value does
     * not matter — only their presence does.
     */
    email: z.unknown().optional(),
    role: z.unknown().optional(),
    smsOptIn: z.unknown().optional(),
    id: z.unknown().optional(),
    passwordHash: z.unknown().optional(),
    emailVerifiedAt: z.unknown().optional(),
  })
  .superRefine(refuseForbiddenProfileFields);

export type CustomerProfileUpdateInput = z.infer<
  typeof customerProfileUpdateSchema
>;

/**
 * The body of a password change.
 *
 * ── Why the current password is required ──────────────────────────────────
 *
 * A password change that does not ask for the current password lets
 * anybody who walks up to an unlocked device change the password and
 * lock the real owner out. The current password is the proof that the
 * person making the request is the person who owns the account.
 *
 * It is also the answer to the shared-device case — a shop counter, a
 * family laptop. Without the current password, whoever is sitting there
 * can take the account over permanently.
 */
export const customerPasswordChangeSchema = z
  .object({
    /** The password currently on the account. */
    currentPassword: z.string().min(1, "Enter your current password."),

    /** The password to move to. */
    newPassword: passwordSchema,

    /**
     * The new password, again.
     *
     * A confirmation field is not a security control — it catches the
     * typo, which is the actual reason it exists. The server compares the
     * two and refuses a mismatch, so the check does not depend on the
     * client being honest about having compared them.
     */
    confirmPassword: z.string().min(1, "Confirm your new password."),

    /*
     * The forbidden keys are declared so they can be **refused**.
     */
    id: z.unknown().optional(),
    email: z.unknown().optional(),
    userId: z.unknown().optional(),
  })
  .superRefine((value, ctx) => {
    for (const key of ["id", "email", "userId"] as const) {
      if (value[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "That field cannot be changed here.",
        });
      }
    }

    if (value.newPassword !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirmPassword"],
        message: "The two passwords do not match.",
      });
    }

    /*
     * The new password must not be the current one.
     *
     * The comparison is on the **plaintext** rather than the hashes,
     * because two bcrypt hashes of the same password are different
     * strings — comparing them would never match, and the rule would be
     * dead code that looked alive.
     *
     * The server still verifies the current password against the stored
     * hash before it does anything. This check is a usability guard: it
     * turns "you typed the same password twice" into a clear message
     * instead of a successful change that changed nothing.
     */
    if (value.newPassword === value.currentPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: "Your new password must be different from your current one.",
      });
    }
  });

export type CustomerPasswordChangeInput = z.infer<
  typeof customerPasswordChangeSchema
>;

/**
 * The body of a "send me a reset code" request.
 *
 * Kept next to the other account schemas because it is part of the same
 * story — the email address cannot be changed, but it can be *proved*.
 */
export const customerEmailChangeRequestSchema = z.object({
  /** The new address to prove. */
  email: emailSchema,
});

export type CustomerEmailChangeRequestInput = z.infer<
  typeof customerEmailChangeRequestSchema
>;
