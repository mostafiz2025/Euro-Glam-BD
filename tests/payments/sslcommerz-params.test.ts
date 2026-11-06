import { describe, expect, it } from "vitest";

import { readSslCommerzParams } from "@/lib/payments/sslcommerz-params";

/**
 * Reading the SSLCOMMERZ callback's parameters.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The gateway has shipped its callbacks in several shapes: a browser
 * redirect with a query string, a server-to-server `POST` with a
 * form-encoded body, a multipart body, or JSON. The version in use is
 * not something this codebase gets to choose — so every callback route
 * has to read the parameters from wherever the gateway put them.
 *
 * And the parameters decide **which order a callback settles**. A
 * parameter read from the wrong place is an order that is never found,
 * and a payment that is paid but never recorded. A parameter read from
 * the wrong place in the *other* direction is worse — an order settled
 * by a callback that was meant for a different one.
 *
 * So the reading is pinned here, shape by shape.
 */

/**
 * The origin the fake requests are built on.
 */
const ORIGIN = "https://shop.test";

/**
 * A GET with a query string.
 */
function getRequest(query: Record<string, string>): Request {
  const url = new URL(`${ORIGIN}/payment/success`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return new Request(url);
}

/**
 * A POST with a body of the given content type.
 */
function postRequest(
  contentType: string,
  body: string,
  query: Record<string, string> = {},
): Request {
  const url = new URL(`${ORIGIN}/payment/success`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return new Request(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("reading the callback parameters", () => {
  it("reads them from the query string", async () => {
    // The browser redirect. The customer's browser is navigated here.
    const params = await readSslCommerzParams(
      getRequest({
        val_id: "validation-id",
        tran_id: "EGB-20261030-ABC123",
        sessionkey: "SESSION-KEY",
        bank_tran_id: "BANK-123",
        amount: "580.00",
        status: "VALID_TRANSACTION",
        value_a: "order-id-1",
      }),
    );

    expect(params).toEqual({
      val_id: "validation-id",
      tran_id: "EGB-20261030-ABC123",
      orderId: "order-id-1",
      sessionkey: "SESSION-KEY",
      bank_tran_id: "BANK-123",
      amount: "580.00",
      status: "VALID_TRANSACTION",
    });
  });

  it("reads them from a form-encoded body", async () => {
    // The IPN, in the shape the gateway has shipped over its lifetime.
    const params = await readSslCommerzParams(
      postRequest(
        "application/x-www-form-urlencoded",
        new URLSearchParams({
          val_id: "validation-id",
          tran_id: "EGB-20261030-ABC123",
          value_a: "order-id-1",
          status: "VALID_TRANSACTION",
        }).toString(),
      ),
    );

    expect(params.val_id).toBe("validation-id");
    expect(params.tran_id).toBe("EGB-20261030-ABC123");
    expect(params.orderId).toBe("order-id-1");
    expect(params.status).toBe("VALID_TRANSACTION");
  });

  it("reads them from a multipart body", async () => {
    // The task the gateway posts to the success URL in some merchant
    // configurations. The boundary is what makes it multipart, and the
    // parser has to find it.
    const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";

    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="val_id"',
      "",
      "validation-id",
      `--${boundary}`,
      'Content-Disposition: form-data; name="tran_id"',
      "",
      "EGB-20261030-ABC123",
      `--${boundary}`,
      'Content-Disposition: form-data; name="value_a"',
      "",
      "order-id-1",
      `--${boundary}`,
      'Content-Disposition: form-data; name="status"',
      "",
      "VALID_TRANSACTION",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const params = await readSslCommerzParams(
      postRequest(`multipart/form-data; boundary=${boundary}`, body),
    );

    expect(params.val_id).toBe("validation-id");
    expect(params.tran_id).toBe("EGB-20261030-ABC123");
    expect(params.orderId).toBe("order-id-1");
    expect(params.status).toBe("VALID_TRANSACTION");
  });

  it("reads them from a JSON body", async () => {
    const params = await readSslCommerzParams(
      postRequest(
        "application/json",
        JSON.stringify({
          val_id: "validation-id",
          tran_id: "EGB-20261030-ABC123",
          value_a: "order-id-1",
          status: "VALID_TRANSACTION",
        }),
      ),
    );

    expect(params.val_id).toBe("validation-id");
    expect(params.tran_id).toBe("EGB-20261030-ABC123");
    expect(params.orderId).toBe("order-id-1");
    expect(params.status).toBe("VALID_TRANSACTION");
  });

  it("takes the body over the query string when both carry a parameter", async () => {
    // The body is what the gateway's **server** sent. The query string
    // on a `POST` is whatever the request URL happened to carry. So the
    // body wins.
    //
    // This matters: if the query string won, a customer could append
    // `?value_a=<their own order>` to a callback the gateway posted for
    // somebody else's order, and the shop would settle the wrong order.
    // The gateway's server-to-server verification would then check the
    // amount against the wrong order's total — and the amount check
    // would reject it. But the order to *look at* should still be the
    // one the gateway named.
    const params = await readSslCommerzParams(
      postRequest(
        "application/x-www-form-urlencoded",
        new URLSearchParams({ value_a: "the-real-order" }).toString(),
        { value_a: "a-substituted-order" },
      ),
    );

    expect(params.orderId).toBe("the-real-order");
  });

  it("still finds a parameter that only the query string carries", async () => {
    // A parameter present in one place is found either way — the two
    // are merged, not switched between.
    const params = await readSslCommerzParams(
      postRequest(
        "application/x-www-form-urlencoded",
        new URLSearchParams({ val_id: "from-body" }).toString(),
        { sessionkey: "from-query" },
      ),
    );

    expect(params.val_id).toBe("from-body");
    expect(params.sessionkey).toBe("from-query");
  });

  it("accepts `orderId` as an alias for `value_a`", async () => {
    // A merchant configuration can be set to send the order id under
    // its own name. `value_a` is the shop's own round-trip, so it wins
    // when both are present.
    const params = await readSslCommerzParams(
      getRequest({ orderId: "order-id-1" }),
    );

    expect(params.orderId).toBe("order-id-1");

    const both = await readSslCommerzParams(
      getRequest({ orderId: "aliased", value_a: "round-tripped" }),
    );

    expect(both.orderId).toBe("round-tripped");
  });

  it("treats a blank value as absent", async () => {
    // The gateway sometimes sends `value_c=` with nothing after the `=`.
    // An empty string that reached a `where` clause would match nothing,
    // with a much more confusing error message.
    const params = await readSslCommerzParams(
      getRequest({ val_id: "", sessionkey: "   ", amount: "580.00" }),
    );

    expect(params.val_id).toBeUndefined();
    expect(params.sessionkey).toBeUndefined();
    expect(params.amount).toBe("580.00");
  });

  it("survives a body it cannot parse", async () => {
    // A malformed body is not fatal. The query-string parameters are
    // already collected, and the verification still goes to the gateway
    // — so this degrades to "we have less information", not "we have no
    // information" and a crash.
    const params = await readSslCommerzParams(
      postRequest("application/json", "{not json at all", {
        val_id: "from-query",
      }),
    );

    expect(params.val_id).toBe("from-query");
  });

  it("ignores a JSON body whose values are not strings", async () => {
    // The gateway sends no files and no nested objects. A value that is
    // not a string cannot be a callback parameter, and reading it as one
    // would put `"[object Object]"` into a database query.
    const params = await readSslCommerzParams(
      postRequest(
        "application/json",
        JSON.stringify({ val_id: "kept", nested: { a: 1 }, number: 42 }),
      ),
    );

    expect(params.val_id).toBe("kept");
  });
});
