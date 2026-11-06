import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import {
  applyCouponToCart,
  removeCouponFromCart,
} from "@/lib/coupons/service";
import { couponCodeSchema } from "@/lib/validation/commerce";

/**
 * POST /api/cart/coupon
 *
 * Applies a discount code to the customer's cart.
 *
 * Body: `{ code: string }`
 *
 * ── The customer never states what the code is worth ──────────────────────
 *
 * The body carries a **code** and nothing else — no discount, no
 * percentage, no total. The server reads the coupon's terms from the
 * database and computes what it is worth against the cart as it stands.
 * That is the same rule the checkout follows for prices, and the same
 * reason: a client-supplied amount is a number the client made up.
 *
 * ── What comes back ──────────────────────────────────────────────────────
 *
 * The response carries the whole cart, with the coupon's discount already
 * applied to its totals, plus the coupon itself — its code, its label and
 * what it is worth. The client never has to compute the discount; it
 * displays what the server said.
 *
 * ### The three answers
 *
 *   • **200** — the code is good and applied.
 *   • **404** — no coupon has that code at all.
 *   • **409** — the code exists but cannot be used: it has expired, it was
 *     switched off, or it has been used up.
 *
 * The 404 and the 409 are deliberately different. "EID2026" that does not
 * exist and "EID2026" that expired are different facts, and the customer
 * deserves to be told which one happened. A single "invalid code" for
 * both would leave a shopper staring at a banner that advertises a code
 * the checkout refuses.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();

    const body = couponCodeSchema.parse(await request.json());

    const result = await applyCouponToCart(user.id, body.code);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/cart/coupon
 *
 * Removes the discount code from the customer's cart.
 *
 * Removing a code is **always** allowed. A customer who applied a code by
 * mistake must be able to take it off without asking a shop assistant.
 */
export async function DELETE(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();

    const cart = await removeCouponFromCart(user.id);

    return ok({ cart });
  } catch (error) {
    return handleApiError(error);
  }
}
