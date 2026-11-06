import type { SslCommerzCallbackParams } from "@/lib/payments/sslcommerz-callback";

/**
 * Reading the SSLCOMMERZ callback's parameters.
 *
 * ── Why this is a shared module ───────────────────────────────────────────
 *
 * The gateway has shipped its callbacks in several shapes over its
 * lifetime, and the version in use is not something this codebase gets
 * to choose:
 *
 *   • The **browser redirect** (`/payment/success`) is a `GET` with a
 *     query string — the customer's browser is navigated there.
 *
 *   • The **IPN** (`/payment/ipn`) is a server-to-server `POST`. Depending
 *     on the gateway version it is form-encoded, multipart, or JSON.
 *
 *   • Some merchant configurations have the gateway **POST** the
 *     redirect instead of navigating to it, which is why the success and
 *     failure routes accept `POST` as well as `GET`.
 *
 * So the parameters have to be read from wherever the gateway put them.
 * Doing that once — here — means the four callback routes cannot drift
 * apart, and a shape that one of them understands is understood by all
 * of them.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * **The body wins over the query string.**
 *
 * A parameter present in both is taken from the body. That is not
 * arbitrary: the body is what the gateway's *server* sent, and the
 * query string on a `POST` is whatever the request URL happened to
 * carry. A parameter present in only one place is found either way.
 */

/**
 * The content types the gateway has been observed to send.
 */
const FORM_URLENCODED = "application/x-www-form-urlencoded";
const MULTIPART = "multipart/form-data";
const JSON = "application/json";

/**
 * Reads the callback parameters from a request.
 *
 * Everything is read defensively: a body that cannot be parsed, or a
 * body whose values are not strings, degrades to "we have less
 * information" rather than to "we have no information" and a crash.
 *
 * @param request - The incoming request.
 */
export async function readSslCommerzParams(
  request: Request,
): Promise<SslCommerzCallbackParams> {
  const url = new URL(request.url);

  const collected = new Map<string, string>();

  for (const [key, value] of url.searchParams) {
    collected.set(key, value);
  }

  if (request.method === "POST") {
    try {
      const contentType = request.headers.get("content-type") ?? "";

      if (contentType.includes(MULTIPART)) {
        /**
         * A multipart body.
         *
         * `Request.formData()` handles the boundary parsing. Only
         * string values are collected — a file part would be a `Blob`,
         * and the gateway sends no files.
         */
        const form = await request.formData();

        for (const [key, value] of form.entries()) {
          if (typeof value === "string") {
            collected.set(key, value);
          }
        }
      } else if (contentType.includes(FORM_URLENCODED)) {
        const body = await request.text();

        for (const [key, value] of new URLSearchParams(body)) {
          collected.set(key, value);
        }
      } else if (contentType.includes(JSON)) {
        const body = (await request.json()) as unknown;

        if (typeof body === "object" && body !== null) {
          for (const [key, value] of Object.entries(
            body as Record<string, unknown>,
          )) {
            if (typeof value === "string") {
              collected.set(key, value);
            }
          }
        }
      }
    } catch (error) {
      /**
       * A body that cannot be parsed is not fatal.
       *
       * The query-string parameters are already collected, and the
       * verification still goes to the gateway — so a malformed body
       * degrades to "we have less information", not "we have no
       * information".
       */
      console.error("[sslcommerz] Could not parse the callback body:", error);
    }
  }

  const get = (key: string): string | undefined => {
    const value = collected.get(key)?.trim();
    return value && value.length > 0 ? value : undefined;
  };

  return {
    val_id: get("val_id"),
    tran_id: get("tran_id"),
    /**
     * The order id.
     *
     * `value_a` is where the shop put it when the session was opened —
     * the gateway round-trips it verbatim. `orderId` is accepted as an
     * alias because a merchant configuration can be set to send it
     * under that name.
     */
    orderId: get("value_a") ?? get("orderId"),
    sessionkey: get("sessionkey"),
    bank_tran_id: get("bank_tran_id"),
    amount: get("amount"),
    status: get("status"),
  };
}
