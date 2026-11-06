import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import type { SavedAddressInput } from "@/lib/validation/account";

/**
 * The signed-in customer's own account.
 *
 * ── What this module is for ───────────────────────────────────────────────
 *
 * The customer's record holds three kinds of thing:
 *
 *   • **Their details** — the name on the order, the telephone number the
 *     shop calls about a delivery. These belong to **one person**, and
 *     they live on the `users` row. That is this module.
 *
 *   • **Their saved delivery address** — where they live. It is a
 *     *preference* rather than a fact about the person, and it is stored
 *     as one `Json` object because it has exactly the shape the checkout
 *     already validates.
 *
 *   • **Their orders** — those are snapshots and they are never rewritten.
 *     Changing the saved address does **not** change where an existing
 *     order is going. That is a rule, not an oversight: the invoice for
 *     a March order must still show the address as it was in March.
 *
 * ── Why the id is never in the request ─────────────────────────────────────
 *
 * Every function here takes the customer id from the **session**. The
 * `where` clause on the update names that id, so a malformed request
 * cannot write to somebody else's row — the id is not in the request at
 * all.
 *
 * ── Why there is no admin audit trail here ─────────────────────────────────
 *
 * The admin audit trail answers "what did an administrator do?". A
 * customer editing their own name is not an administrator action, and
 * writing every customer's keystroke into a log that every admin can
 * browse would be a privacy problem, not a feature.
 *
 * So this service writes **no** audit entries. What it does do is write
 * the change to the customer's own row, which is where the record of
 * their details belongs.
 */

/**
 * The customer profile as the settings page sees it.
 *
 * Deliberately narrow. The `passwordHash` is not here, and there is no way
 * for it to reach a response body by accident.
 */
export type CustomerProfile = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phone: string | null;
  readonly smsOptIn: boolean;
  readonly emailVerifiedAt: Date | null;
  readonly defaultAddress: SavedAddressInput | null;
  readonly updatedAt: Date;
};

/**
 * The fields a customer may change about themselves.
 *
 * Every field is optional — an update that names one field leaves the
 * others alone.
 */
export type CustomerProfilePatch = {
  readonly name?: string;
  readonly phone?: string | null;
  readonly address?: SavedAddressInput | null;
};

/**
 * The Prisma select for the customer's own row.
 *
 * `passwordHash` is **not** selected. The select is what decides which
 * columns reach the process, so excluding it here is stronger than
 * remembering to strip it later.
 */
const CUSTOMER_PROFILE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  smsOptIn: true,
  emailVerifiedAt: true,
  defaultAddress: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

/**
 * The shape stored in `users.defaultAddress`.
 *
 * The column is untyped JSON, so the shape has to be checked on the way
 * out as well as on the way in. A row written by an older version of the
 * app — or edited by hand — may not match, and the page must not crash on
 * it. Anything unrecognisable is treated as "no address saved".
 */
function toSavedAddress(
  value: Prisma.JsonValue | null,
): SavedAddressInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  const fullName = record.fullName;
  const addressLine1 = record.addressLine1;
  const city = record.city;
  const district = record.district;
  const postalCode = record.postalCode;
  const phone = record.phone;

  if (
    typeof fullName !== "string" ||
    typeof addressLine1 !== "string" ||
    typeof city !== "string" ||
    typeof district !== "string" ||
    typeof postalCode !== "string" ||
    typeof phone !== "string"
  ) {
    return null;
  }

  return {
    fullName,
    phone,
    addressLine1,
    ...(typeof record.addressLine2 === "string"
      ? { addressLine2: record.addressLine2 }
      : {}),
    city,
    district,
    postalCode,
    isDefault: record.isDefault !== false,
  };
}

/**
 * Projects a Prisma row onto the safe `CustomerProfile` shape.
 */
function toCustomerProfile(user: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  smsOptIn: boolean;
  emailVerifiedAt: Date | null;
  defaultAddress: Prisma.JsonValue | null;
  updatedAt: Date;
}): CustomerProfile {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    smsOptIn: user.smsOptIn,
    emailVerifiedAt: user.emailVerifiedAt,
    defaultAddress: toSavedAddress(user.defaultAddress),
    updatedAt: user.updatedAt,
  };
}

/**
 * Loads the signed-in customer's profile.
 *
 * @param customerId - The id of the signed-in customer, from the session.
 *
 * @throws ApiError 404 when the row has gone — a customer whose account
 *         was deleted mid-session.
 */
export async function getCustomerProfile(
  customerId: string,
): Promise<CustomerProfile> {
  const user = await db.user.findUnique({
    where: { id: customerId },
    select: CUSTOMER_PROFILE_SELECT,
  });

  if (!user) {
    throw ApiError.notFound(
      "Your account could not be found. Please sign in again.",
    );
  }

  return toCustomerProfile(user);
}

/**
 * Updates the signed-in customer's profile.
 *
 * ── The patch rule ─────────────────────────────────────────────────────────
 *
 * A field that is absent is left exactly as it was. That is what lets the
 * form send only the fields the customer actually touched, so correcting a
 * typo in the name cannot silently blank the phone number the form
 * happened to be holding.
 *
 * @param customerId - The id of the signed-in customer, from the session.
 * @param patch - The fields to change. Unnamed fields are left alone.
 */
export async function updateCustomerProfile(
  customerId: string,
  patch: CustomerProfilePatch,
): Promise<CustomerProfile> {
  const existing = await db.user.findUnique({
    where: { id: customerId },
    select: CUSTOMER_PROFILE_SELECT,
  });

  if (!existing) {
    throw ApiError.notFound(
      "Your account could not be found. Please sign in again.",
    );
  }

  const data: Prisma.UserUpdateInput = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.phone !== undefined
      ? { phone: patch.phone === null ? null : patch.phone }
      : {}),
    ...(patch.address !== undefined
      ? {
          defaultAddress:
            patch.address === null
              ? Prisma.JsonNull
              : (patch.address as unknown as Prisma.InputJsonValue),
        }
      : {}),
  };

  const saved = await db.user.update({
    where: { id: customerId },
    data,
    select: CUSTOMER_PROFILE_SELECT,
  });

  return toCustomerProfile(saved);
}

/**
 * Changes the signed-in customer's password.
 *
 * ── The current password is checked first, and always ─────────────────────
 *
 * This is the whole security of the operation. The customer proves they
 * are the owner of the account by quoting the password already on it.
 *
 * The check is against the **stored hash**, with `verifyPassword` — never
 * a string comparison — so the check is a real cryptographic verification
 * and not a guessable equality test.
 *
 * ── Why the new password is not compared to the old one here ──────────────
 *
 * The schema already refuses a new password equal to the current one, and
 * it does that on the **plaintext**, because two bcrypt hashes of the
 * same password are different strings. That check is a usability guard;
 * this one is the authorisation.
 *
 * ── What happens to the session afterwards ────────────────────────────────
 *
 * The existing session cookie stays valid. The customer is already signed
 * in on the device they are using, and the change they just made is a
 * deliberate act on their own account. Signing them out of the device
 * they are using would be an odd reward for a security action.
 *
 * @param customerId - The id of the signed-in customer, from the session.
 * @param currentPassword - The password currently on the account.
 * @param newPassword - The password to move to.
 *
 * @throws ApiError 400 when the current password is wrong.
 */
export async function changeCustomerPassword(
  customerId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: customerId },
    select: { id: true, passwordHash: true },
  });

  if (!user) {
    throw ApiError.notFound(
      "Your account could not be found. Please sign in again.",
    );
  }

  const matches = await verifyPassword(currentPassword, user.passwordHash);

  if (!matches) {
    throw ApiError.validation(
      "Your current password is not correct.",
    );
  }

  const passwordHash = await hashPassword(newPassword);

  await db.user.update({
    where: { id: customerId },
    data: { passwordHash },
  });
}
