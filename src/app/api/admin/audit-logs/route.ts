import { AdminAction } from "@prisma/client";
import { connection } from "next/server";

import { listAuditLogs } from "@/lib/admin/audit-logs";
import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { adminAuditLogQuerySchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/audit-logs
 *
 * The audit-trail explorer.
 *
 * Query parameters (all optional):
 *
 *   action      one `AdminAction` value
 *   entityType  filter to one kind of thing — "product", "order", …
 *   actorId     filter to one admin
 *   search      match the actor's name, email, the reason, or the entity id
 *   page        1-based page number
 *   limit       rows per page (max 100)
 *
 * An unrecognised `action` is a **400**, not a default. An admin who
 * filters for something the server does not recognise and gets back an
 * unfiltered list would have no way of knowing their filter was ignored.
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // hits the database. `connection()` MUST be called outside the try
  // block: its rejection is the signal that aborts prerendering.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = adminAuditLogQuerySchema.parse(rawQuery);

    const result = await listAuditLogs({
      ...query,
      ...(query.action !== undefined
        ? { action: query.action as AdminAction }
        : {}),
    });

    return ok(result);
  } catch (error) {
    return handleApiError(error);
  }
}
