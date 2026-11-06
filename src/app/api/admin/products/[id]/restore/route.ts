import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { toAuditActor } from "@/lib/admin/audit";
import { restoreProduct } from "@/lib/admin/catalog";
import { requireAdmin } from "@/lib/auth/guards";
import { entityIdSchema } from "@/lib/validation/commerce";
import { z } from "zod";

/**
 * POST /api/admin/products/[id]/restore
 *
 * Puts an archived product back on sale.
 *
 * Body:
 *
 *   { reason: string }
 *
 * Restoration is a **commercial decision**, exactly like archiving. It
 * is not a side effect of an update — it is its own action, with its
 * own audit entry, because "when did we put this back on sale, and
 * why" is a question an audit exists to answer.
 *
 * The write and the audit entry share one transaction, and the write
 * is conditional on the product still being archived — so two admins
 * restoring the same product produce one winner and one 409.
 *
 * Admin only.
 */
export async function POST(
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

    const body = z
      .object({
        reason: z
          .string()
          .trim()
          .min(1, "Give a reason for the restoration.")
          .max(500, "That reason is too long."),
      })
      .parse(await request.json());

    const product = await restoreProduct(
      toAuditActor(admin),
      productId,
      body.reason,
    );

    return ok({ product });
  } catch (error) {
    return handleApiError(error);
  }
}
