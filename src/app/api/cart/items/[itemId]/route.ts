import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireCustomer } from "@/lib/auth/guards";
import {
  removeCartItem,
  updateCartItemQuantity,
} from "@/lib/cart/service";
import {
  entityIdSchema,
  updateCartItemSchema,
} from "@/lib/validation/commerce";

/**
 * PATCH /api/cart/items/[itemId]
 *
 * Updates the quantity of a cart line.
 *
 * Body: `{ quantity: number }`
 *
 * The line is scoped by the owning cart, so a customer cannot modify a
 * line in another user's cart even if they guess the line id. A line that
 * is not in the caller's cart returns 404 — the same response as a line
 * belonging to someone else, so the endpoint leaks nothing about other
 * customers' carts.
 *
 * The cart's conflicts are recomputed and returned, because changing a
 * quantity can resolve a conflict (removing the second vitamin-C product
 * clears the warning).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();

    const { itemId } = await context.params;

    const parsedItemId = entityIdSchema.parse(itemId);

    const body = updateCartItemSchema.parse(await request.json());

    const cart = await updateCartItemQuantity(
      user.id,
      parsedItemId,
      body.quantity,
    );

    return ok({ cart });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/cart/items/[itemId]
 *
 * Removes a line from the cart.
 *
 * Scoped by the owning cart, for the same reason as the PATCH handler.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireCustomer();

    const { itemId } = await context.params;

    const parsedItemId = entityIdSchema.parse(itemId);

    const cart = await removeCartItem(user.id, parsedItemId);

    return ok({ cart });
  } catch (error) {
    return handleApiError(error);
  }
}
