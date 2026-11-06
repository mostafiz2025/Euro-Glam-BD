import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EmailError,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  isEmailConfigured,
  readSmtpConfig,
  resetTransport,
} from "@/lib/email";

/**
 * The email transport's configuration.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The email sender has **no mock driver**, and that is the whole point.
 *
 * The SMS gateway has one: it writes to a table instead of sending, so a
 * developer never messages a real customer by accident. That is the
 * right default for SMS. It is the **wrong** default for email, because
 * the email carries a one-time password — the thing that proves a
 * customer owns an inbox. An email that is silently dropped is not a
 * degraded experience; it is a sign-in that appears to work and then
 * does not.
 *
 * So a missing credential is a **hard failure**. The tests below pin
 * that down: the configuration is read strictly, the defaults are
 * Gmail's, and a malformed port is reported rather than silently
 * corrected.
 *
 * A malformed port deserves its own case because the alternative — quietly
 * talking to a different port than the operator chose — is the kind of
 * failure that shows up as "mail is not arriving" weeks later.
 */

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  resetTransport();
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  resetTransport();
});

describe("readSmtpConfig", () => {
  it("reads the host, port and credentials from the environment", () => {
    process.env.EMAIL_HOST = "smtp.example.com";
    process.env.EMAIL_PORT = "465";
    process.env.EMAIL_USER = "shop@example.com";
    process.env.EMAIL_PASS = "app-password";

    expect(readSmtpConfig()).toEqual({
      host: "smtp.example.com",
      port: 465,
      user: "shop@example.com",
      pass: "app-password",
    });
  });

  it("defaults to Gmail's submission endpoint", () => {
    /*
     * Port 587 is the submission port: TLS is negotiated with STARTTLS
     * rather than from the first byte. Port 465 would be implicit TLS,
     * which works too, but 587 is what Google documents for
     * authenticated submission and what most hosts and firewalls expect.
     */
    process.env.EMAIL_USER = "shop@example.com";
    process.env.EMAIL_PASS = "app-password";

    const config = readSmtpConfig();

    expect(config.host).toBe(GMAIL_SMTP_HOST);
    expect(config.host).toBe("smtp.gmail.com");
    expect(config.port).toBe(GMAIL_SMTP_PORT);
    expect(config.port).toBe(587);
  });

  it("throws when the user is missing", () => {
    process.env.EMAIL_USER = "";
    process.env.EMAIL_PASS = "app-password";

    expect(() => readSmtpConfig()).toThrow(EmailError);
  });

  it("throws when the password is missing", () => {
    process.env.EMAIL_USER = "shop@example.com";
    delete process.env.EMAIL_PASS;

    expect(() => readSmtpConfig()).toThrow(EmailError);
  });

  it("throws when both are missing", () => {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;

    expect(() => readSmtpConfig()).toThrow(EmailError);
  });

  it("reports a missing configuration as NOT_CONFIGURED", () => {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;

    try {
      readSmtpConfig();
      expect.unreachable("readSmtpConfig should have thrown.");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailError);
      expect((error as EmailError).code).toBe("NOT_CONFIGURED");
    }
  });

  it("treats a whitespace-only credential as missing", () => {
    process.env.EMAIL_USER = "   ";
    process.env.EMAIL_PASS = "app-password";

    expect(() => readSmtpConfig()).toThrow(EmailError);
  });

  it("trims the credentials", () => {
    process.env.EMAIL_USER = "  shop@example.com  ";
    process.env.EMAIL_PASS = "  app-password  ";

    const config = readSmtpConfig();

    expect(config.user).toBe("shop@example.com");
    expect(config.pass).toBe("app-password");
  });

  it("rejects a malformed port rather than correcting it", () => {
    /*
     * A deployment that meant port 465 and got a typo should be told,
     * rather than quietly talking to a different port than the one its
     * operator chose.
     */
    process.env.EMAIL_USER = "shop@example.com";
    process.env.EMAIL_PASS = "app-password";
    process.env.EMAIL_PORT = "four-sixty-five";

    try {
      readSmtpConfig();
      expect.unreachable("readSmtpConfig should have thrown.");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailError);
      expect((error as EmailError).code).toBe("NOT_CONFIGURED");
      expect((error as EmailError).message).toContain("EMAIL_PORT");
    }
  });

  it("rejects a port outside the valid range", () => {
    process.env.EMAIL_USER = "shop@example.com";
    process.env.EMAIL_PASS = "app-password";

    for (const port of ["0", "-1", "70000"]) {
      process.env.EMAIL_PORT = port;

      expect(() => readSmtpConfig()).toThrow(EmailError);
    }
  });
});

describe("isEmailConfigured", () => {
  it("is true when both credentials are present", () => {
    process.env.EMAIL_USER = "shop@example.com";
    process.env.EMAIL_PASS = "app-password";

    expect(isEmailConfigured()).toBe(true);
  });

  it("is false when the user is missing", () => {
    delete process.env.EMAIL_USER;
    process.env.EMAIL_PASS = "app-password";

    expect(isEmailConfigured()).toBe(false);
  });

  it("is false when the password is missing", () => {
    process.env.EMAIL_USER = "shop@example.com";
    delete process.env.EMAIL_PASS;

    expect(isEmailConfigured()).toBe(false);
  });

  it("is false when both are missing", () => {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;

    expect(isEmailConfigured()).toBe(false);
  });
});
