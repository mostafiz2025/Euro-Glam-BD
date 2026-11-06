import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import { clearCart } from "@/lib/cart/service";

/**
 * DELETE /api/cart/clear
 *
 * Empties the cart.
 *
 * Separate from `DELETE /api/cart/items/[itemId]` because "remove one
 * line" and "remove everything" are different intents, and a client
 * should not have to enumerate line ids to empty a cart.
 */
export async function DELETE(): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();
    const cart = await clearCart(user.id);

    return ok({ cart });
  } catch (error) {
    return handleApiError(error);
  }
}
