import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { ACTIVE_PRODUCT_WHERE } from "@/lib/catalog/product-visibility";
import { evaluateConflicts } from "@/lib/conflict-engine";
import type { AppliedCoupon } from "@/lib/coupons/rules";
import { db } from "@/lib/db";

/**
 * The cart service.
 *
 * ── Design notes ─────────────────────────────────────────────────────────
 *
 * • **One cart per user.** `Cart.userId` is `@unique`, so the cart is
 *   found by user, never by a client-supplied cart id. A client cannot
 *   address someone else's cart because it never supplies an id at all.
 *
 * • **The cart is created lazily.** A user who has never added anything
 *   has no cart row, and that is not an error — `GET /api/cart` returns an
 *   empty cart.
 *
 * • **Conflict checking happens on every mutation.** Adding a retinol
 *   next to an AHA in the cart is a safety issue, so the check runs on the
 *   write path, not only at checkout. The engine itself is pure (see
 *   `src/lib/conflicts/engine.ts`); this module is the part that talks to
 *   the database and feeds it.
 *
 * • **A `BLOCK` conflict does not silently reject the request.** It is
 *   returned to the caller with a clear explanation, and the caller
 *   decides. The cart API reports the conflict and *still* records the
 *   item, because refusing to add a product is a decision the customer
 *   should make — the platform's job is to make sure they know. A
 *   `force` flag lets an explicit confirmation override the warning.
 */

/**
 * The product fields the cart needs.
 *
 * ── Why `archivedAt` is a **selected field** and not a filter ───────────
 *
 * The obvious way to hide an archived product from a cart is to add
 * `where: { archivedAt: null }` to the nested `product` relation. That
 * would be wrong, and the failure mode is nasty.
 *
 * A nested `where` on a **to-one** relation compiles to an **inner
 * join**. An archived product would not be "hidden" — it would not be
 * *returned*, and Prisma would omit the entire cart item along with it.
 *
 * The customer's cart would silently lose the line. The subtotal would
 * drop without the line being visibly removed, the customer would agree
 * to a total they never saw, and the removal would happen with no
 * explanation at all.
 *
 * So the archive flag is **read** and the decision is made in application
 * code: the line is kept, it is marked unavailable, and checkout is
 * blocked with a clear message. The line stays visible because a silently
 * disappearing line changes the total the customer agreed to.
 */
const CART_PRODUCT_SELECT = {
  id: true,
  name: true,
  pricePaisa: true,
  discountPricePaisa: true,
  stockQuantity: true,
  ingredientTags: true,
  climateTips: true,
  images: true,
  // Read, not filtered. See the note above.
  archivedAt: true,
  category: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.ProductSelect;

/**
 * The product shape returned to the cart API.
 */
export type CartProduct = {
  id: string;
  name: string;
  pricePaisa: number;
  discountPricePaisa: number | null;
  stockQuantity: number;
  ingredientTags: string[];
  climateTips: string | null;
  images: string[];
  /** When the product was withdrawn from sale, if it was. */
  archivedAt: Date | null;
  category: { id: string; name: string; slug: string };
};

/**
 * A single cart line.
 */
export type CartLine = {
  id: string;
  productId: string;
  quantity: number;
  product: CartProduct;
  /** The unit price at the time the cart was read. */
  unitPricePaisa: number;
  /** `unitPricePaisa * quantity`. */
  lineTotalPaisa: number;
  /** True when the line's quantity exceeds the available stock. */
  exceedsStock: boolean;
  /**
   * False when the product has been withdrawn from sale.
   *
   * The line is **kept** — it is not silently removed — and the checkout
   * is blocked while an unavailable line is present. The customer sees
   * what happened and can remove the line themselves.
   */
  available: boolean;
};

/**
 * The full cart, as returned to the client.
 */
export type CartView = {
  id: string;
  items: CartLine[];
  subtotalPaisa: number;
  totalQuantity: number;
  /** The ingredient conflicts present in the current cart. */
  conflicts: CartConflictSummary[];
  /**
   * The coupon applied to this cart, or `null`.
   *
   * The type lives in `@/lib/coupons/rules` rather than here, because
   * that module is **pure** — it imports nothing from the codebase — so
   * naming its type here cannot create a cycle. The coupon *service*
   * does import this module, and that is the direction the dependency
   * runs: the coupon knows about the cart, and the cart knows nothing
   * about the coupon beyond the shape of one.
   *
   * `null` means "no coupon", and it is also what a coupon that has
   * become unusable since it was applied resolves to. The cart shows
   * the reason in that case, so the customer is not left wondering
   * where their discount went.
   */
  coupon: AppliedCoupon | null;
};

/**
 * A conflict, summarised for the cart API.
 */
export type CartConflictSummary = {
  ruleId: string;
  severity: "BLOCK" | "WARN";
  title: string;
  message: string;
  remedy: string;
  spacingAdvice: string;
  involvedProductIds: string[];
  ingredientIds: string[];
};

/**
 * The result of adding an item to the cart.
 */
export type AddToCartResult = {
  cart: CartView;
  /** The conflicts introduced by this addition. */
  newConflicts: CartConflictSummary[];
  /**
   * True when a `BLOCK` conflict now exists in the cart.
   *
   * The item is still added — the customer is told, and decides. A `force`
   * flag records that they were warned.
   */
  hasBlockingConflict: boolean;
};

/**
 * Finds the product, or throws a 404.
 *
 * The return type is the narrow projection the select actually returns —
 * not the full `Product` row. Typing it as `Product` would be a lie, and
 * it would let a future edit read a field that is not loaded.
 */
async function loadProduct(productId: string): Promise<CartProduct> {
  /**
   * `findFirst`, not `findUnique` — Prisma's `findUnique` accepts only
   * unique fields in its `where`, so `id` plus a non-unique
   * `archivedAt: null` would not compile.
   *
   * This is the **sell-path gate**: an archived product cannot be added
   * to a cart, even by a client that posts its id directly.
   *
   * The message says "does not exist" rather than "is no longer
   * available". That is deliberate. Naming the archive state would tell a
   * stranger that a product they cannot see was once for sale — and the
   * customer needs to know only one thing: this cannot be bought.
   */
  const product = await db.product.findFirst({
    where: { id: productId, ...ACTIVE_PRODUCT_WHERE },
    select: CART_PRODUCT_SELECT,
  });

  if (!product) {
    throw ApiError.notFound("That product does not exist.");
  }

  return product;
}

/**
 * Returns the user's cart, creating it if it does not exist.
 */
export async function getOrCreateCartId(userId: string): Promise<string> {
  const existing = await db.cart.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (existing) return existing.id;

  // `create` can race with a concurrent request for the same user, so the
  // unique constraint on `userId` may reject it. In that case the other
  // request won, and its cart is the correct one.
  try {
    const created = await db.cart.create({
      data: { userId },
      select: { id: true },
    });

    return created.id;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      const raced = await db.cart.findUnique({
        where: { userId },
        select: { id: true },
      });

      if (raced) return raced.id;
    }

    throw error;
  }
}

/**
 * Loads the cart with its products, and computes the totals.
 *
 * @param userId - The owner of the cart.
 */
export async function getCart(userId: string): Promise<CartView> {
  const cart = await db.cart.findUnique({
    where: { userId },
    select: {
      id: true,
      items: {
        select: {
          id: true,
          productId: true,
          quantity: true,
          product: { select: CART_PRODUCT_SELECT },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!cart) {
    return {
      id: "",
      items: [],
      subtotalPaisa: 0,
      totalQuantity: 0,
      conflicts: [],
      coupon: null,
    };
  }

  return buildCartView(cart.id, cart.items);
}

/**
 * The raw cart item rows, as loaded by `getCart`.
 */
type LoadedCartItem = {
  id: string;
  productId: string;
  quantity: number;
  product: CartProduct;
};

/**
 * Builds the cart view from loaded items, computing totals and conflicts.
 */
function buildCartView(
  cartId: string,
  items: LoadedCartItem[],
): CartView {
  const lines: CartLine[] = items.map((item) => {
    const unitPricePaisa =
      item.product.discountPricePaisa ?? item.product.pricePaisa;

    /**
     * The line is available unless the product has been withdrawn.
     *
     * The line is **kept** either way. Silently dropping it would change
     * the subtotal without the customer seeing a line disappear — the
     * total they agreed to would no longer be the total they are asked
     * to pay. The checkout is blocked instead, and the line is marked so
     * the customer can remove it themselves.
     */
    const available = item.product.archivedAt === null;

    return {
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      product: item.product,
      unitPricePaisa,
      lineTotalPaisa: unitPricePaisa * item.quantity,
      exceedsStock: item.quantity > item.product.stockQuantity,
      available,
    };
  });

  const subtotalPaisa = lines.reduce(
    (total, line) => total + line.lineTotalPaisa,
    0,
  );

  const totalQuantity = lines.reduce(
    (total, line) => total + line.quantity,
    0,
  );

  return {
    id: cartId,
    items: lines,
    subtotalPaisa,
    totalQuantity,
    conflicts: evaluateCartConflicts(lines),
    // The coupon is resolved by the coupon service, not here. This is
    // the cart's own arithmetic — the lines, the subtotal and the
    // conflicts — and a discount is a separate fact about the cart.
    coupon: null,
  };
}

/**
 * Evaluates the ingredient conflicts present in the cart.
 *
 * A thin wrapper over the pure engine, translating its output into the
 * shape the cart API returns. The engine itself is imported from
 * `@/lib/conflicts/engine` so the safety path stays free of any I/O.
 */
export function evaluateCartConflicts(
  lines: readonly CartLine[],
): CartConflictSummary[] {
  const evaluation = evaluateConflicts(
    lines.map((line) => ({
      id: line.productId,
      ingredientTags: line.product.ingredientTags,
    })),
  );

  return evaluation.conflicts.map((conflict) => ({
    ruleId: conflict.ruleId,
    severity: conflict.severity,
    title: conflict.title,
    message: conflict.message,
    remedy: conflict.remedy,
    spacingAdvice: conflict.spacingAdvice,
    involvedProductIds: conflict.involvedProductIds,
    ingredientIds: conflict.ingredientIds,
  }));
}

/**
 * Adds a product to the cart.
 *
 * The product is added even when it introduces a `BLOCK` conflict. The
 * conflict is returned so the client can warn the customer clearly, with
 * the remedy and the spacing advice. Refusing the add outright would hide
 * the information the customer needs to make the decision themselves.
 *
 * @param userId    - The owner of the cart.
 * @param productId - The product to add.
 * @param quantity  - How many to add.
 */
export async function addToCart(
  userId: string,
  productId: string,
  quantity: number,
): Promise<AddToCartResult> {
  const product = await loadProduct(productId);

  if (product.stockQuantity <= 0) {
    throw ApiError.conflict("That product is out of stock.");
  }

  const cartId = await getOrCreateCartId(userId);

  const existing = await db.cartItem.findUnique({
    where: { cartId_productId: { cartId, productId } },
    select: { id: true, quantity: true },
  });

  const desiredQuantity = (existing?.quantity ?? 0) + quantity;

  if (desiredQuantity > product.stockQuantity) {
    throw ApiError.conflict(
      `Only ${product.stockQuantity} of "${product.name}" ${product.stockQuantity === 1 ? "is" : "are"} in stock.`,
    );
  }

  if (existing) {
    await db.cartItem.update({
      where: { id: existing.id },
      data: { quantity: desiredQuantity },
    });
  } else {
    await db.cartItem.create({
      data: { cartId, productId, quantity },
    });
  }

  const cart = await getCart(userId);

  /**
   * The conflicts that involve the product just added.
   *
   * These are the ones the customer needs to see right now. The full set
   * is on `cart.conflicts`.
   */
  const newConflicts = cart.conflicts.filter((conflict) =>
    conflict.involvedProductIds.includes(productId),
  );

  return {
    cart,
    newConflicts,
    hasBlockingConflict: newConflicts.some(
      (conflict) => conflict.severity === "BLOCK",
    ),
  };
}

/**
 * Updates the quantity of a cart line.
 *
 * The line is scoped by both its id and the owning cart, so a customer
 * cannot modify a line in somebody else's cart even if they guess the
 * line id. A line that is not found returns 404 — the same response as a
 * line belonging to another user, so the endpoint does not leak the
 * existence of other users' carts.
 */
export async function updateCartItemQuantity(
  userId: string,
  itemId: string,
  quantity: number,
): Promise<CartView> {
  const cartId = await getOrCreateCartId(userId);

  const item = await db.cartItem.findFirst({
    where: { id: itemId, cartId },
    select: {
      id: true,
      productId: true,
      quantity: true,
      // The archive flag is **read**, not filtered. A nested `where`
      // here would be an inner join, and the cart item would silently
      // not be found — the customer would get "that item is not in your
      // cart" for a line that is plainly in their cart, and they would
      // have no way to remove it.
      product: {
        select: { stockQuantity: true, name: true, archivedAt: true },
      },
    },
  });

  if (!item) {
    throw ApiError.notFound("That item is not in your cart.");
  }

  /**
   * An archived product's line cannot be adjusted.
   *
   * The line stays in the cart — the customer can still **remove** it,
   * which is the action that actually helps them. Changing the quantity
   * of a withdrawn product is meaningless, and allowing it would let a
   * customer keep inflating a line that checkout will refuse.
   */
  if (item.product.archivedAt !== null) {
    throw ApiError.conflict(
      `"${item.product.name}" is no longer available. Please remove it from your cart.`,
    );
  }

  if (quantity > item.product.stockQuantity) {
    throw ApiError.conflict(
      `Only ${item.product.stockQuantity} of "${item.product.name}" ${item.product.stockQuantity === 1 ? "is" : "are"} in stock.`,
    );
  }

  await db.cartItem.update({
    where: { id: item.id },
    data: { quantity },
  });

  return getCart(userId);
}

/**
 * Removes a line from the cart.
 *
 * Scoped by the owning cart, for the same reason as
 * `updateCartItemQuantity`.
 */
export async function removeCartItem(
  userId: string,
  itemId: string,
): Promise<CartView> {
  const cartId = await getOrCreateCartId(userId);

  const item = await db.cartItem.findFirst({
    where: { id: itemId, cartId },
    select: { id: true },
  });

  if (!item) {
    throw ApiError.notFound("That item is not in your cart.");
  }

  await db.cartItem.delete({ where: { id: item.id } });

  return getCart(userId);
}

/**
 * Clears the cart.
 */
export async function clearCart(userId: string): Promise<CartView> {
  const cart = await db.cart.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (cart) {
    await db.cartItem.deleteMany({ where: { cartId: cart.id } });
  }

  return getCart(userId);
}
