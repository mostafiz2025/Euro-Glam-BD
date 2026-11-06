/**
 * The SMS message templates.
 *
 * ── The one rule that governs this file ────────────────────────────────
 *
 * **A message body must never contain a shipping address.**
 *
 * An SMS is forwarded. It is read by whoever the customer forwards it
 * to, and it sits in a phone's notification list where anyone glancing
 * at the screen can read it. A full name, a street address and a phone
 * number are three separate pieces of personal data, and none of them
 * is needed to say "your product is running out".
 *
 * The body carries the **product name** and the **order number**. That
 * is enough for the customer to identify the order, and nothing more.
 *
 * The module is pure and deterministic: no clock, no randomness, no
 * network. The same input always produces the same body.
 */

/**
 * The public base URL used to build the order link.
 *
 * Falls back to a placeholder so a missing configuration produces a
 * visibly wrong link rather than a crash — a broken link is a support
 * ticket, a crash is an outage.
 */
const DEFAULT_SITE_URL = "https://euroglambd.com";

/**
 * The input to the depletion reminder template.
 */
export type DepletionReminderInput = {
  /** The customer's order number, e.g. "EGB-20261027-A1B2C3". */
  readonly orderNumber: string;
  /** The product name, snapshotted at the time of the order. */
  readonly productName: string;
  /** The order id, used to build the order link. */
  readonly orderId: string;
};

/**
 * Returns the site's base URL, without a trailing slash.
 */
function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();

  if (!configured) return DEFAULT_SITE_URL;

  return configured.replace(/\/+$/, "");
}

/**
 * Builds the order link.
 */
export function buildOrderLink(orderId: string): string {
  return `${siteUrl()}/orders/${orderId}`;
}

/**
 * Builds the body of a depletion reminder.
 *
 * ── No opt-out line, deliberately ──────────────────────────────────────
 *
 * There is no "Reply STOP to opt out." line, and there will not be one
 * until the platform can actually honour a STOP.
 *
 * An opt-out instruction that does nothing is a promise the system
 * cannot keep, and it is worse than no instruction at all: a customer
 * who replies STOP has been told their objection was received, and then
 * nothing happens. Consent is enforced server-side through
 * `User.smsOptIn` in the meantime, which is what actually protects the
 * customer.
 *
 * When the opt-out endpoint is built, this template gains the line and
 * the promise becomes true.
 */
export function buildDepletionReminderBody(
  input: DepletionReminderInput,
): string {
  return [
    `Your Euro Glam Bd order ${input.orderNumber} includes ${input.productName}, which you estimated will run out soon. Time to reorder?`,
    buildOrderLink(input.orderId),
  ].join("\n");
}

/**
 * Builds the body of a manual resend.
 *
 * The same content as the automated reminder — a manual resend is a
 * reminder the admin sent by hand, not a different message. The
 * `reason` is recorded on the log row, not sent to the customer: an
 * internal note has no place in a message the customer reads.
 */
export function buildManualResendBody(
  input: DepletionReminderInput,
): string {
  return buildDepletionReminderBody(input);
}
