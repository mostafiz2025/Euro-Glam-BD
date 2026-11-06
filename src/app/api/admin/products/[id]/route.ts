import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import {
  archiveProduct,
  getAdminProduct,
  hardDeleteProduct,
  updateProductAsUser,
} from "@/lib/admin/catalog";
import { toAuditActor } from "@/lib/admin/audit";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { productDeleteSchema, productUpdateSchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/products/[id]
 *
 * One product, in full, for the admin product form.
 *
 * Unlike the storefront, this read does **not** filter archived
 * products — an admin has to be able to open a withdrawn product in
 * order to restore it.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    await requireAdmin();

    const { id } = await context.params;

    const productId = entityIdSchema.parse(id);

    const product = await getAdminProduct(productId);

    return ok({ product });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PATCH /api/admin/products/[id]
 *
 * Updates a product.
 *
 * Body: every field optional — a partial update changes only what it
 * names.
 *
 *   {
 *     name?: string,
 *     description?: string,
 *     brand?: string | null,
 *     categoryId?: string,
 *     pricePaisa?: number,
 *     discountPricePaisa?: number | null,
 *     purchasePricePaisa?: number | null,
 *     sellingPricePaisa?: number | null,
 *     ingredientTags?: string[],
 *     climateTips?: string | null,
 *     images?: string[],
 *     badges?: string[],
 *     isNewArrival?: boolean,
 *     isBestSeller?: boolean,
 *     stockDelta?: number,
 *     reason?: string
 *   }
 *
 * `brand` is the product's **stored** brand. Sending `null` clears it;
 * omitting it leaves it alone. A known brand is canonicalised to its
 * registry spelling, so "cerave" is stored as "CeraVe".
 *
 * `badges` is the **source of truth** for the promotional labels. The
 * two legacy booleans are a mirror of two entries in it, maintained by
 * the catalogue service — a client may send either, and the service
 * keeps them consistent.
 *
 * `purchasePricePaisa` and `sellingPricePaisa` are the **cost side** of
 * the ledger. Sending `null` clears the recorded cost; omitting the
 * field leaves it alone. `null` means "not known", not zero — a product
 * whose cost has never been recorded is excluded from the profit
 * figures rather than counted as if the goods were free.
 *
 * Two rules make this safe:
 *
 *   1. **A stock change is a signed delta**, never an absolute
 *      quantity. An absolute would silently destroy a concurrent
 *      checkout's reservation.
 *   2. **The write is conditional** on the values the admin's page was
 *      loaded with. Two admins editing the same product produce one
 *      winner and one 409.
 *
 * A **price change requires a reason** — the price is a commercial
 * decision, and "why" is part of the record.
 *
 * Admin only.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const { id } = await context.params;

    const productId = entityIdSchema.parse(id);

    const body = productUpdateSchema.parse(await request.json());

    const product = await updateProductAsUser(admin, productId, body);

    return ok({ product });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/admin/products/[id]
 *
 * Removes a product from sale.
 *
 * Body:
 *
 *   {
 *     confirmName: string,     // the product's name, typed
 *     reason: string,          // mandatory
 *     mode?: "archive" | "hard"
 *   }
 *
 * **`mode=archive` (the default)** withdraws the product: it sets
 * `archivedAt`, and the shared storefront filter hides it from every
 * customer-facing query. The order history survives. This is almost
 * always the right answer.
 *
 * **`mode=hard`** removes the row from the database. It is possible
 * only for a product with no order items, no cart items and no
 * reviews — anything else is refused with a 409 that names the
 * blocker and the remedy.
 *
 * The typed `confirmName` is the standard confirmation for "this exact
 * thing". A destructive action with one click is a destructive action
 * somebody will do by accident.
 *
 * **A product can be restored** with
 * `POST /api/admin/products/[id]/restore` — restoration is a dedicated
 * action, because putting a product back on sale is a commercial
 * decision like withdrawing it.
 *
 * Admin only.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const { id } = await context.params;

    const productId = entityIdSchema.parse(id);

    const body = productDeleteSchema.parse(await request.json());

    // The confirmation must name the product that is actually being
    // removed. A client that sends the wrong name is refused before
    // anything is written.
    const product = await getAdminProduct(productId);

    if (body.confirmName.trim() !== product.name.trim()) {
      throw ApiError.validation(
        "Type the product's name to confirm.",
        {
          fieldErrors: {
            confirmName: [
              "That does not match the product's name. Type it exactly.",
            ],
          },
        },
      );
    }

    const actor = toAuditActor(admin);

    const result =
      body.mode === "hard"
        ? await hardDeleteProduct(actor, productId, body.reason)
        : await archiveProduct(actor, productId, body.reason);

    return ok({ product: result });
  } catch (error) {
    return handleApiError(error);
  }
}
