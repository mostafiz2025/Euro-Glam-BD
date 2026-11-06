import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { getCategoryBySlug } from "@/lib/catalog/service";
import { categorySlugSchema } from "@/lib/validation/commerce";

/**
 * GET /api/categories/[slug]
 *
 * A single category, looked up by its slug.
 *
 * The slug is validated before it reaches the database.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  // Opt out of prerendering — this route has a dynamic segment and hits
  // the database.
  await connection();

  try {
    const { slug } = await context.params;

    const categorySlug = categorySlugSchema.parse(slug);

    const category = await getCategoryBySlug(categorySlug);

    if (!category) {
      throw ApiError.notFound("That category does not exist.");
    }

    return ok({ category });
  } catch (error) {
    return handleApiError(error);
  }
}
