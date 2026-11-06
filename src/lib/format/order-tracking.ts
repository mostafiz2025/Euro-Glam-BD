/**
 * The order-tracking vocabulary.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * Tracking an order without an account needs two things the shop did not
 * previously have:
 *
 *   1. A way to make sense of whatever the customer **types**. The order
 *      number travels by SMS, so it arrives as "EGB-20261027-A1B2C3",
 *      and it arrives typed by a person on a phone, which means lowercase,
 *      spaces instead of hyphens, and a missing separator.
 *
 *   2. A way to compare a phone number against the one on the order. The
 *      order's delivery phone is stored in **+880** form because the
 *      checkout normalises it — but an order the **admin** created by
 *      phone carries whatever the operator typed. So the comparison
 *      cannot be a string equality; it has to be a comparison of
 *      **digits**.
 *
 * Both are pure functions over strings, and both are needed on the
 * server. They live here rather than in the service because a pure
 * function is something a unit test can pin down without a database.
 *
 * ── Client-safe ───────────────────────────────────────────────────────────
 *
 * This module imports nothing, so a `"use client"` component can use it
 * without pulling anything into the browser bundle.
 */

/**
 * The order number's shape, as the shop mints it.
 *
 * `EGB-` + eight digits (the UTC date) + `-` + six hex characters.
 *
 * The pattern is used **after** the separators have been stripped, so it
 * matches every spelling a customer might type.
 */
const ORDER_NUMBER_COMPACT = /^EGB(\d{8})([0-9A-F]{6})$/;

/**
 * Normalises an order number into the shop's canonical form.
 *
 * ── What it accepts ───────────────────────────────────────────────────────
 *
 * Everything a person might realistically type:
 *
 *   "EGB-20261027-A1B2C3"   the number as it was sent
 *   "egb-20261027-a1b2c3"   typed in caps-lock
 *   "EGB 20261027 A1B2C3"   typed from a screenshot
 *   "EGB20261027A1B2C3"    pasted with the hyphens stripped
 *
 * ── What it returns ───────────────────────────────────────────────────────
 *
 * The canonical form — `EGB-20261027-A1B2C3` — or `null` when the value
 * is not an order number at all.
 *
 * `null` is a real answer and not a failure. It means "this is not
 * shaped like an order number", and the caller answers the same way it
 * answers for an order number that simply does not exist — because a
 * customer who has mistyped their order number should not be able to
 * tell the difference between a mistyped number and a number that was
 * never issued.
 */
export function normaliseOrderNumber(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const match = ORDER_NUMBER_COMPACT.exec(compact);

  if (!match) return null;

  return `EGB-${match[1]}-${match[2]}`;
}

/**
 * The bare digits of a Bangladeshi mobile number, in national form.
 *
 * ── Why this is not a simple digit-strip ──────────────────────────────────
 *
 * The same number has several spellings, and the shop stores two of
 * them:
 *
 *   • The **checkout** normalises the delivery phone to `+8801712345678`,
 *     because `bdPhoneSchema` does.
 *   • An **admin-created** order — a telephone order taken by an
 *     operator — carries whatever the operator typed, because the admin
 *     form's phone field is a free string.
 *
 * So "01712345678", "+8801712345678", "8801712345678" and "1712345678"
 * are all the same number and all have to match the same order.
 *
 * The rule is: strip everything that is not a digit, then remove the
 * country code (`880`) and the national trunk prefix (`0`) if they are
 * there. What is left is the ten-digit national number.
 *
 * A number that is neither — a landline, or a number with a country
 * code the shop has never seen — is returned as its digits, and simply
 * will not match. That is the correct outcome: a false match would be
 * far worse than a false miss.
 */
export function phoneNationalDigits(value: string): string {
  const digits = value.replace(/\D/g, "");

  if (digits.length === 13 && digits.startsWith("880")) {
    return digits.slice(3);
  }

  if (digits.length === 11 && digits.startsWith("0")) {
    return digits.slice(1);
  }

  return digits;
}

/**
 * Whether two phone numbers are the same number.
 *
 * The comparison is on the **national digits**, so the two spellings the
 * shop actually stores — `+8801712345678` and `01712345678` — match.
 *
 * An empty number never matches, including against another empty number.
 * That matters: the order's delivery phone is always present, but the
 * customer's *account* phone is optional, and "no phone on file" must not
 * be treated as "the phone matches".
 */
export function phoneMatches(left: string, right: string): boolean {
  const a = phoneNationalDigits(left);
  const b = phoneNationalDigits(right);

  if (a.length === 0 || b.length === 0) return false;

  return a === b;
}

/**
 * Whether two email addresses are the same address.
 *
 * The comparison is case-insensitive and ignores surrounding space. The
 * shop lowercases addresses on the way in, but an address written by
 * hand into the admin console may not have been, and a customer typing
 * "Sara@Example.com" has typed the same mailbox as "sara@example.com".
 */
export function emailMatches(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();

  if (a.length === 0 || b.length === 0) return false;

  return a === b;
}
