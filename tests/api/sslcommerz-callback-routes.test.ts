import { describe, expect, it, vi } from "vitest";

import {
  GET as successGet,
  POST as successPost,
} from "@/app/payment/success/route";
import {
  GET as failGet,
  POST as failPost,
} from "@/app/payment/fail/route";
import {
  GET as cancelGet,
  POST as cancelPost,
} from "@/app/payment/cancel/route";

/**
 * The SSLCOMMERZ browser-callback routes.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The routes now answer **both** `GET` and `POST`, because the gateway
 * has shipped its redirect in both shapes and the version in use is not
 * something this codebase gets to choose.
 *
 * The three properties worth pinning:
 *
 *   1. **Both methods reach the handler**, and the parameters are read
 *      from the body on a `POST` — so a callback that arrives as a form
 *      body finds the same order a query-string callback would.
 *
 *   2. **The redirect goes to the order page**, with the outcome in the
 *      query string.
 *
 *   3. **The three routes differ only in the outcome word** — `confirmed`,
 *      `failed`, `cancelled` — and nothing else. A cancellation and a
 *      decline are the same fact: the money did not move.
 *
 * The gateway is **mocked**. These tests are about the routes' wiring —
 * the reading, the dispatch, the redirect — and not about the gateway's
 * own behaviour, which the integration suite covers separately.
 */

/**
 * The result the mocked callback handler returns.
 *
 * A **fixed** order id, so the redirect destination is predictable, and
 * a `verified` flag that the tests can flip.
 */
const handlerResult = {
  verified: true,
  settled: true,
  orderId: "order-id-1",
  orderNumber: "EGB-20261030-ABC123",
  paymentStatus: "PAID",
  gatewayStatus: "VALID_TRANSACTION",
  message: null,
} as unknown as Awaited<
  ReturnType<
    typeof import("@/lib/payments/sslcommerz-callback").handleSslCommerzSuccess
  >
>;

/**
 * The parameters the mocked handler was last called with.
 */
let lastParams: Record<string, string | undefined> = {};

/**
 * `connection()` is a Next.js dynamic API that only works inside a
 * request scope. These tests call the route handlers directly, so it is
 * stubbed out — it does nothing but opt the route out of prerendering,
 * and there is no prerendering happening here.
 */
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();

  return {
    ...actual,
    connection: async () => undefined,
  };
});

vi.mock("@/lib/payments/sslcommerz-callback", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/payments/sslcommerz-callback")
    >();

  return {
    ...actual,
    handleSslCommerzSuccess: vi.fn(async (params: unknown) => {
      lastParams = params as Record<string, string | undefined>;
      return handlerResult;
    }),
    handleSslCommerzFailure: vi.fn(async (params: unknown) => {
      lastParams = params as Record<string, string | undefined>;
      return handlerResult;
    }),
  };
});

/**
 * A `GET` request with a query string.
 */
function getRequest(query: Record<string, string> = {}): Request {
  const url = new URL("https://shop.test/payment/success");

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return new Request(url);
}

/**
 * A `POST` request with a form-encoded body.
 */
function postRequest(body: Record<string, string>): Request {
  return new Request("https://shop.test/payment/success", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

/**
 * The redirect target of a response.
 */
function redirectTo(response: Response): URL {
  const location = response.headers.get("location");

  expect(location).toBeTruthy();

  return new URL(location as string);
}

describe("the success route", () => {
  it("answers a GET and redirects to the order page", async () => {
    const response = await successGet(getRequest({ val_id: "v-1" }));

    expect(response.status).toBe(303);

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/orders/order-id-1");
  });

  it("answers a POST and redirects to the order page", async () => {
    const response = await successPost(
      postRequest({ val_id: "v-1", value_a: "order-id-1" }),
    );

    expect(response.status).toBe(303);

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/orders/order-id-1");
  });

  it("redirects a confirmed payment cleanly, with no outcome word", async () => {
    // The order row now says `PAID`, so the order page renders the
    // success state from the database alone. A query string saying the
    // same thing would be a **second** source of truth — and one that a
    // customer can edit.
    //
    // So a confirmed payment redirects to a clean URL. The page reads
    // the row, not the URL.
    const response = await successGet(getRequest({ val_id: "v-1" }));

    const destination = redirectTo(response);

    expect(destination.searchParams.get("payment")).toBeNull();
    expect(destination.searchParams.get("note")).toBeNull();
  });

  it("never redirects a confirmed payment with 'unconfirmed'", async () => {
    // The specific failure the fix is about: a payment the gateway
    // confirmed must not come back as an unconfirmed one.
    const response = await successGet(getRequest({ val_id: "v-1" }));

    const destination = redirectTo(response);

    expect(destination.searchParams.get("payment")).not.toBe("unconfirmed");
  });

  it("redirects a payment the gateway confirmed to a bare order URL", async () => {
    // The exact URL the customer lands on. A query string on it is a
    // second source of truth that can disagree with the row — and the
    // order page's banner and "Pay now" button both read the row.
    const response = await successGet(getRequest({ val_id: "v-1" }));

    const destination = redirectTo(response);

    expect(destination.toString()).toBe(
      "https://shop.test/orders/order-id-1",
    );
  });

  it("reads the parameters from the POST body", async () => {
    // The body is where a `POST` callback carries them. If the route
    // only read the query string, a form-encoded callback would arrive
    // with no parameters at all — and no order would be found.
    await successPost(
      postRequest({
        val_id: "from-the-body",
        tran_id: "EGB-20261030-ABC123",
        value_a: "order-id-1",
      }),
    );

    expect(lastParams.val_id).toBe("from-the-body");
    expect(lastParams.tran_id).toBe("EGB-20261030-ABC123");
    expect(lastParams.orderId).toBe("order-id-1");
  });

  it("carries the handler's message to the order page", async () => {
    // The message is for the page to render. It is never a record — the
    // order row is the record.
    const { handleSslCommerzSuccess } = await import(
      "@/lib/payments/sslcommerz-callback"
    );

    vi.mocked(handleSslCommerzSuccess).mockResolvedValueOnce({
      ...handlerResult,
      verified: false,
      settled: false,
      message: "We could not confirm this payment with the gateway yet.",
    });

    const response = await successGet(getRequest());

    const destination = redirectTo(response);

    expect(destination.searchParams.get("payment")).toBe("unconfirmed");
    expect(destination.searchParams.get("note")).toContain(
      "could not confirm",
    );
  });

  it("sends the customer to their account page when no order was found", async () => {
    // There is no order page to send them to.
    const { handleSslCommerzSuccess } = await import(
      "@/lib/payments/sslcommerz-callback"
    );

    vi.mocked(handleSslCommerzSuccess).mockResolvedValueOnce({
      ...handlerResult,
      verified: false,
      settled: false,
      orderId: null,
      orderNumber: null,
      paymentStatus: null,
      message: "We could not find the order this payment belongs to.",
    });

    const response = await successGet(getRequest());

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/account");
  });

  it("redirects cleanly for a payment the sandbox fallback settled", async () => {
    // ── The case the `settled` flag exists for ──────────────────────────
    //
    // The gateway never vouched for this payment — the shop's own
    // sandbox fallback settled it — but the order **is** paid. The row
    // says `PAID`.
    //
    // So the redirect must be clean. If it carried
    // `payment=unconfirmed`, the customer would land on an order the
    // shop has been paid for and be told their money is in doubt, and
    // be invited to pay a second time.
    const { handleSslCommerzSuccess } = await import(
      "@/lib/payments/sslcommerz-callback"
    );

    vi.mocked(handleSslCommerzSuccess).mockResolvedValueOnce({
      ...handlerResult,
      verified: false,
      settled: true,
      message: null,
    });

    const response = await successGet(getRequest());

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/orders/order-id-1");
    expect(destination.searchParams.get("payment")).toBeNull();
    expect(destination.searchParams.get("note")).toBeNull();
  });

  it("still says 'unconfirmed' for a payment that did NOT settle", async () => {
    // The other half: unverified **and** unsettled is the case the
    // warning is for.
    const { handleSslCommerzSuccess } = await import(
      "@/lib/payments/sslcommerz-callback"
    );

    vi.mocked(handleSslCommerzSuccess).mockResolvedValueOnce({
      ...handlerResult,
      verified: false,
      settled: false,
      message: "We could not confirm this payment with the gateway yet.",
    });

    const response = await successGet(getRequest());

    const destination = redirectTo(response);

    expect(destination.searchParams.get("payment")).toBe("unconfirmed");
  });
});

describe("the failure route", () => {
  it("answers a GET and redirects with 'failed'", async () => {
    const response = await failGet(getRequest({ status: "FAILED" }));

    expect(response.status).toBe(303);

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/orders/order-id-1");
    expect(destination.searchParams.get("payment")).toBe("failed");
  });

  it("answers a POST and redirects with 'failed'", async () => {
    const response = await failPost(postRequest({ status: "FAILED" }));

    expect(response.status).toBe(303);

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/orders/order-id-1");
    expect(destination.searchParams.get("payment")).toBe("failed");
  });

  it("reads the parameters from the POST body", async () => {
    await failPost(postRequest({ tran_id: "EGB-20261030-ABC123" }));

    expect(lastParams.tran_id).toBe("EGB-20261030-ABC123");
  });
});

describe("the cancellation route", () => {
  it("answers a GET and redirects with 'cancelled'", async () => {
    const response = await cancelGet(getRequest({ status: "CANCELLED" }));

    expect(response.status).toBe(303);

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/orders/order-id-1");
    expect(destination.searchParams.get("payment")).toBe("cancelled");
  });

  it("answers a POST and redirects with 'cancelled'", async () => {
    const response = await cancelPost(postRequest({ status: "CANCELLED" }));

    expect(response.status).toBe(303);

    const destination = redirectTo(response);

    expect(destination.pathname).toBe("/orders/order-id-1");
    expect(destination.searchParams.get("payment")).toBe("cancelled");
  });
});

describe("the three routes together", () => {
  it("all redirect with 303, never 302", async () => {
    // The callback is a **write** — it settles a payment. A `303 See
    // Other` says "go and `GET` that address", so the redirect cannot
    // be replayed by re-visiting the callback URL.
    for (const handler of [successGet, failGet, cancelGet]) {
      const response = await handler(getRequest());

      expect(response.status).toBe(303);
    }
  });

  it("all read the same parameters from the same shapes", async () => {
    // The routes differ in the outcome word and nothing else. If one of
    // them read the parameters differently, a callback that works for
    // one would silently fail for another.
    const body = {
      val_id: "v-1",
      tran_id: "EGB-20261030-ABC123",
      value_a: "order-id-1",
      sessionkey: "SESSION-KEY",
      amount: "580.00",
      status: "VALID_TRANSACTION",
    };

    await successPost(postRequest(body));
    const successParams = { ...lastParams };

    await failPost(postRequest(body));
    const failParams = { ...lastParams };

    await cancelPost(postRequest(body));
    const cancelParams = { ...lastParams };

    expect(successParams).toEqual(failParams);
    expect(successParams).toEqual(cancelParams);
  });
});
