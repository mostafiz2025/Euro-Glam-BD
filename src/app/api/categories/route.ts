import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { listCategories } from "@/lib/catalog/service";

/**
 * GET /api/categories
 *
 * The category list, with a product count for each.
 *
 * Public: no session required.
 */
export async function GET(): Promise<Response> {
  // Opt out of prerendering — this route hits the database.
  await connection();

  try {
    const categories = await listCategories();

    return ok({ categories });
  } catch (error) {
    return handleApiError(error);
  }
}
