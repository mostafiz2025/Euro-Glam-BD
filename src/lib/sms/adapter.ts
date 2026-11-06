/**
 * The SMS gateway interface.
 *
 * ── Why an abstraction ──────────────────────────────────────────────────
 *
 * The MVP writes messages to the `sms_logs` table instead of sending them.
 * The interface exists so the driver can be swapped for a real provider
 * — SSL Wireless, for Bangladeshi operators — without touching a single
 * call site.
 *
 * The important consequence of that design rule is this one:
 *
 *   **The idempotency key travels with the message.**
 *
 * `SmsLog.idempotencyKey` is `@unique`, and the key is derived from the
 * order item id, so a re-run of the sweep cannot double-send. The key is
 * part of the message rather than something the gateway computes, because
 * the key that protects against a double-send has to be the *same* key
 * the database enforces.
 *
 * The interface is deliberately narrow — one operation. There is no
 * delivery-status callback, no scheduling, no bulk send. The MVP does
 * not need them, and a wide interface is harder to implement for every
 * future driver.
 */

/**
 * A message to send.
 */
export type SmsMessage = {
  /**
   * The destination number, in the normalised `+880…` form.
   */
  readonly to: string;
  /**
   * The message body.
   *
   * A body must never contain a shipping address. An SMS is forwarded
   * and read by other people.
   */
  readonly body: string;
  /**
   * The key that makes a send idempotent.
   *
   * Deterministic, and derived from the thing being reminded about — so
   * the same reminder is always the same key, and the unique constraint
   * on `SmsLog.idempotencyKey` is what actually prevents a double-send.
   */
  readonly idempotencyKey: string;
};

/**
 * The outcome of a send.
 */
export type SmsSendResult = {
  /** True when the provider accepted the message. */
  readonly ok: boolean;
  /**
   * The provider's own reference for the message, when it has one.
   *
   * Recorded on the log row for support: it lets an admin ask the
   * provider what happened to a specific message.
   */
  readonly providerMessageId?: string;
  /**
   * A machine-readable failure code, when `ok` is false.
   */
  readonly errorCode?: string;
};

/**
 * The SMS gateway interface.
 */
export interface SmsGateway {
  /** The provider identifier recorded on `SmsLog.provider`. */
  readonly name: string;
  /**
   * Sends a message.
   *
   * @throws SmsGatewayError when the provider is unavailable or refuses
   *         the message.
   */
  send(message: SmsMessage): Promise<SmsSendResult>;
}

/**
 * The error thrown when a gateway fails.
 *
 * A dedicated class, so the service layer can distinguish a provider
 * outage (record the failure, move on to the next reminder) from a
 * bad request (record the failure with a different code).
 */
export class SmsGatewayError extends Error {
  readonly code: "INVALID_PHONE" | "PROVIDER_UNAVAILABLE" | "SEND_FAILED";
  readonly providerName: string;
  readonly cause?: unknown;

  constructor(
    code: SmsGatewayError["code"],
    providerName: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SmsGatewayError";
    this.code = code;
    this.providerName = providerName;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
