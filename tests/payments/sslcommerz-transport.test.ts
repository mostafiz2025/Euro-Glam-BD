import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sslCommerzHttpCall,
  SslCommerzTransportError,
} from "@/lib/sslcommerz-transport";

/**
 * The SSLCOMMERZ transport.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The `sslcommerz-lts` package's own transport does:
 *
 *     const fetch = require("node-fetch");
 *     return fetch(url, {...});
 *
 * Under plain Node that works, because `node-fetch@2` sets
 * `module.exports = fetch`. Under **Turbopack** it does not: the
 * `require` is rewritten into a namespace lookup, so the value is an
 * object whose callable lives on `.default`, and the library calls the
 * object as a function.
 *
 * The result was that every gateway call from the Next.js server died
 * with `TypeError: fetch is not a function` — so the checkout's
 * "Online Payment" path could never open a session. The bug was
 * invisible to `tsx` and to every unit test, because it only exists
 * inside the bundler.
 *
 * These tests pin the replacement transport's contract, so the next
 * person to reach for the package's helper finds a reason not to.
 */

/**
 * The original `fetch`, saved before any test replaces it.
 */
const realFetch = globalThis.fetch;

/**
 * A fetch that answers with a fixed response.
 */
function stubFetch(
  body: string,
  status = 200,
): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => new Response(body, { status }));

  globalThis.fetch = stub as unknown as typeof globalThis.fetch;

  return stub;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("the gateway transport", () => {
  it("sends the fields as a multipart form body", async () => {
    // The gateway's initiation endpoint reads a `multipart/form-data`
    // body. The native `FormData` produces exactly that, and — unlike
    // the `form-data` package's stream — the global `fetch` can send it
    // directly.
    const stub = stubFetch(JSON.stringify({ status: "SUCCESS" }));

    await sslCommerzHttpCall({
      url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
      method: "POST",
      data: { store_id: "shop", total_amount: "100.00" },
    });

    expect(stub).toHaveBeenCalledTimes(1);

    const [url, init] = stub.mock.calls[0] as [string, RequestInit];

    expect(url).toContain("sandbox.sslcommerz.com");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);

    const body = init.body as FormData;

    expect(body.get("store_id")).toBe("shop");
    expect(body.get("total_amount")).toBe("100.00");
  });

  it("does not set Content-Type by hand, so the boundary survives", async () => {
    // A hand-written `Content-Type: multipart/form-data` without a
    // boundary produces a body the gateway cannot parse. The native
    // `FormData` sets the header itself, with its boundary.
    const stub = stubFetch(JSON.stringify({ status: "SUCCESS" }));

    await sslCommerzHttpCall({
      url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
      data: { store_id: "shop" },
    });

    const [, init] = stub.mock.calls[0] as [string, RequestInit];

    const headers = (init.headers ?? {}) as Record<string, string>;

    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("sends a GET with no body", async () => {
    // The validation endpoints take their parameters in the query
    // string. A GET with a `FormData` body would be rejected by the
    // gateway, and some proxies reject it before it gets there.
    const stub = stubFetch(JSON.stringify({ status: "VALID_TRANSACTION" }));

    await sslCommerzHttpCall({
      url: "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?val_id=x",
      method: "GET",
    });

    const [, init] = stub.mock.calls[0] as [string, RequestInit];

    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("parses the gateway's JSON body", async () => {
    stubFetch(
      JSON.stringify({
        status: "SUCCESS",
        GatewayPageURL: "https://sandbox.sslcommerz.com/EasyCheckOut/testcde1",
        sessionkey: "ABC123",
      }),
    );

    const result = await sslCommerzHttpCall({
      url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
      data: { store_id: "shop" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "SUCCESS",
      GatewayPageURL: "https://sandbox.sslcommerz.com/EasyCheckOut/testcde1",
      sessionkey: "ABC123",
    });
  });

  it("reports the HTTP status even when the body says FAILED", async () => {
    // The gateway answers a *declined* session with HTTP 200 and
    // `status: "FAILED"`. A transport that only reported success would
    // hide that, so the body is always passed through for the caller to
    // judge.
    stubFetch(
      JSON.stringify({
        status: "FAILED",
        status_descriptions: { FAILED: "Store credential mismatch" },
      }),
    );

    const result = await sslCommerzHttpCall({
      url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
      data: { store_id: "wrong" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: "FAILED" });
  });

  it("survives an HTML body, because the gateway serves one when confused", async () => {
    // Asked for a `sessionkey`, the `val_id` endpoint answers with its
    // SOAP API documentation — HTML, with HTTP 200. The transport must
    // not throw on it, and must not present it as a validated
    // transaction.
    stubFetch("<html><body>NuSOAP: validationserverAPI</body></html>");

    const result = await sslCommerzHttpCall({
      url: "https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?sessionkey=x",
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).not.toMatchObject({ status: "VALID_TRANSACTION" });
  });

  it("raises a transport error when the gateway cannot be reached", async () => {
    // A network failure is not a declined transaction. It has to be
    // distinguishable from one, or the callback handler would read a
    // dead network as "the gateway says this is fine".
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      sslCommerzHttpCall({
        url: "https://sandbox.sslcommerz.com/gwprocess/v4/api.php",
        data: { store_id: "shop" },
      }),
    ).rejects.toThrowError(SslCommerzTransportError);
  });
});
