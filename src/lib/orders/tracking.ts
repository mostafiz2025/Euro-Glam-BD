import type { OrderStatus, PaymentMethod, PaymentStatus } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import {
  emailMatches,
  normaliseOrderNumber,
  phoneMatches,
} from "@/lib/format/order-tracking";
import { MAX_TRACKING_ATTEMPTS_PER_HOUR } from "@/lib/validation/tracking";

/**
 * The guest order-tracking service.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A customer who has paid for something they cannot see wants to know
 * where it is. Most of them will have an account; some will not. The
 * ones who will not — because they ordered as a guest, or because they
 * signed up with a different email, or because they simply never made
 * an account — had exactly one option before: telephone the shop.
 *
 * So the shop reads the order from the database, on request, for anybody
 * who can prove the order is theirs.
 *
 * ── The rule that governs this file ───────────────────────────────────────
 *
 * **A tracking request proves an identity, so it is bounded tightly.**
 *
 * The endpoint is public, and it is a **search**. Two things bound it:
 *
 *   1. **The contact detail.** An order number alone is not enough,
 *      because an order number is printed on a parcel, quoted over the
 *      phone and pasted into a chat window. The customer must also
 *      supply a contact detail that is on the order — the account's
 *      email address, or the delivery phone number.
 *
 *   2. **The hourly limit.** The contact detail is a secret the customer
 *      holds and an attacker does not, but a secret alone does not make
 *      a guess *expensive*. The limit does that.
 *
 * ── The rule that governs the failure ─────────────────────────────────────
 *
 * **A wrong answer must not be a different answer.**
 *
 * Three failures are possible:
 *
 *   • the order number is mistyped;
 *   • the order number is real but belongs to nobody here;
 *   • the order number is real and the contact detail is wrong.
 *
 * All three produce the **same** answer — a `404` with the same
 * message. If they produced different answers, the endpoint would be an
 * enumeration oracle: an attacker could tell a mistyped number from a
 * real one, and would only have to solve the second problem to harvest
 * the shop's order numbers.
 *
 * The same reasoning applies to the **rate limit**. The limit counts
 * failures against the order number that was tried, whether or not that
 * number belongs to an order — so a candidate number that starts
 * answering `RATE_LIMITED` tells the attacker nothing, because a real
 * number behaves identically.
 */

/**
 * The shape of an order, as the tracking endpoint returns it.
 *
 * Deliberately **narrow**. A tracking page shows the status, the total
 * and the items — it does not need the payment transaction ids, the
 * gateway handles, the coupon breakdown or the delivery notes. Every
 * column that is not needed is a column that could leak.
 */
export type TrackedOrder = {
  /** The order's human-readable reference. */
  readonly orderNumber: string;
  /** Where the order is in the fulfilment pipeline. */
  readonly status: OrderStatus;
  /** Where the money is. */
  readonly paymentStatus: PaymentStatus;
  /** How the customer is paying. */
  readonly paymentMethod: PaymentMethod;
  /** The total, in poisha. */
  readonly totalAmountPaisa: number;
  /** The number of items on the order. */
  readonly totalQuantity: number;
  /** When the order was placed. */
  readonly placedAt: string;
  /** The lines, as they were ordered. */
  readonly items: ReadonlyArray<{
    readonly name: string;
    readonly quantity: number;
    readonly pricePaisa: number;
  }>;
};

/**
 * The result of a tracking lookup.
 *
 * `null` means "no match". It is the **only** negative answer, and it
 * means the same thing whether the number was mistyped, unknown, or
 * paired with the wrong contact detail.
 */
export type TrackingLookup = TrackedOrder | null;

/**
 * The delivery phone number on an order.
 *
 * `Order.shippingAddress` is a `Json` column, so its shape is whatever
 * was written into it — and the shop writes it in **two** ways:
 *
 *   • The **checkout** writes `+880XXXXXXXXX`, because `bdPhoneSchema`
 *     normalises it.
 *   • An **admin-created** order — a telephone order taken by an
 *     operator — carries whatever the operator typed, because the admin
 *     form's phone field is a free string.
 *
 * So the phone is read defensively: it may be a string, it may be
 * missing, and it may be something else entirely. Anything that is not
 * a string is treated as absent — which is the safe direction, because
 * "absent" simply means one fewer way for the contact detail to match.
 */
function deliveryPhone(shippingAddress: unknown): string {
  if (typeof shippingAddress !== "object" || shippingAddress === null) {
    return "";
  }

  const phone = (shippingAddress as { phone?: unknown }).phone;

  return typeof phone === "string" ? phone : "";
}

/**
 * Looks up an order for a guest, proving ownership with a contact detail.
 *
 * @param orderNumber - The number as the customer typed it.
 * @param contact     - The email address or phone number on the order.
 *
 * @returns The order, or `null` when the number is unknown or the
 *          contact detail does not match.
 *
 * @throws ApiError 429 when the hourly limit for this order number has
 *         been reached.
 */
export async function trackOrder(
  orderNumber: string,
  contact: string,
): Promise<TrackingLookup> {
  /*
   * The number is normalised **before** anything else.
   *
   * A customer who types "egb 20261104 a1b2c3" has given a perfectly
   * good number, and a form that refused it would be refusing to help.
   * The normalisation turns every spelling into the canonical form — or
   * into `null`, which means "this is not shaped like an order number".
   */
  const canonical = normaliseOrderNumber(orderNumber);

  /*
   * A number that is not shaped like an order number is a **failure**,
   * and it fails without touching the database.
   *
   * It is not recorded, and it is not counted against the limit, and it
   * costs one regular expression. The reasoning is that a malformed
   * number cannot be a guess at a real order: the shop's numbers have
   * one shape, that shape is public knowledge (it is printed on every
   * parcel), and a string that does not have it is not a candidate.
   *
   * The alternative — recording it against a shared "malformed" bucket
   * — would hand an attacker a denial of service for free: ten
   * malformed requests an hour would lock out **every** customer whose
   * number did not parse, and the shop's own customers mistype numbers
   * more often than an attacker does.
   *
   * The answer is the same `null` as every other failure. The endpoint
   * does not tell the customer their number is malformed, because "that
   * is not an order number" and "we could not find that order" are the
   * same answer here — and one of them is a useful signal to an
   * attacker probing the shape of the shop's order numbers.
   */
  if (canonical === null) {
    return null;
  }

  /*
   * The limit is checked **before** the lookup.
   *
   * Checking it afterwards would mean the cap is enforced on the answer
   * rather than on the work: an attacker gets their guesses for free and
   * is only told to stop once they have guessed. The limit is a cost
   * imposed on the *attempt*, so it has to be read before the attempt.
   */
  await assertWithinRateLimit(canonical);

  const order = await db.order.findUnique({
    where: { orderNumber: canonical },
    select: {
      orderNumber: true,
      status: true,
      paymentStatus: true,
      paymentMethod: true,
      totalAmountPaisa: true,
      createdAt: true,
      shippingAddress: true,
      user: { select: { email: true } },
      items: {
        select: {
          productName: true,
          quantity: true,
          pricePaisa: true,
        },
      },
    },
  });

  /*
   * No order.
   *
   * The attempt is recorded as a failure against the number that was
   * tried — even though no order matched. See the note on the model:
   * the limit must move identically for a number that exists and one
   * that does not, or the limit itself becomes an enumeration oracle.
   */
  if (!order) {
    await recordAttempt(canonical, false);

    return null;
  }

  /*
   * The contact detail.
   *
   * Two details are accepted, and either one is enough:
   *
   *   • the **account's** email address — `User.email`, which is the
   *     address the order was placed under;
   *   • the **delivery** phone number — which is on the order's
   *     shipping address, and which is frequently *not* the account
   *     phone (a customer may order for somebody else).
   *
   * The customer is asked for whichever they have. The shop does not
   * know which, and requiring both would refuse to help a customer who
   * remembers only one.
   *
   * The comparison is on the **national digits** for a phone, because
   * the two orders of the shop store the same number differently — see
   * `phoneMatches` for why a string comparison would be wrong.
   */
  const phone = deliveryPhone(order.shippingAddress);
  const email = order.user.email;

  const matches =
    emailMatches(contact, email) || phoneMatches(contact, phone);

  if (!matches) {
    await recordAttempt(canonical, false);

    return null;
  }

  /*
   * A success.
   *
   * It is recorded too — not because it counts against the limit (only
   * failures do) but because a ledger of *successful* lookups is how
   * the shop can answer "when did this customer last check?" without
   * reading the order's own timestamps.
   */
  await recordAttempt(canonical, true);

  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    totalAmountPaisa: order.totalAmountPaisa,
    totalQuantity: order.items.reduce(
      (total, item) => total + item.quantity,
      0,
    ),
    placedAt: order.createdAt.toISOString(),
    items: order.items.map((item) => ({
      name: item.productName,
      quantity: item.quantity,
      pricePaisa: item.pricePaisa,
    })),
  };
}

/**
 * Refuses the request when too many attempts have been made against this
 * order number in the last hour.
 *
 * The count comes from the **database**, so it holds across every
 * instance of the deployment. A process-local counter would be reset on
 * every restart and would not be shared between instances — which is
 * exactly when a cap is needed.
 *
 * Only the **failures** are counted. A success has already proved the
 * caller knows the contact detail, so it is not a guess — and counting
 * it would mean a customer who checks their order five times in an hour
 * eventually locks themselves out of their own order.
 */
async function assertWithinRateLimit(orderNumber: string): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const failures = await db.orderTrackingAttempt.count({
    where: {
      orderNumber,
      succeeded: false,
      createdAt: { gte: oneHourAgo },
    },
  });

  if (failures >= MAX_TRACKING_ATTEMPTS_PER_HOUR) {
    throw new ApiError(
      "RATE_LIMITED",
      "Too many attempts for this order number. Please try again in an hour, or contact the shop if you need help sooner.",
    );
  }
}

/**
 * How long an attempt is kept.
 *
 * The ledger exists to enforce an hourly limit, so an hour of history is
 * all the limit needs. The extra day is slack — it keeps the table small
 * without making the prune fussy about the boundary.
 */
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The shortest gap between two prunes.
 */
const PRUNE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The earliest moment the next prune may run.
 *
 * The prune is a `DELETE` over the whole table's age range, and running
 * it on every attempt would put an unbounded write on the hot path of a
 * **public** endpoint — a cheap way to make the shop's own database
 * work harder as the traffic rises.
 *
 * So it runs at most once every fifteen minutes. The interval is
 * process-local, and that is deliberate: the prune is a housekeeping
 * task, not a limit, and a process that restarts simply prunes a
 * little later. The **limit** — the thing that actually has to be
 * consistent across instances — is counted from the database.
 */
let nextPruneAt = 0;

/**
 * Records an attempt in the ledger.
 *
 * The write is **best-effort**. A failure to record must not fail the
 * lookup: the customer is owed an answer, and an answer that arrives
 * with a ledger gap is much better than no answer.
 */
async function recordAttempt(
  orderNumber: string,
  succeeded: boolean,
): Promise<void> {
  await db.orderTrackingAttempt
    .create({ data: { orderNumber, succeeded } })
    .catch((error: unknown) => {
      console.error("[tracking] The attempt was not recorded:", error);
    });

  /*
   * The prune.
   *
   * The ledger is a working record, not an archive — nothing ever reads
   * the rows except the hourly count, and the count only ever looks
   * back an hour. So rows older than the retention window are removed.
   *
   * It is a separate statement rather than a cascade, because the
   * `DELETE` is what keeps the table from growing without bound, and it
   * must not be able to fail the write that precedes it.
   */
  const now = Date.now();

  if (now < nextPruneAt) return;

  nextPruneAt = now + PRUNE_INTERVAL_MS;

  const cutoff = new Date(now - ATTEMPT_RETENTION_MS);

  await db.orderTrackingAttempt
    .deleteMany({ where: { createdAt: { lt: cutoff } } })
    .catch((error: unknown) => {
      console.error("[tracking] The old attempts were not pruned:", error);
    });
}
