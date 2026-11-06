import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { created, ok } from "@/lib/api/respond";
import { createProductAsUser } from "@/lib/admin/catalog";
import { listAdminProducts } from "@/lib/admin/stats";
import { requireAdmin } from "@/lib/auth/guards";
import {
  adminProductQuerySchema,
  productCreateSchema,
} from "@/lib/validation/admin";

/**
 * GET /api/admin/products
 *
 * The inventory list.
 *
 * Query parameters (all optional):
 *
 *   stock     ALL | IN_STOCK | OUT_OF_STOCK | LOW_STOCK | ARCHIVED
 *   search    matches the product name
 *   page      1-based page number
 *   limit     rows per page (max 100)
 *
 * The `counts` block reports the number of products in each band over
 * the whole table rather than the filtered page — so an admin can see
 * "6 out of stock" and navigate to them even while looking at a
 * filtered list.
 *
 * **`ARCHIVED` is a band of its own.** Archived products are withdrawn
 * from sale, not deleted, and the admin read deliberately does *not*
 * filter them out — an admin has to be able to find a withdrawn
 * product in order to restore it. They are invisible in every
 * storefront query, so this list is the only place they appear.
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminProductQuerySchema.parse(rawQuery);

    const result = await listAdminProducts(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * POST /api/admin/products
 *
 * Creates a product.
 *
 * Body:
 *
 *   {
 *     name: string,
 *     description?: string,
 *     brand?: string | null,
 *     categoryId: string,
 *     pricePaisa: number,
 *     discountPricePaisa?: number,
 *     purchasePricePaisa?: number | null,
 *     sellingPricePaisa?: number | null,
 *     stockQuantity?: number,
 *     ingredientTags?: string[],
 *     concernSlugs?: string[],
 *     climateTips?: string,
 *     images?: string[],
 *     badges?: string[],
 *     isNewArrival?: boolean,
 *     isBestSeller?: boolean
 *   }
 *
 * `brand` is the product's **stored** brand. It is optional and
 * nullable — a product genuinely may have no brand. A known brand is
 * canonicalised to its registry spelling, so "cerave" is stored as
 * "CeraVe"; a brand the shop stocks but the registry has never heard of
 * is stored trimmed and whitespace-collapsed.
 *
 * `concernSlugs` is the product's **Shop by Concern** selection — the
 * slugs of the concerns in the `SkinConcern` table. The vocabulary is a
 * table, not a constant, so the slugs are checked against it at write
 * time: a slug that names no concern is refused with a 400 rather than
 * stored and silently ignored by the storefront.
 *
 * `badges` is the **source of truth** for the promotional labels. The
 * two legacy booleans are a mirror of two entries in it, maintained by
 * the catalogue service — a client may send either, and the service
 * keeps them consistent.
 *
 * `purchasePricePaisa` and `sellingPricePaisa` are the **cost side** of
 * the ledger — what the shop paid, and what it charges. Both are
 * nullable, and `null` means "not known". It is not zero: a product
 * whose cost has never been recorded is **excluded** from the profit
 * figures rather than counted as if the goods were free.
 *
 * The product and its `PRODUCT_CREATED` audit entry are written in
 * **one** transaction — a product that exists with no record of who
 * added it is worse than one that was never added.
 *
 * The product is created **live**. It is not created archived; a
 * withdrawal is a separate, deliberate act.
 *
 * Admin only.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    const admin = await requireAdmin();

    const body = productCreateSchema.parse(await request.json());

    const product = await createProductAsUser(admin, body);

    return created({ product });
  } catch (error) {
    return handleApiError(error);
  }
}
