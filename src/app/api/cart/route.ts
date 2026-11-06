import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { addToCart, getCart } from "@/lib/cart/service";
import { addToCartSchema } from "@/lib/validation/commerce";

/**
 * GET /api/cart
 *
 * The signed-in customer's cart, with its ingredient conflicts.
 *
 * The conflicts are computed on every read, because a conflict depends on
 * what is in the cart *now* — and the customer may have added the
 * conflicting product in a different session, or on a different device.
 */

/**
 * POST /api/cart
 *
 * Adds a product to the cart.
 *
 * Body: `{ productId: string, quantity?: number }`
 *
 * ### The conflict check
 *
 * The pure conflict engine runs on every add. If the addition creates a
 * `BLOCK` or `WARN` conflict, the response includes it:
 *
 *   • `conflicts` — every conflict in the cart after the addition.
 *   • `newConflicts` — only the ones involving the product just added.
 *   • `hasBlockingConflict` — true when a `BLOCK` conflict is present.
 *
 * The item is **still added**. Refusing it would hide the information the
 * customer needs to make their own decision. The response carries the
 * title, the explanation, the remedy and the spacing advice so the client
 * can present it clearly, and the customer can remove the item themselves.
 *
 * A `BLOCK` conflict means "do not layer these actives without advice" —
 * not "this purchase is forbidden". The platform's job is to make sure
 * the customer knows, not to make the decision for them.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    const user = await requireCustomer();
    const cart = await getCart(user.id);

    return ok({ cart });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();

    const body = addToCartSchema.parse(await request.json());

    const result = await addToCart(user.id, body.productId, body.quantity);

    return ok(result, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
