import {
  AdminNotificationKind,
  OrderStatus,
  PaymentAttemptOutcome,
  PaymentMethod,
  PaymentStatus,
  Prisma,
} from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { ORDER_ACTIONS, writeAuditEntry } from "@/lib/admin/audit";
import { createNotification } from "@/lib/admin/notifications";
import { db } from "@/lib/db";
import {
  allowsUnverifiedCallbacks,
  validatePayment,
  validatePaymentBySessionKey,
  type RawValidationResponse,
  type SslCommerzRail,
} from "@/lib/sslcommerz";

/**
 * The SSLCOMMERZ callback handler.
 *
 * ── The one thing this module exists to enforce ───────────────────────────
 *
 * **A callback is a claim, not a fact.**
 *
 * SSLCOMMERZ redirects the customer's browser to `/payment/success` with
 * a query string. That browser is under the customer's control. A
 * customer who opens the developer console can edit the URL to
 * `/payment/success?status=PAID&orderId=<any order>` — and if the shop
 * believed the query string, that customer would have a free order.
 *
 * So **no callback parameter is ever trusted on its own.** The callback
 * identifies the order, and then the shop asks SSLCOMMERZ directly:
 *
 *   1. The callback carries `val_id` — the gateway's own validation
 *      handle. The shop calls `validate(val_id)`, which is a
 *      server-to-server call the customer cannot forge or intercept.
 *
 *   2. If there is no `val_id` (the IPN's shape varies between gateway
 *      versions), the shop falls back to querying by the **session key**
 *      recorded on the order when the session was opened. Same thing:
 *      the query goes to the gateway, not to the customer.
 *
 *   3. The gateway's answer must say `VALID_TRANSACTION`, **and** the
 *      amount it recorded must match the order's own total.
 *
 * Only then does the payment move to `PAID`.
 *
 * ── Why the amount is compared ────────────────────────────────────────────
 *
 * The gateway telling us "this transaction is valid" answers "did a
 * payment happen?". It does not answer "was it the right payment?".
 *
 * A customer could open two sessions on one order, pay the cheaper one,
 * and return the callback from the other. The transaction is valid; the
 * amount is wrong. Comparing the gateway's recorded amount against the
 * order's total catches that, and it is the same arithmetic in the
 * other direction: poisha on one side, taka on the other.
 *
 * ── Why a failure does NOT write `FAILED` ────────────────────────────────
 *
 * The payment transition table treats `FAILED` as terminal. A declined
 * attempt is not a failed *payment* — it is a failed *attempt*, and the
 * customer may try again. So a failure leaves the payment at `PENDING`,
 * leaves the stock reserved, and is recorded as a `PaymentAttempt` row.
 *
 * This is the same rule the shop's own simulated gateway obeys, and for
 * the same reason: restoring the stock on a failure and then letting
 * the customer retry the *same* order would oversell.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 *
 * The customer may hit the success URL more than once — a refresh, a
 * back button, a double-submit on a slow connection. Every write here
 * is **conditional on the payment still being `PENDING`**, so the second
 * arrival matches zero rows and changes nothing. The second arrival
 * still returns a success page, because from the customer's point of
 * view it *is* a success — the payment is paid.
 */

/**
 * The parameters SSLCOMMERZ sends on a callback.
 *
 * Every field is optional: the gateway's exact shape varies between the
 * browser redirect, the server-to-server IPN, and the gateway versions.
 * A callback is read defensively and then **verified** against the
 * gateway — so a missing field is a problem the validation call
 * catches, not one that has to be guarded against here.
 */
export type SslCommerzCallbackParams = {
  /** The gateway's validation handle — what `validate()` takes. */
  readonly val_id?: string;
  /** The merchant's own reference — the order number. */
  readonly tran_id?: string;
  /** The order id, round-tripped through `value_a`. */
  readonly orderId?: string;
  /** The gateway's session key. */
  readonly sessionkey?: string;
  /** The gateway's own transaction id. */
  readonly bank_tran_id?: string;
  /** The amount, as the gateway recorded it, in taka. */
  readonly amount?: string;
  /** The status the gateway claims. Never trusted on its own. */
  readonly status?: string;
};

/**
 * Reads a callback parameter, trimmed.
 *
 * A blank string is `undefined`, not a blank string — the gateway
 * sometimes sends `value_c=` with nothing after the `=`, and an empty
 * string that reached a `where` clause would match nothing with a much
 * more confusing error message.
 */
function param(
  params: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = params[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * The result of handling a callback.
 */
export type SslCommerzCallbackResult = {
  /**
   * Whether the callback was **verified against the gateway**.
   *
   * This says the gateway itself vouched for the transaction. It is
   * `false` for a callback the shop could not confirm — including one
   * settled by the sandbox fallback, which the gateway never confirmed.
   */
  readonly verified: boolean;
  /**
   * Whether the payment was **settled**.
   *
   * This says the order now reads `PAID`. It is the question the
   * redirect asks: a settled payment redirects to a clean order URL,
   * because the order row is now the record.
   *
   * The two are separate because they can differ in exactly one case —
   * the sandbox fallback — and a field that conflated them would have to
   * lie about one of them.
   */
  readonly settled: boolean;
  /** The order the callback was about, when one was identified. */
  readonly orderId: string | null;
  /** The order number, for the page the customer is shown. */
  readonly orderNumber: string | null;
  /** The payment status after the callback was handled. */
  readonly paymentStatus: PaymentStatus | null;
  /** The gateway's own answer, for the log. */
  readonly gatewayStatus: string | null;
  /** A message for the customer, when something went wrong. */
  readonly message: string | null;
};

/**
 * The order shape a callback needs.
 */
type CallbackOrder = {
  id: string;
  orderNumber: string;
  userId: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  totalAmountPaisa: number;
  paymentGatewaySessionKey: string | null;
  paymentGatewayValidationId: string | null;
  paymentGatewayTransactionId: string | null;
  shippingAddress: unknown;
  user: { email: string; name: string };
};

const CALLBACK_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  totalAmountPaisa: true,
  paymentGatewaySessionKey: true,
  paymentGatewayValidationId: true,
  paymentGatewayTransactionId: true,
  shippingAddress: true,
  user: { select: { email: true, name: true } },
} as const;

/**
 * Finds the order a callback is about.
 *
 * ── The three handles, in order of trust ─────────────────────────────────
 *
 *   1. **`value_a`** — the order id, round-tripped verbatim by the
 *      gateway from the session we opened. This is the strongest handle
 *      we have, because *we* chose it when we opened the session and
 *      the gateway echoes it back untouched.
 *
 *   2. **`tran_id`** — the order number. It is our own reference, and
 *      the gateway echoes it too, but it is also the one a customer can
 *      most easily guess and edit, so it is used only to *find* the
 *      order, never to *trust* the callback.
 *
 *   3. **The recorded session key** — the last resort. If neither of the
 *      above identifies an order, the session key on every PENDING
 *      order is matched against the callback's `sessionkey`.
 *
 * Note that **finding** the order is not **believing** the callback.
 * Every path through this function ends at the same place: a
 * server-to-server call to the gateway. The handle only decides which
 * order to ask about.
 */
async function findCallbackOrder(
  params: SslCommerzCallbackParams,
): Promise<CallbackOrder | null> {
  const raw = params as unknown as Record<string, string | undefined>;

  const orderId = param(raw, "orderId") ?? param(raw, "value_a");
  const tranId = param(raw, "tran_id") ?? param(raw, "value_b");
  const sessionKey = param(raw, "sessionkey");

  if (orderId) {
    const byId = await db.order.findUnique({
      where: { id: orderId },
      select: CALLBACK_ORDER_SELECT,
    });

    if (byId) {
      return byId;
    }
  }

  if (tranId) {
    const byNumber = await db.order.findUnique({
      where: { orderNumber: tranId },
      select: CALLBACK_ORDER_SELECT,
    });

    if (byNumber) {
      return byNumber;
    }
  }

  if (sessionKey) {
    const bySession = await db.order.findFirst({
      where: { paymentGatewaySessionKey: sessionKey },
      select: CALLBACK_ORDER_SELECT,
    });

    if (bySession) {
      return bySession;
    }
  }

  return null;
}

/**
 * Asks the gateway whether a transaction is real.
 *
 * Two paths, and the second is a fallback rather than an equal
 * alternative:
 *
 *   1. `validate({ val_id })` — the gateway's own validation handle.
 *      This is the primary path, and it is the one the success
 *      redirect uses.
 *
 *   2. `transactionQueryBySessionId({ sessionkey })` — used when there
 *      is no `val_id`. The IPN in particular does not always carry one.
 *
 * **A network failure is not a valid transaction.**
 *
 * The `sslcommerz-lts` package's fetch helper catches its own errors
 * and *returns* them rather than throwing, so a call that never reached
 * the gateway can come back as an `Error` instance where a response
 * object was expected. The response is checked for being an object
 * before any field is read off it, so a network failure is treated as
 * "not verified" rather than crashing the handler or — much worse —
 * being read as a successful validation.
 */
async function verifyWithGateway(
  valId: string | undefined,
  sessionKey: string | undefined,
): Promise<{
  valid: boolean;
  raw: RawValidationResponse;
  status: string | null;
  rail: SslCommerzRail | null;
}> {
  const attempt = async (): Promise<{
    valid: boolean;
    raw: RawValidationResponse;
    status: string | null;
    rail: SslCommerzRail | null;
  }> => {
    try {
      const validation =
        valId !== undefined
          ? await validatePayment(valId)
          : sessionKey !== undefined
            ? await validatePaymentBySessionKey(sessionKey)
            : null;

      if (!validation) {
        return {
          valid: false,
          raw: {},
          status: null,
          rail: null,
        };
      }

      return {
        valid: validation.valid,
        raw: validation.raw,
        status: validation.raw.status ?? null,
        rail: validation.rail,
      };
    } catch (error) {
      console.error("[sslcommerz] Gateway validation failed:", error);

      return {
        valid: false,
        raw: {},
        status: null,
        rail: null,
      };
    }
  };

  /**
   * A response that is not an object is not a validation.
   *
   * The library's fetch helper returns the caught `Error` as the
   * resolved value when the request fails, so a network error arrives
   * here looking like a response. Reading `status` off an `Error`
   * would yield `undefined` — which happens to be falsy and so would
   * read as "not valid" by luck. This makes it deliberate.
   */
  const result = await attempt();

  if (typeof result.raw !== "object" || result.raw === null) {
    return { valid: false, raw: {}, status: null, rail: null };
  }

  return result;
}

/**
 * The amount the **callback** carried, in taka.
 *
 * Used only by the sandbox fallback, where the gateway did not report an
 * amount of its own. It is the customer's browser's claim — which is
 * why it is checked against the order's total rather than trusted.
 *
 * @returns The amount in taka, or `null` when the callback did not carry
 *          one, or carried something that is not a number.
 */
function callbackAmountTaka(
  params: SslCommerzCallbackParams,
): number | null {
  const raw = param(
    params as unknown as Record<string, string | undefined>,
    "amount",
  );

  if (!raw) {
    return null;
  }

  const amount = Number(raw);

  return Number.isFinite(amount) ? amount : null;
}

/**
 * Handles a **successful** payment callback.
 *
 * The happy path, and the only path in this file that moves money.
 *
 * ── The steps ─────────────────────────────────────────────────────────────
 *
 *   1. Find the order the callback is about.
 *   2. Ask SSLCOMMERZ whether the transaction is valid.
 *   3. Check the amount the gateway recorded against the order's total.
 *   4. Move the payment to `PAID`, conditionally.
 *   5. Record the gateway's handles on the order, and write the audit
 *      entry and the admin notification.
 *
 * @param params - The callback parameters, from the query string or the
 *        POST body.
 */
export async function handleSslCommerzSuccess(
  params: SslCommerzCallbackParams,
): Promise<SslCommerzCallbackResult> {
  const order = await findCallbackOrder(params);

  if (!order) {
    return {
      verified: false,
      settled: false,
      orderId: null,
      orderNumber: null,
      paymentStatus: null,
      gatewayStatus: null,
      message:
        "We could not find the order this payment belongs to. Please contact us.",
    };
  }

  /**
   * The validation handle.
   *
   * The callback's `val_id` is preferred; the one recorded on the order
   * is the fallback. The recorded one exists because the IPN sometimes
   * omits `val_id`, and a callback that has already been seen once has
   * a stored handle to fall back on.
   */
  const valId = param(
    params as unknown as Record<string, string | undefined>,
    "val_id",
  ) ?? order.paymentGatewayValidationId ?? undefined;

  const sessionKey =
    param(
      params as unknown as Record<string, string | undefined>,
      "sessionkey",
    ) ?? order.paymentGatewaySessionKey ?? undefined;

  const verification = await verifyWithGateway(valId, sessionKey);

  /**
   * Whether the callback may be settled **without** the gateway's
   * answer.
   *
   * Only ever true in the shop's own sandbox, with the flag explicitly
   * enabled. See `allowsUnverifiedCallbacks` for the three guard rails.
   *
   * It is read **once**, here, and it is `false` in every live
   * deployment — so the entire unverified-settles path below is dead
   * code against real money.
   */
  const unverifiedAllowed = allowsUnverifiedCallbacks();

  if (!verification.valid && !unverifiedAllowed) {
    /**
     * The gateway did not confirm the payment.
     *
     * The order is **not** touched. The customer is told the payment
     * could not be confirmed, and the shop's admin desk still sees the
     * order as `PENDING` — which is the honest state, because the money
     * may or may not have arrived and only the gateway can say.
     */
    return {
      verified: false,
      settled: false,
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      gatewayStatus: verification.status,
      message:
        "We could not confirm this payment with the gateway yet. If you were charged, our team will verify it and confirm your order shortly.",
    };
  }

  if (!verification.valid && unverifiedAllowed) {
    /**
     * The sandbox fallback.
     *
     * The gateway did not confirm the payment, but the shop is in
     * sandbox with the fallback explicitly enabled — so the callback is
     * settled anyway, and the order moves to `PAID` and `PROCESSING`
     * exactly as it would in production.
     *
     * This exists because the SSLCOMMERZ sandbox does not always issue
     * a validation handle the validation endpoint recognises. Without
     * it, a local test order sits at `PENDING` forever and the customer
     * is told "we could not confirm" on every visit — a loop that tells
     * the developer nothing and hides whether the rest of the flow
     * works.
     *
     * It is logged loudly, because a settled-without-verification
     * payment is not a normal event and the log is how anyone finds
     * out it happened.
     */
    console.warn(
      `[sslcommerz] Settling order ${order.orderNumber} from an UNVERIFIED ` +
        `callback — sandbox fallback. The gateway said: ` +
        `${verification.status ?? "nothing"}.`,
    );
  }

  /**
   * The amount check.
   *
   * The gateway recorded the amount it charged, in taka. The order's
   * total is in poisha. If they disagree, the wrong amount was paid —
   * and a valid-but-wrong payment must not mark the order `PAID`.
   *
   * In the **sandbox fallback** the gateway did not report an amount,
   * so the amount the **callback** carried is used instead. That is the
   * customer's own browser's claim, and it is exactly the value a
   * forged callback would send — which is why the fallback path still
   * checks it. A fallback callback that quotes the wrong amount is
   * refused, exactly as a verified one would be.
   */
  const gatewayAmountTaka = verification.raw.amount
    ? Number(verification.raw.amount)
    : callbackAmountTaka(params);

  const expectedTaka = Math.floor(order.totalAmountPaisa / 100);

  if (
    gatewayAmountTaka !== null &&
    Number.isFinite(gatewayAmountTaka) &&
    gatewayAmountTaka !== expectedTaka
  ) {
    console.error(
      `[sslcommerz] Amount mismatch for order ${order.orderNumber}: ` +
        `charged ${gatewayAmountTaka} BDT, order total is ${expectedTaka} BDT.`,
    );

    return {
      verified: false,
      settled: false,
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      gatewayStatus: verification.status,
      message:
        "The amount charged does not match this order. Our team will contact you to resolve it.",
    };
  }

  /**
   * The write.
   *
   * Conditional on `paymentStatus: PENDING`, so a replayed callback
   * matches zero rows and changes nothing. The transaction also writes
   * the audit entry and the notification, so all three commit together
   * or not at all.
   *
   * ── The two axes move together ──────────────────────────────────────────
   *
   * A settled gateway payment moves the payment to `PAID` **and** the
   * order to `PROCESSING`.
   *
   * The two are separate axes — a cash-on-delivery order is `SHIPPED`
   * while its payment is still `PENDING` — but they are not
   * independent *here*. The two moves share one fact: the gateway has
   * confirmed the money arrived. An order whose payment is `PAID` but
   * whose status is still `PENDING` reads to the customer as "we have
   * your money and we have not started" and to the admin desk as a
   * backlog item, when in truth it is a paid order waiting to be
   * dispatched.
   *
   * `PROCESSING` rather than a new `CONFIRMED` state, because
   * `PROCESSING` is already the shop's "paid and being handled" status
   * and already sits in the fulfilment transition table
   * (`PENDING → PROCESSING → SHIPPED`). The order is still in the
   * warehouse's queue; it has not shipped.
   *
   * The status move is **guarded**, not unconditional: it is applied
   * only when the order is still `PENDING`, so a callback arriving for
   * an order the admin has already moved to `SHIPPED` does not drag it
   * backwards to `PROCESSING`.
   */
  const updated = await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const result = await tx.order.updateMany({
        where: {
          id: order.id,
          paymentStatus: PaymentStatus.PENDING,
        },
        data: {
          paymentStatus: PaymentStatus.PAID,
          /**
           * The order moves to `PROCESSING` alongside the payment.
           *
           * Only from `PENDING` — an order the admin has already
           * dispatched keeps the status it was given.
           */
          ...(order.status === OrderStatus.PENDING
            ? { status: OrderStatus.PROCESSING }
            : {}),
          /**
           * The rail the customer actually paid with.
           *
           * The checkout writes the generic `CARD` value, because the
           * customer chooses their operator on the **gateway's** page —
           * after the order exists. The gateway then tells us which one
           * they chose, and that is written here, so the order row ends
           * up carrying the real rail and the order page can say "Paid
           * by bKash" rather than "Card Payment".
           *
           * It is written **only** over the generic `CARD` value. An
           * order already recorded as `BKASH` or `NAGAD` keeps its own
           * method — the gateway's `card_type` is a report of what it
           * processed, and it must not overwrite a rail the shop already
           * knows.
           */
          ...(verification.rail !== null &&
          order.paymentMethod === PaymentMethod.CARD
            ? { paymentMethod: verification.rail }
            : {}),
          paymentGatewayValidationId: valId ?? null,
          paymentGatewayBankTransactionId:
            verification.raw.bank_tran_id ?? null,
          paymentGatewayAmountTaka: gatewayAmountTaka,
          /**
           * The shop's own transaction reference.
           *
           * The order number plus `-GW`, the same shape the simulated
           * gateway uses — so the admin console reads one kind of
           * reference whatever gateway settled the order.
           */
          paymentGatewayTransactionId: order.paymentGatewayTransactionId ??
            `${order.orderNumber}-GW`,
        },
      });

      if (result.count === 0) {
        return false;
      }

      await writeAuditEntry(tx, {
        actor: {
          id: order.userId,
          name: order.user.name,
          email: order.user.email,
        },
        action: ORDER_ACTIONS.sslcommerzSettled,
        entityType: "order",
        entityId: order.id,
        before: {
          paymentStatus: PaymentStatus.PENDING,
          status: order.status,
        },
        after: {
          paymentStatus: PaymentStatus.PAID,
          status:
            order.status === OrderStatus.PENDING
              ? OrderStatus.PROCESSING
              : order.status,
          ...(verification.rail !== null &&
          order.paymentMethod === PaymentMethod.CARD
            ? { paymentMethod: verification.rail }
            : {}),
          bankTransactionId: verification.raw.bank_tran_id ?? null,
          amountTaka: gatewayAmountTaka,
        },
        reason: verification.valid
          ? "Payment confirmed by the SSLCOMMERZ gateway."
          : "Payment settled by the sandbox fallback — the gateway did not confirm it.",
      });

      await createNotification(tx, {
        kind: AdminNotificationKind.PAYMENT_SETTLED,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: order.user.name,
        totalAmountPaisa: order.totalAmountPaisa,
        /**
         * The rail the customer actually paid with.
         *
         * The same rule the order row follows: the gateway's rail wins
         * over the generic `CARD` the checkout wrote, and an order that
         * already knew its rail keeps it. The notification is a
         * snapshot, so it has to be the same snapshot the order row
         * holds — a bell that said "bKash" over an order the page
         * called a card would be the two disagreeing.
         */
        paymentMethod:
          verification.rail !== null &&
          order.paymentMethod === PaymentMethod.CARD
            ? verification.rail
            : order.paymentMethod,
      });

      return true;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  /**
   * The update matched no rows.
   *
   * Either the payment was already settled (a replayed callback — which
   * is a success, because the money is paid) or the order was
   * cancelled underneath us. The first is reported as a success; the
   * second as a failure, because the customer should not be told their
   * order is confirmed when it is not.
   */
  if (!updated && order.paymentStatus !== PaymentStatus.PAID) {
    return {
      verified: verification.valid,
      settled: false,
      orderId: order.id,
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      gatewayStatus: verification.status,
      message:
        "This order is no longer awaiting payment. Please contact us if you were charged.",
    };
  }

  return {
    /**
     * Whether the gateway vouched for it.
     *
     * In the sandbox fallback this is `false` — the gateway did not
     * confirm, and the callback was settled anyway because the shop is
     * in sandbox with the fallback enabled. The distinction is kept
     * because the audit trail needs it, and because a field that said
     * "verified" when nothing had been verified would be a lie in the
     * one place the truth matters most.
     */
    verified: verification.valid,
    /**
     * Whether the payment was settled.
     *
     * It was — the order reads `PAID` now. So the redirect goes to a
     * clean order URL, and the page renders the paid state from the
     * row.
     */
    settled: true,
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentStatus: PaymentStatus.PAID,
    gatewayStatus: verification.status,
    message: null,
  };
}

/**
 * Handles a **failed** or **cancelled** callback.
 *
 * Both paths mean the same thing to the shop: the customer did not pay.
 *
 * ── What is written, and what is not ─────────────────────────────────────
 *
 * A `PaymentAttempt` row is written, so the history shows that a
 * payment was attempted and declined.
 *
 * The order's `paymentStatus` is **not** moved to `FAILED`. The reason
 * is the same as everywhere else in the shop: `FAILED` is terminal in
 * the transition table, and a customer who was declined by their bank
 * has not failed — they have not finished. They can open a new gateway
 * session and try again, and the order and its stock reservation stay
 * live for exactly that.
 *
 * The customer is shown a failure page with a link back to the order,
 * so the retry is one click away.
 *
 * @param params - The callback parameters.
 */
export async function handleSslCommerzFailure(
  params: SslCommerzCallbackParams,
): Promise<SslCommerzCallbackResult> {
  const order = await findCallbackOrder(params);

  if (!order) {
    return {
      verified: false,
      settled: false,
      orderId: null,
      orderNumber: null,
      paymentStatus: null,
      gatewayStatus: param(
        params as unknown as Record<string, string | undefined>,
        "status",
      ) ?? null,
      message:
        "We could not find the order this payment belongs to. Please contact us.",
    };
  }

  const sessionKey =
    param(
      params as unknown as Record<string, string | undefined>,
      "sessionkey",
    ) ?? order.paymentGatewaySessionKey ?? undefined;

  /**
   * The attempt is recorded **once**.
   *
   * A customer who refreshes the failure page must not leave a trail of
   * a dozen identical attempts in the order's history. The attempt is
   * keyed on the session, and one attempt per session per order is
   * enough to answer "did they try, and did it work?".
   *
   * Note that the failure path does **not** consult the gateway. A
   * decline is the customer telling us the money did not move, and
   * there is nothing to verify — asking the gateway "did this fail?"
   * would only add a network call to a path whose answer is already
   * known. The *success* path is the one that has to be verified.
   */
  const alreadyRecorded = await db.paymentAttempt.findFirst({
    where: {
      orderId: order.id,
      ...(sessionKey ? { sessionId: sessionKey } : {}),
      outcome: PaymentAttemptOutcome.FAILED,
    },
    select: { id: true },
  });

  if (!alreadyRecorded) {
    await db.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await tx.paymentAttempt.create({
          data: {
            orderId: order.id,
            outcome: PaymentAttemptOutcome.FAILED,
            sessionId: sessionKey ?? null,
            failureMessage:
              "The payment was declined or cancelled at the gateway.",
          },
        });

        await writeAuditEntry(tx, {
          actor: {
            id: order.userId,
            name: order.user.name,
            email: order.user.email,
          },
          action: ORDER_ACTIONS.gatewaySettled,
          entityType: "order",
          entityId: order.id,
          before: { paymentStatus: order.paymentStatus },
          after: { paymentStatus: order.paymentStatus, outcome: "FAILED" },
          reason:
            "The customer was redirected back from the SSLCOMMERZ gateway without paying.",
        });

        await createNotification(tx, {
          kind: AdminNotificationKind.PAYMENT_FAILED,
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerName: order.user.name,
          totalAmountPaisa: order.totalAmountPaisa,
          paymentMethod: order.paymentMethod,
        });
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  }

  return {
    /**
     * A decline is not a verification.
     *
     * The failure path never asks the gateway whether the payment
     * failed — a decline is the customer telling us the money did not
     * move, and there is nothing to verify. So this reports what
     * happened, not what the gateway confirmed: the payment did **not**
     * settle.
     */
    verified: false,
    settled: false,
    orderId: order.id,
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    gatewayStatus:
      param(
        params as unknown as Record<string, string | undefined>,
        "status",
      ) ?? null,
    message: null,
  };
}

/**
 * Records the gateway's `val_id` on an order.
 *
 * The IPN arrives before the browser redirect, usually. It carries the
 * `val_id`, and storing it means the later success redirect can be
 * validated against the same handle instead of having to find one.
 */
export async function recordGatewayValidationId(
  orderId: string,
  valId: string,
): Promise<void> {
  await db.order.updateMany({
    where: { id: orderId },
    data: { paymentGatewayValidationId: valId },
  });
}

/**
 * Throws a 404 for an order that does not exist.
 *
 * Used by the callback routes when a callback names an order that is
 * not there at all — which is not something the customer can act on, so
 * the route answers with a plain "not found".
 */
export function assertCallbackOrderExists(order: {
  id: string;
} | null): asserts order is { id: string } {
  if (!order) {
    throw new ApiError("NOT_FOUND", "That order does not exist.");
  }
}
