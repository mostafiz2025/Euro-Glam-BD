import { z } from "zod";

/**
 * The order-tracking vocabulary.
 *
 * ── Why a separate file ───────────────────────────────────────────────────
 *
 * The commerce schemas are the catalogue and checkout vocabulary. The
 * tracking schemas describe a different thing — a **guest** asking about
 * an order they have no account for — and they are validated at a
 * different boundary, one that is deliberately **public**.
 *
 * Mixing them would blur a distinction that matters: the checkout body
 * is trusted in ways the tracking body cannot be, because the checkout
 * writes and the tracking body only reads.
 *
 * ── The rule that governs this file ───────────────────────────────────────
 *
 * **A tracking request proves an identity, so it is bounded tightly.**
 *
 * The endpoint is public — anyone may call it, signed in or not — and it
 * answers one question: *what is the state of this order?* The order
 * number alone is not enough to answer it, because an order number is
 * printed on a parcel, quoted over the phone and pasted into a chat
 * window. So the customer must also prove a **contact detail** that is on
 * the order: the account's email address, or the delivery phone number.
 *
 * Both are optional *individually* and required *together*, because the
 * shop does not know which one the customer remembers. The customer is
 * asked for whichever they have.
 */

/**
 * The order number, as the customer types it.
 *
 * Deliberately **permissive** about shape. The number travels by SMS and
 * is retyped on a phone, so it arrives as lowercase, with spaces, or
 * without its hyphens. The pattern here is the loosest thing that still
 * rules out obvious rubbish — it is the *canonical* form that the
 * service looks up, and the normalisation happens there, not here.
 *
 * The reason the pattern is not the canonical one is that a customer who
 * typed "EGB 20261027 A1B2C3" has given a perfectly good number, and a
 * form that refused it would be refusing to help.
 */
const orderNumberSchema = z
  .string()
  .trim()
  .min(1, "Enter your order number.")
  .max(40, "That order number is too long.");

/**
 * The contact detail the customer is asserting.
 *
 * A free string, because the shop cannot know whether the customer
 * remembers an email address or a phone number, and it will not know
 * which until it compares what they typed against the order.
 *
 * The bound is generous — an email address is up to 255 characters — and
 * nothing more is checked here. The **shape** of the value depends on
 * which field the customer filled in, and the form knows that; the
 * service compares against the order's own values, which is the only
 * comparison that means anything.
 */
const contactDetailSchema = z
  .string()
  .trim()
  .min(1, "Enter the email address or phone number on your order.")
  .max(255, "That is too long.");

/**
 * The body of an order-tracking request.
 *
 * Two things, and both are required: the order, and the proof that the
 * asker is the customer.
 */
export const orderTrackingSchema = z.object({
  /**
   * The order number, as the customer typed it.
   */
  orderNumber: orderNumberSchema,

  /**
   * The email address **or** the phone number on the order.
   *
   * One field rather than two, because the customer should not have to
   * know which one the shop will accept. They type what they remember,
   * and the service checks it against both the order's delivery phone
   * and its owner's email.
   */
  contact: contactDetailSchema,
});

export type OrderTrackingInput = z.infer<typeof orderTrackingSchema>;

/**
 * The number of tracking attempts allowed per order number in an hour.
 *
 * ── Why there is a limit at all ───────────────────────────────────────────
 *
 * The endpoint is public and it is a **search**: an order number plus a
 * contact detail. Without a limit, the endpoint is an oracle — a script
 * could try order numbers in a loop, and the only thing standing between
 * it and a harvest of order numbers was the contact detail.
 *
 * The contact detail is the real protection, and it is a good one: it is
 * a secret the customer holds and an attacker does not. But a limit
 * turns "hard to guess" into "expensive to guess", and the cost of the
 * limit is one failed lookup per hour for a customer who has genuinely
 * forgotten their order number — which is rare.
 *
 * The count is taken from the **database**, not from a process-local
 * counter. A process-local counter is reset on every restart and is not
 * shared between instances — which is exactly when a cap is needed.
 */
export const MAX_TRACKING_ATTEMPTS_PER_HOUR = 10;
