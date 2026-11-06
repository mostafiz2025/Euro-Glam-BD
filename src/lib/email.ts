import nodemailer, { type Transporter } from "nodemailer";

/**
 * The email sender.
 *
 * ── The rule that governs this file ───────────────────────────────────────
 *
 * **A missing credential is a hard failure, never a silent no-op.**
 *
 * The storefront has a mock SMS gateway that writes to a table instead of
 * sending, so that a developer never sends a real message by accident.
 * That is the right default for SMS. It is the **wrong** default for
 * email, because email here carries a **one-time password** — the thing
 * that proves a customer owns an inbox. An email that is silently
 * dropped is not a degraded experience; it is a sign-in that appears to
 * work and then does not.
 *
 * So there is no mock driver here. If the transport cannot be built, the
 * module throws at first use, and the route returns a `503` that says
 * exactly that. A deployment that cannot send email must **say so**, not
 * look healthy while delivering nothing.
 *
 * ── Why the transport is built lazily ────────────────────────────────────
 *
 * `nodemailer.createTransport` reads the environment and validates the
 * credentials. Building it at module load would make the whole
 * application fail to boot when the mail settings are absent — including
 * the storefront, which does not need email to serve a product page.
 *
 * The transport is therefore built on first use and cached. The cost is
 * one transport per process, which is what a pooled SMTP connection is
 * for.
 */

/**
 * The Gmail SMTP endpoint.
 *
 * Port 587 is the submission port: TLS is negotiated with STARTTLS
 * rather than from the first byte. Port 465 would be implicit TLS, which
 * works too, but 587 is what Google documents for authenticated
 * submission and what most hosts and firewalls expect.
 */
export const GMAIL_SMTP_HOST = "smtp.gmail.com";
export const GMAIL_SMTP_PORT = 587;

/**
 * The SMTP configuration.
 */
export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
};

/**
 * Thrown when the email cannot be sent.
 *
 * A dedicated class, so a caller can distinguish "the mail server is
 * down" from "the message was rejected" — the first is worth retrying,
 * the second usually is not.
 */
export class EmailError extends Error {
  readonly code: "NOT_CONFIGURED" | "SEND_FAILED";
  readonly cause?: unknown;

  constructor(
    code: EmailError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "EmailError";
    this.code = code;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * The cached transport.
 *
 * `undefined` means "not built yet"; `null` means "we tried and it
 * failed", so a misconfigured deployment does not retry the construction
 * on every request and flood the logs.
 */
let cachedTransport: Transporter | null | undefined;

/**
 * Reads the SMTP credentials from the environment.
 *
 * @throws EmailError when the credentials are missing or incomplete.
 */
export function readSmtpConfig(): SmtpConfig {
  const user = process.env.EMAIL_USER?.trim();
  const pass = process.env.EMAIL_PASS?.trim();

  if (!user || !pass) {
    throw new EmailError(
      "NOT_CONFIGURED",
      "Email is not configured. Set EMAIL_USER and EMAIL_PASS in the environment.",
    );
  }

  return {
    host: process.env.EMAIL_HOST?.trim() || GMAIL_SMTP_HOST,
    port: readPort(process.env.EMAIL_PORT),
    user,
    pass,
  };
}

/**
 * Reads the SMTP port, falling back to Gmail's submission port.
 *
 * A malformed port is a **configuration error**, not something to
 * silently correct: a deployment that meant port 465 and got a typo
 * should be told, rather than quietly talking to a different port than
 * the one its operator chose.
 */
function readPort(raw: string | undefined): number {
  if (!raw) return GMAIL_SMTP_PORT;

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new EmailError(
      "NOT_CONFIGURED",
      `EMAIL_PORT must be a valid port number (got "${raw}").`,
    );
  }

  return parsed;
}

/**
 * Builds the transport, or returns the cached one.
 *
 * @throws EmailError when the credentials are missing or the transport
 *         cannot be constructed.
 */
export function getTransport(): Transporter {
  if (cachedTransport !== undefined) {
    if (cachedTransport === null) {
      throw new EmailError(
        "NOT_CONFIGURED",
        "Email is not configured. Set EMAIL_USER and EMAIL_PASS in the environment.",
      );
    }

    return cachedTransport;
  }

  let config: SmtpConfig;

  try {
    config = readSmtpConfig();
  } catch (error) {
    cachedTransport = null;
    throw error;
  }

  cachedTransport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    /**
     * STARTTLS is **required**, not optional.
     *
     * Gmail refuses the credentials over an unencrypted connection, and
     * an app password is a bearer secret — sending it in the clear
     * would hand it to anyone on the path. `requireTLS` makes Nodemailer
     * refuse to fall back to plaintext rather than trusting the server
     * to negotiate it.
     */
    secure: false,
    requireTLS: true,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  return cachedTransport;
}

/**
 * Clears the cached transport.
 *
 * Used by the tests, and by a deployment that rotates its credentials
 * without restarting the process.
 */
export function resetTransport(): void {
  cachedTransport = undefined;
}

/**
 * A message to send.
 */
export type EmailMessage = {
  /** The recipient. */
  readonly to: string;
  /** The subject line. */
  readonly subject: string;
  /** The HTML body. */
  readonly html: string;
  /** The plain-text body. */
  readonly text: string;
  /** The sender's display name and address. */
  readonly from?: string;
};

/**
 * The outcome of a send.
 */
export type EmailSendResult = {
  /** True when the SMTP server accepted the message. */
  readonly ok: boolean;
  /** The provider's own message id, when it has one. */
  readonly messageId?: string;
};

/**
 * The sender's address.
 *
 * Falls back to the SMTP user, because Gmail rejects a `From` header
 * that is not an address on the authenticated account (or a configured
 * alias for it).
 */
function resolveFrom(): string {
  const configured = process.env.EMAIL_FROM?.trim();

  if (configured) return configured;

  const user = process.env.EMAIL_USER?.trim();

  if (!user) {
    throw new EmailError(
      "NOT_CONFIGURED",
      "Email is not configured. Set EMAIL_USER and EMAIL_PASS in the environment.",
    );
  }

  return `"Euro Glam BD" <${user}>`;
}

/**
 * Sends an email.
 *
 * @throws EmailError when the transport is not configured or the send
 *         fails.
 */
export async function sendEmail(
  message: EmailMessage,
): Promise<EmailSendResult> {
  const transport = getTransport();

  try {
    const info = await transport.sendMail({
      from: message.from ?? resolveFrom(),
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    return {
      ok: true,
      ...(typeof info.messageId === "string"
        ? { messageId: info.messageId }
        : {}),
    };
  } catch (error) {
    console.error("[email] The message could not be sent:", error);

    throw new EmailError(
      "SEND_FAILED",
      "The email could not be sent. Please try again shortly.",
      error,
    );
  }
}

/**
 * Whether email is configured at all.
 *
 * Used by the health endpoint, so a deployment can report a missing mail
 * configuration before a customer discovers it at the sign-in screen.
 */
export function isEmailConfigured(): boolean {
  return Boolean(
    process.env.EMAIL_USER?.trim() && process.env.EMAIL_PASS?.trim(),
  );
}
