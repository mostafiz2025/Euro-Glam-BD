import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import type { SessionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";

import {
  PRODUCT_ACTIONS,
  toAuditActor,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin product service.
 *
 * ── What this module is allowed to do ────────────────────────────────────
 *
 * **Stock only.** The admin surface can adjust how many units of a
 * product are on the shelf. It cannot create a product, rename one,
 * change its price, or move it between categories.
 *
 * That is not an oversight — it is the scope. A product's price and
 * identity are part of the catalogue's contract with the customer, and
 * a price change is a commercial decision that belongs to the shop
 * owner with a clear record of the old price, the new price and the
 * reason. Stock is different: it changes daily, it is corrected after
 * a miscount, and it is the one number that must never be wrong in a
 * way that lets a customer order something the shop does not have.
 *
 * So the write path here is deliberately narrow, and it is audited.
 */

/**
 * The shape of a product row after a stock adjustment.
 */
export type AdminProductStock = {
  id: string;
  name: string;
  stockQuantity: number;
  updatedAt: Date;
};

/**
 * The Prisma select for the stock-adjusted product.
 */
const STOCK_PRODUCT_SELECT = {
  id: true,
  name: true,
  stockQuantity: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

/**
 * The result of a stock adjustment.
 */
export type StockAdjustmentResult = {
  product: AdminProductStock;
  /** The quantity before the adjustment. */
  previousQuantity: number;
  /** The signed change that was applied. */
  delta: number;
  /** The quantity after the adjustment. */
  newQuantity: number;
};

/**
 * Adjusts a product's stock quantity.
 *
 * ── The rules that govern this write ─────────────────────────────────────
 *
 * **1. The adjustment is relative, not absolute.**
 *
 * The admin says "add 10" or "remove 3", not "set to 42". A relative
 * adjustment cannot clobber a concurrent change: if a customer checks
 * out while the admin is adjusting, the delta is applied to whatever
 * the quantity is *now*, and the units the customer reserved stay
 * reserved. An absolute "set to N" would silently destroy the stock
 * that checkout had already deducted.
 *
 * **2. The result can never be negative.**
 *
 * A negative stock is the single most damaging thing that can be wrong
 * in a shop: it tells the customer the item is available when it is
 * not, and it lets them order it. The database column is not
 * constrained, so the check lives here — and it is a *refusal*, not a
 * clamp. Silently setting it to zero would hide the admin's mistake;
 * refusing it tells them the shelf does not hold that many.
 *
 * **3. The write and its audit entry share a transaction.**
 *
 * Same rule as every other admin mutation: a stock change without a
 * record of who made it is worse than no change, because it looks
 * complete.
 *
 * **4. The write is conditional on the current quantity.**
 *
 * The `updateMany` matches on the quantity the read observed. This
 * closes the window between the read and the write: if the row changed
 * in that window, the update matches zero rows rather than silently
 * overwriting whatever happened.
 *
 * Note what this does and does not do. It does **not** make two
 * concurrent deltas conflict — a delta is commutative, so two admins
 * both adding five correctly compose to "add ten", and the second
 * transaction reads the first's result and adds to it. That is the
 * desired behaviour, and it is why a missed conditional update
 * **retries** rather than failing: the retry re-reads the new
 * quantity and adds to that.
 *
 * What it prevents is the *absolute* overwrite: an admin who saw "10
 * on the shelf" cannot write "10" over a quantity that has since become
 * 9, because 9 is no longer 10. The reserved unit stays reserved.
 *
 * The retry is bounded. After a few attempts against a row that keeps
 * moving, the adjustment is refused with a 409 — and refusing is the
 * honest answer, because the shelf is changing faster than one
 * adjustment can be recorded.
 *
 * @param actor     - The admin making the adjustment.
 * @param productId - The product to adjust.
 * @param delta     - The signed change. Negative removes stock.
 * @param reason    - An optional note, stored on the audit entry.
 *
 * @throws ApiError 404 when the product does not exist.
 * @throws ApiError 409 when the result would be negative, or when the
 *         quantity changed between the read and the write.
 */
export async function adjustProductStock(
  actor: AuditActor,
  productId: string,
  delta: number,
  reason?: string,
): Promise<StockAdjustmentResult> {
  // The number of times the adjustment re-reads the quantity and tries
  // again when another admin changed it in between.
  //
  // One retry is enough for the case that matters: two admins adding
  // five to the same product. The second transaction's conditional
  // update misses because the first committed first, and the retry
  // re-reads the new quantity and adds to *that*, so the two compose
  // to "add ten" exactly as the module's contract promises.
  //
  // The cap exists so a genuinely contended row — an admin adjusting
  // the same product over and over — cannot spin forever. Past the
  // cap the adjustment is refused, and refusing is the honest answer:
  // the shelf is changing faster than one adjustment can be recorded.
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const current = await tx.product.findUnique({
            where: { id: productId },
            select: { id: true, name: true, stockQuantity: true },
          });

          if (!current) {
            throw ApiError.notFound("That product does not exist.");
          }

          const newQuantity = current.stockQuantity + delta;

          if (newQuantity < 0) {
            throw ApiError.conflict(
              `That adjustment would leave the stock at ${newQuantity}. There are only ${current.stockQuantity} units on the shelf.`,
              {
                productId,
                currentQuantity: current.stockQuantity,
                requestedDelta: delta,
                resultingQuantity: newQuantity,
              },
            );
          }

          // The conditional update. The condition is the quantity the
          // read observed, so a concurrent adjustment makes this one
          // match zero rows rather than overwriting it.
          const updated = await tx.product.updateMany({
            where: { id: productId, stockQuantity: current.stockQuantity },
            data: { stockQuantity: newQuantity },
          });

          if (updated.count === 0) {
            // Another admin changed the row between this transaction's
            // read and its write. Because a *delta* is commutative, the
            // right thing is to re-read and add to the new quantity —
            // not to fail. So this rolls the transaction back and
            // signals the caller to try again.
            throw new StockChangedDuringAdjustment();
          }

          await writeAuditEntry(tx, {
            actor,
            action: PRODUCT_ACTIONS.stockAdjusted,
            entityType: "product",
            entityId: productId,
            before: { stockQuantity: current.stockQuantity },
            after: { stockQuantity: newQuantity },
            reason: reason ?? null,
          });

          const product = await tx.product.findUnique({
            where: { id: productId },
            select: STOCK_PRODUCT_SELECT,
          });

          if (!product) {
            throw ApiError.notFound("That product does not exist.");
          }

          return {
            product,
            previousQuantity: current.stockQuantity,
            delta,
            newQuantity,
          };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      if (!(error instanceof StockChangedDuringAdjustment)) {
        throw error;
      }

      // Fall through to the next attempt: re-read the quantity and
      // add the delta to whatever it is now.
    }
  }

  // Every attempt lost the race. The row is moving faster than one
  // adjustment can be recorded, so refuse rather than guess.
  throw ApiError.conflict(
    "Someone else changed this product's stock while you were adjusting it. Reload and try again.",
  );
}

/**
 * The signal that the conditional update matched zero rows — another
 * admin changed the quantity between this transaction's read and its
 * write.
 *
 * This is deliberately **not** an `ApiError`. It is an internal
 * retry signal: it never leaves `adjustProductStock`, and the caller
 * sees either a successful adjustment or a 409. If it escaped as a
 * 409 on the first miss, two admins adding five at the same time would
 * get one success and one rejection — which is the behaviour the
 * module's contract explicitly rules out.
 */
class StockChangedDuringAdjustment extends Error {
  constructor() {
    super("The stock changed while the adjustment was in flight.");
    this.name = "StockChangedDuringAdjustment";
  }
}

/**
 * Convenience wrapper that adjusts stock on behalf of a session user.
 */
export async function adjustProductStockAsUser(
  user: SessionUser,
  productId: string,
  delta: number,
  reason?: string,
): Promise<StockAdjustmentResult> {
  return adjustProductStock(toAuditActor(user), productId, delta, reason);
}
