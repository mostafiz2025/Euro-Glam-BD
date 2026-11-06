import { MockSmsGateway } from "./mock-gateway";
import type { SmsGateway } from "./adapter";

/**
 * Gateway selection.
 *
 * The `SMS_GATEWAY` environment variable chooses the implementation:
 *
 *   • `mock`        — the offline gateway. The default. No credentials,
 *                     no network, no messages leaving the machine.
 *   • `sslwireless` — the real provider. Requires `SSL_WIRELESS_API_KEY`.
 *
 * The real driver sits behind the `sslwireless` branch and is loaded
 * lazily, so in mock mode the provider code is never evaluated. That
 * matters because importing it would pull the provider code (and its
 * credential check) into every request, including the ones that must
 * work with no external dependency at all.
 */

export * from "./adapter";
export { MockSmsGateway, MOCK_GATEWAY_NAME } from "./mock-gateway";

/**
 * The supported gateway identifiers.
 */
export type SmsGatewayName = "mock" | "sslwireless";

/**
 * The gateway used when `SMS_GATEWAY` is unset or unrecognised.
 */
export const DEFAULT_SMS_GATEWAY: SmsGatewayName = "mock";

/**
 * Reads the configured gateway name.
 *
 * An unrecognised value falls back to `mock` rather than throwing. A typo
 * in a deployment variable should degrade to a working offline gateway,
 * not take the storefront down — and it logs loudly so the typo is
 * noticed.
 */
export function getSmsGatewayName(): SmsGatewayName {
  const raw = process.env.SMS_GATEWAY?.trim().toLowerCase();

  if (!raw || raw === "mock") return "mock";

  if (raw === "sslwireless") return "sslwireless";

  console.warn(
    `[sms] Unrecognised SMS_GATEWAY="${raw}". Falling back to "${DEFAULT_SMS_GATEWAY}".`,
  );

  return DEFAULT_SMS_GATEWAY;
}

/**
 * Returns the gateway for the current environment.
 *
 * @throws when `SMS_GATEWAY=sslwireless` but the provider driver is not
 *         available. This is a deployment error, and failing loudly at the
 *         point of use is correct — silently falling back to the mock
 *         would let a staging deployment look healthy while delivering
 *         no messages at all.
 */
export async function getSmsGateway(): Promise<SmsGateway> {
  if (getSmsGatewayName() === "sslwireless") {
    if (!process.env.SSL_WIRELESS_API_KEY?.trim()) {
      throw new Error(
        "SMS_GATEWAY=sslwireless requires SSL_WIRELESS_API_KEY to be set.",
      );
    }

    // ── The provider driver is not shipped yet ────────────────────────
    //
    // The real gateway lives behind this branch and is loaded lazily, so
    // the mock path never evaluates the provider code. The driver itself
    // is not part of this step: until it exists, selecting it is a
    // misconfiguration, and it must fail loudly rather than deliver
    // nothing while looking healthy.
    //
    // When the driver is added, this is the only line that changes.
    throw new Error(
      "SMS_GATEWAY=sslwireless is not available in this deployment: the SSL Wireless driver has not been installed.",
    );
  }

  return new MockSmsGateway();
}
