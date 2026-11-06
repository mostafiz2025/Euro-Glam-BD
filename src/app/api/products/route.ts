import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { listProducts } from "@/lib/catalog/service";
import { productListQuerySchema } from "@/lib/validation/commerce";

/**
 * GET /api/products
 *
 * The public product catalogue: list, search, filter and paginate.
 *
 * Query parameters (all optional):
 *
 *   search          free-text term, matched against name and description
 *   category        category slug
 *   ingredient      canonical ingredient ID, e.g. RETINOL
 *   concern         skin concern slug, e.g. acne
 *   isNewArrival    true | false
 *   isBestSeller    true | false
 *   inStock         true | false
 *   minPricePaisa  integer poisha
 *   maxPricePaisa  integer poisha
 *   sort            newest | oldest | price-asc | price-desc | name-asc | name-desc
 *   page            1-based page number
 *   limit           rows per page (max 60)
 *
 * Every parameter is validated by Zod. An invalid value returns a 400
 * with the offending field named — never a silently ignored filter, which
 * would return "results for your search" that the caller did not ask for.
 *
 * `ingredient` and `concern` are two different axes. The ingredient
 * filter asks "what is *in* this product?"; the concern filter asks
 * "what is this product *for*?" — and a product containing salicylic
 * acid is not thereby an acne product. Both are supported, because a
 * shopper browsing by concern and a shopper browsing by ingredient are
 * asking different questions.
 *
 * Public: no session required. The catalogue is the storefront.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering. The route reads the query string and hits
  // the database; a build machine may have no database credentials.
  //
  // `connection()` MUST be called outside the try block — its rejection is
  // the signal that aborts prerendering.
  await connection();

  try {
    const url = new URL(request.url);

    // `Object.fromEntries` collapses repeated parameters to the last
    // value. A query string is a flat namespace, so that is the correct
    // behaviour for a single-valued schema.
    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = productListQuerySchema.parse(rawQuery);

    const result = await listProducts(query);

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
