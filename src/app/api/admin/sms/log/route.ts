import { connection } from "next/server";
import { Prisma } from "@prisma/client";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { smsLogQuerySchema } from "@/lib/validation/admin";

/**
 * GET /api/admin/sms/log
 *
 * The SMS log — every message the system has attempted, with its
 * outcome.
 *
 * Query parameters (all optional):
 *
 *   userId        filter to one recipient
 *   status        sent | failed | queued
 *   orderItemId   filter to one order item
 *   page          1-based page number
 *   limit         rows per page (max 100)
 *
 * The `body` column is included, because the support question "what did
 * the customer actually receive?" cannot be answered without it. The
 * body never contains a shipping address — that is enforced by the
 * template.
 *
 * Admin only.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  await connection();

  try {
    await requireAdmin();

    const url = new URL(request.url);

    const rawQuery: Record<string, string> = {};

    for (const [key, value] of url.searchParams.entries()) {
      rawQuery[key] = value;
    }

    const query = smsLogQuerySchema.parse(rawQuery);

    const where: Prisma.SmsLogWhereInput = {
      AND: [
        ...(query.userId ? [{ userId: query.userId }] : []),
        ...(query.status ? [{ status: query.status }] : []),
        ...(query.orderItemId ? [{ orderItemId: query.orderItemId }] : []),
      ],
    };

    const skip = (query.page - 1) * query.limit;

    const [logs, total, sentCount, failedCount] = await Promise.all([
      db.smsLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: query.limit,
        select: {
          id: true,
          phone: true,
          body: true,
          userId: true,
          status: true,
          provider: true,
          idempotencyKey: true,
          errorCode: true,
          orderItemId: true,
          reason: true,
          createdAt: true,
        },
      }),
      db.smsLog.count({ where }),
      db.smsLog.count({ where: { status: "sent" } }),
      db.smsLog.count({ where: { status: "failed" } }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / query.limit));

    return ok({
      logs,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages,
        hasNextPage: query.page < totalPages,
        hasPreviousPage: query.page > 1,
      },
      counts: {
        sent: sentCount,
        failed: failedCount,
        total: sentCount + failedCount,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
