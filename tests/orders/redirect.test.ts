/**
 * The checkout redirect.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 *
 * The checkout form read `order.id` from the checkout endpoint's
 * response, but `placeOrder` returns **`orderId`**. There is no `id` on
 * the response, so the field was always `undefined`, the redirect fell
 * through to `/account`, and every customer who placed an order landed on
 * their order *list* instead of their order *page*.
 *
 * The order was placed correctly — only the redirect was wrong — which is
 * why no existing test caught it. The API's tests assert the
 * **database**; the redirect is a client concern, and the response was
 * typed with an `as` cast, so TypeScript could not catch it either.
 *
 * So the redirect is computed in one place — `orderConfirmationPath` —
 * and these tests pin the field name it depends on.
 */

import { describe, expect, it } from "vitest";

import { orderConfirmationPath } from "@/lib/orders/redirect";
import type { PlaceOrderResult } from "@/lib/orders/service";

describe("orderConfirmationPath", () => {
  it("sends the customer to the order page", () => {
    // The field is `orderId` — the same name `placeOrder` returns.
    // Spelling it `id` here would silently break the redirect again.
    expect(
      orderConfirmationPath({
        orderId: "cm1234567890",
        orderNumber: "EGB-20261029-A1B2C3",
      }),
    ).toBe("/orders/cm1234567890?ref=EGB-20261029-A1B2C3");
  });

  it("omits the reference when there is no order number", () => {
    expect(orderConfirmationPath({ orderId: "cm1234567890" })).toBe(
      "/orders/cm1234567890",
    );
  });

  it("encodes an order number that needs it", () => {
    expect(
      orderConfirmationPath({
        orderId: "cm1234567890",
        orderNumber: "EGB 2026/10/29 A1",
      }),
    ).toBe("/orders/cm1234567890?ref=EGB%202026%2F10%2F29%20A1");
  });

  it("falls back to the account page when there is no order", () => {
    // The order was placed — the customer must not be told it failed.
    // The account page lists their orders, so it is the safe landing.
    expect(orderConfirmationPath(undefined)).toBe("/account");
    expect(orderConfirmationPath({})).toBe("/account");
    expect(orderConfirmationPath({ orderId: "" })).toBe("/account");
  });

  /**
   * ── The contract that caused the bug ─────────────────────────────────
   *
   * The three order shapes in this codebase do **not** agree on the id's
   * name:
   *
   *   • `placeOrder` returns **`orderId`** — it is the *result* of a
   *     mutation, and it names the thing it just created.
   *   • `listOrders` and `getOrderById` return **`id`** — they are
   *     *reads* of a row.
   *
   * The checkout form had picked `id`, so the redirect silently fell
   * through. This test pins the checkout response to the **mutation**
   * shape, which is the one the redirect reads.
   */
  it("reads the id under the name the checkout endpoint actually returns", () => {
    // A `PlaceOrderResult` must be usable as a `CheckoutOrderResponse`
    // without a cast — that is the whole point of the shared shape.
    const placed: PlaceOrderResult["orderId"] = "cm1234567890";

    expect(orderConfirmationPath({ orderId: placed })).toBe(
      "/orders/cm1234567890",
    );

    // The mutation result calls it `orderId`, and has **no** `id`. This
    // is asserted at the **type** level, because the bug was a type-level
    // disagreement that a value-level check cannot see: the old form read
    // `order.id`, which type-checks fine against a cast response and is
    // `undefined` at runtime.
    type HasId = "id" extends keyof PlaceOrderResult ? true : false;
    type HasOrderId = "orderId" extends keyof PlaceOrderResult ? true : false;

    const hasId: HasId = false;
    const hasOrderId: HasOrderId = true;

    expect(hasId).toBe(false);
    expect(hasOrderId).toBe(true);
  });
});
