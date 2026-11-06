import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SMS_GATEWAY,
  MOCK_GATEWAY_NAME,
  MockSmsGateway,
  getSmsGateway,
  getSmsGatewayName,
} from "@/lib/sms";
import { SmsGatewayError } from "@/lib/sms/adapter";

/**
 * Gateway selection and the mock driver.
 *
 * The selection rules are deliberately asymmetric, and the tests lock
 * that asymmetry down:
 *
 *   • An **unrecognised** `SMS_GATEWAY` value warns and falls back to
 *     the mock. A typo in a deployment variable should not take the
 *     storefront down.
 *
 *   • A **missing credential** throws. A deployment that would message
 *     real customers must not silently deliver nothing while looking
 *     healthy.
 */

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("getSmsGatewayName", () => {
  it("defaults to mock when the variable is unset", () => {
    delete process.env.SMS_GATEWAY;

    expect(getSmsGatewayName()).toBe("mock");
    expect(getSmsGatewayName()).toBe(DEFAULT_SMS_GATEWAY);
  });

  it("returns mock for the explicit value", () => {
    process.env.SMS_GATEWAY = "mock";

    expect(getSmsGatewayName()).toBe("mock");
  });

  it("returns sslwireless for the explicit value", () => {
    process.env.SMS_GATEWAY = "sslwireless";

    expect(getSmsGatewayName()).toBe("sslwireless");
  });

  it("ignores surrounding whitespace and case", () => {
    process.env.SMS_GATEWAY = "  SSLWireless  ";

    expect(getSmsGatewayName()).toBe("sslwireless");
  });

  it("warns and falls back to mock for an unrecognised value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    process.env.SMS_GATEWAY = "twilio";

    expect(getSmsGatewayName()).toBe("mock");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("twilio");
    expect(warn.mock.calls[0]?.[0]).toContain("mock");
  });

  it("treats an empty value as unset", () => {
    process.env.SMS_GATEWAY = "   ";

    expect(getSmsGatewayName()).toBe("mock");
  });
});

describe("getSmsGateway", () => {
  it("returns the mock gateway in mock mode", async () => {
    process.env.SMS_GATEWAY = "mock";

    const gateway = await getSmsGateway();

    expect(gateway.name).toBe(MOCK_GATEWAY_NAME);
  });

  it("returns the mock gateway when the variable is unset", async () => {
    delete process.env.SMS_GATEWAY;

    const gateway = await getSmsGateway();

    expect(gateway.name).toBe(MOCK_GATEWAY_NAME);
  });

  it("throws when sslwireless has no API key", async () => {
    process.env.SMS_GATEWAY = "sslwireless";
    delete process.env.SSL_WIRELESS_API_KEY;

    await expect(getSmsGateway()).rejects.toThrow(
      /SSL_WIRELESS_API_KEY/,
    );
  });

  it("throws when the API key is only whitespace", async () => {
    process.env.SMS_GATEWAY = "sslwireless";
    process.env.SSL_WIRELESS_API_KEY = "   ";

    await expect(getSmsGateway()).rejects.toThrow(
      /SSL_WIRELESS_API_KEY/,
    );
  });

  it("does not fall back to the mock when a credential is missing", async () => {
    // The dangerous failure mode is a deployment that looks healthy and
    // delivers nothing. It must fail loudly instead.
    process.env.SMS_GATEWAY = "sslwireless";
    delete process.env.SSL_WIRELESS_API_KEY;

    await expect(getSmsGateway()).rejects.toThrow();
  });
});

describe("MockSmsGateway", () => {
  it("accepts a message and returns a provider reference", async () => {
    const gateway = new MockSmsGateway();

    const result = await gateway.send({
      to: "+8801700000000",
      body: "Hello",
      idempotencyKey: "reminder:item-1",
    });

    expect(result.ok).toBe(true);
    expect(result.providerMessageId).toBe("mock_reminder_item_1");
    expect(gateway.sent).toHaveLength(1);
  });

  it("records the message it was asked to send", async () => {
    const gateway = new MockSmsGateway();

    const message = {
      to: "+8801700000000",
      body: "Hello",
      idempotencyKey: "reminder:item-2",
    };

    await gateway.send(message);

    expect(gateway.sent[0]).toEqual(message);
  });

  it("refuses a duplicate idempotency key", async () => {
    // The mock enforces idempotency the same way the database does, so
    // a double-send is caught in the test as well as in production.
    const gateway = new MockSmsGateway();

    const message = {
      to: "+8801700000000",
      body: "Hello",
      idempotencyKey: "reminder:item-3",
    };

    await gateway.send(message);

    await expect(gateway.send(message)).rejects.toThrow(SmsGatewayError);
    expect(gateway.sent).toHaveLength(1);
  });

  it("reports the provider name on a failure", async () => {
    const gateway = new MockSmsGateway();

    gateway.failure = new SmsGatewayError(
      "PROVIDER_UNAVAILABLE",
      MOCK_GATEWAY_NAME,
      "The provider is down.",
    );

    await expect(
      gateway.send({
        to: "+8801700000000",
        body: "Hello",
        idempotencyKey: "reminder:item-4",
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      providerName: MOCK_GATEWAY_NAME,
    });
  });

  it("does not record a message it refused to send", async () => {
    const gateway = new MockSmsGateway();

    gateway.failure = new SmsGatewayError(
      "SEND_FAILED",
      MOCK_GATEWAY_NAME,
      "Nope.",
    );

    await expect(
      gateway.send({
        to: "+8801700000000",
        body: "Hello",
        idempotencyKey: "reminder:item-5",
      }),
    ).rejects.toThrow();

    expect(gateway.sent).toHaveLength(0);
  });
});
