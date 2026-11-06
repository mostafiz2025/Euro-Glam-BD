import { SmsGatewayError, type SmsGateway, type SmsMessage, type SmsSendResult } from "./adapter";

/**
 * The mock SMS gateway.
 *
 * ── What "sending" means here ──────────────────────────────────────────
 *
 * Nothing leaves the machine. The mock validates the message, decides it
 * would have been accepted, and returns a provider reference. The actual
 * record of what was "sent" is the `SmsLog` row the service layer writes
 * — the same row a real provider's send would produce.
 *
 * So the MVP exercises the **whole** workflow — the consent gate, the
 * idempotency claim, the log write, the failure path — with no external
 * dependency at all. Only the last hop is replaced.
 */

/**
 * The provider identifier recorded on `SmsLog.provider`.
 */
export const MOCK_GATEWAY_NAME = "mock";

/**
 * The mock gateway.
 */
export class MockSmsGateway implements SmsGateway {
  readonly name = MOCK_GATEWAY_NAME;

  /**
   * The messages this gateway was asked to send.
   *
   * Exposed so a test can assert on what *would* have been sent without
   * reading the database. A production gateway has no equivalent, which
   * is why no production code may depend on it — the service layer only
   * ever sees the `SmsGateway` interface.
   */
  readonly sent: SmsMessage[] = [];

  /**
   * The keys this gateway has already accepted.
   *
   * The mock enforces idempotency the same way the database does, so a
   * double-send is caught in the test as well as in production.
   */
  private readonly seenKeys = new Set<string>();

  /**
   * When set, every send fails with this error.
   *
   * Lets a test exercise the failure path without a broken provider.
   */
  failure: SmsGatewayError | null = null;

  async send(message: SmsMessage): Promise<SmsSendResult> {
    if (this.failure) {
      throw this.failure;
    }

    if (this.seenKeys.has(message.idempotencyKey)) {
      throw new SmsGatewayError(
        "SEND_FAILED",
        MOCK_GATEWAY_NAME,
        `A message with the idempotency key "${message.idempotencyKey}" has already been sent.`,
      );
    }

    this.seenKeys.add(message.idempotencyKey);
    this.sent.push(message);

    return {
      ok: true,
      // A deterministic reference derived from the key, so a test can
      // assert on it and a run is reproducible.
      providerMessageId: `mock_${message.idempotencyKey.replace(/[^a-zA-Z0-9]/g, "_")}`,
    };
  }
}
