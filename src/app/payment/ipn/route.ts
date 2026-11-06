import { connection } from "next/server";

import {
  handleSslCommerzFailure,
  handleSslCommerzSuccess,
} from "@/lib/payments/sslcommerz-callback";
import { readSslCommerzParams } from "@/lib/payments/sslcommerz-params";

/**
 * POST /payment/ipn
 *
 * The SSLCOMMERZ gateway's own server-to-server notification.
 *
 * ── Why this endpoint exists, and why it is the important one ─────────────
 *
 * The browser redirect (`/payment/success`) is *convenient*: the
 * customer sees their order immediately. But it is a **browser
 * navigation**, and the customer might close the tab, lose their
 * connection, or never come back at all. The shop would then have an
 * order that was paid and recorded as unpaid.
 *
 * The IPN is the gateway's **own** notification. It is a server-to-server
 * `POST`, made by SSLCOMMERZ regardless of what the customer does. So
 * the IPN is the path that guarantees the shop hears about the payment,
 * and the browser redirect is the path that tells the customer
 * promptly.
 *
 * They both funnel into the same service, so both take the same
 * precautions.
 *
 * ── Both `GET` and `POST` are accepted ───────────────────────────────────
 *
 * The gateway has shipped the IPN as both over its lifetime, and the
 * version in use is not something this codebase gets to choose. Rather
 * than guess, the route accepts both and reads the parameters from
 * wherever they are.
 *
 * ── The response ──────────────────────────────────────────────────────────
 *
 * The gateway retries an IPN it considers unacknowledged, so the
 * response matters: it must be a clean 200 for a notification this
 * shop has **handled**, and for one it has deliberately **refused**.
 *
 * A failed payment is a handled notification — the shop has recorded
 * the attempt and told the admin. So it answers 200.
 *
 * A gateway error — the shop could not reach SSLCOMMERZ to verify — is
 * a *retryable* failure, so it answers 500 and lets the gateway come
 * back. That is the difference between the two: the first is a settled
 * fact, the second is a question the shop has not answered yet.
 */
async function handleIpn(request: Request): Promise<Response> {
  const params = await readSslCommerzParams(request);

  const status = params.status?.toUpperCase();

  /**
   * The gateway's own verdict.
   *
   * `VALID_TRANSACTION` and `VALID` are the two spellings SSLCOMMERZ
   * uses for a completed payment; `FAILED`, `CANCELLED` and
   * `UNCANCELLED` are the unsuccessful ones. Anything else is treated
   * as unsuccessful, because the safe reading of an unknown status is
   * "the money did not move".
   */
  const succeeded =
    status === "VALID_TRANSACTION" ||
    status === "VALID" ||
    status === "SUCCESS" ||
    status === "PAID";

  const result = succeeded
    ? await handleSslCommerzSuccess(params)
    : await handleSslCommerzFailure(params);

  /**
   * The success path could not verify.
   *
   * That is **not** a handled notification — the shop genuinely does not
   * know yet whether the money moved. The gateway's own validation
   * endpoint was unreachable or answered something unusable, so the
   * answer is 500 and the gateway retries.
   */
  if (succeeded && !result.verified) {
    console.error(
      `[sslcommerz] IPN for order ${result.orderNumber ?? "unknown"} could not be verified. ` +
        `Gateway status: ${result.gatewayStatus ?? "none"}.`,
    );

    return Response.json(
      {
        ok: false,
        error: {
          code: "BAD_GATEWAY",
          message: "The payment could not be verified with the gateway yet.",
        },
      },
      { status: 502 },
    );
  }

  return Response.json({
    ok: true,
    data: {
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      paymentStatus: result.paymentStatus,
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  await connection();

  return handleIpn(request);
}

export async function GET(request: Request): Promise<Response> {
  await connection();

  return handleIpn(request);
}
