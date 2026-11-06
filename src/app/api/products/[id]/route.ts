import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { getProductById } from "@/lib/catalog/service";
import { productIdSchema } from "@/lib/validation/commerce";

/**
 * GET /api/products/[id]
 *
 * The product detail page's data source.
 *
 * Returns the product, its rating summary, and a few related products
 * from the same category.
 *
 * The `id` is validated before it reaches the database, so a malformed id
 * returns a 400 rather than being passed to Prisma.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route has a dynamic segment and hits
  // the database.
  await connection();

  try {
    // Next.js 16 delivers route params as a promise.
    const { id } = await context.params;

    const productId = productIdSchema.parse(id);

    const product = await getProductById(productId);

    if (!product) {
      throw ApiError.notFound("That product does not exist.");
    }

    return ok({ product });
  } catch (error) {
    return handleApiError(error);
  }
}
