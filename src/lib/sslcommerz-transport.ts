/**
 * The SSLCOMMERZ HTTP transport.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The `sslcommerz-lts` package is untyped CommonJS, and its transport
 * helper (`api/fetch.js`) does this:
 *
 *     const fetch = require("node-fetch");
 *     return fetch(url, {...}).then(r => r.json()).catch(err => err);
 *
 * That works under plain Node, because `node-fetch@2` sets
 * `module.exports = fetch` — so `require("node-fetch")` hands back the
 * **function** itself.
 *
 * It does **not** work under Turbopack. Turbopack rewrites a `require`
 * inside a bundled dependency into a namespace lookup, so the value the
 * library receives is a **namespace object** whose callable lives on
 * `.default`. The library then calls that object directly:
 *
 *     namespace(url, {...})   // TypeError: namespace is not a function
 *
 * So every gateway call from the Next.js server died with
 * `TypeError: fetch is not a function` — the checkout's "Online
 * Payment" path could never open a session.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 *
 * The package's genuinely valuable part is its **knowledge of the
 * gateway's HTTP contract**: the endpoint URLs, the credential query
 * parameters, and the long list of form fields an initiation carries.
 * That knowledge is kept.
 *
 * The transport is replaced with one that works everywhere: the
 * **global `fetch`** (present in the Next.js Node runtime) and the
 * **native `FormData`** (which produces the same `multipart/form-data`
 * body the gateway expects, without pulling in the `form-data` stream
 * package whose streams the global `fetch` cannot consume).
 *
 * ── The contract that is preserved ─────────────────────────────────────────
 *
 * The package's helper **returns** a caught error rather than throwing
 * it. That is not an accident, and it is depended upon: the callback
 * handler (`src/lib/payments/sslcommerz-callback.ts`) treats a response
 * that is not an object as "not verified", and a thrown error would
 * escape that check. So this transport returns errors as values too.
 */

/**
 * The shape of a gateway HTTP call.
 */
export type SslCommerzHttpCall = {
  /** The absolute URL to call. */
  readonly url: string;
  /** The HTTP method. Defaults to `POST`. */
  readonly method?: string;
  /**
   * The form fields to send.
   *
   * Sent as `multipart/form-data`, which is what the gateway's
   * initiation endpoint expects.
   */
  readonly data?: Record<string, string>;
};

/**
 * The gateway's own error shape.
 *
 * The gateway answers a *rejected* request with HTTP 200 and a body
 * carrying `status: "FAILED"`. A transport that only checked the HTTP
 * status would treat that as a success. So the parsed body is always
 * returned to the caller, whatever the status code was.
 */
export type SslCommerzHttpResult = {
  /** The parsed response body, when the gateway sent JSON. */
  readonly body: unknown;
  /** The HTTP status code. */
  readonly status: number;
};

/**
 * The transport's own failure.
 *
 * Thrown only for failures that make a *call* impossible — no network,
 * a non-JSON body. The caller decides what those mean.
 */
export class SslCommerzTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SslCommerzTransportError";
  }
}

/**
 * Calls the gateway.
 *
 * ── Why `POST` with a native `FormData` ───────────────────────────────────
 *
 * The gateway's initiation endpoint reads a `multipart/form-data` body.
 * The `form-data` package produces that too, but it produces a **Node
 * stream**, which the global `fetch` cannot use as a request body — it
 * would throw `TypeError: fetch failed` at the first attempt. The
 * native `FormData` is the same wire format and is accepted directly.
 *
 * The `Content-Type` header is deliberately **not** set: the native
 * `FormData` carries its own boundary, and setting the header by hand
 * without that boundary produces a body the gateway cannot parse.
 *
 * @param call - The call to make.
 *
 * @throws SslCommerzTransportError when the request cannot be completed
 *         or the gateway does not answer with JSON.
 */
export async function sslCommerzHttpCall(
  call: SslCommerzHttpCall,
): Promise<SslCommerzHttpResult> {
  const method = (call.method ?? "POST").toUpperCase();
  const isPost = method === "POST";

  const body = new FormData();

  for (const [key, value] of Object.entries(call.data ?? {})) {
    body.append(key, value);
  }

  let response: Response;

  try {
    response = await fetch(call.url, {
      method,
      headers: isPost
        ? undefined
        : { Accept: "application/json" },
      body: isPost ? body : undefined,
      cache: "no-store",
    });
  } catch (error) {
    throw new SslCommerzTransportError(
      "Could not reach the SSLCOMMERZ gateway.",
      { cause: error },
    );
  }

  const text = await response.text();

  let parsed: unknown = null;

  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /**
       * A non-JSON body.
       *
       * The gateway sometimes answers with an HTML error page rather
       * than JSON — an upstream proxy's 502, for instance. The status
       * code is still meaningful, so the raw text is carried and the
       * caller raises on the status rather than on the parse.
       */
      parsed = { message: text.slice(0, 500) };
    }
  }

  return { body: parsed, status: response.status };
}
