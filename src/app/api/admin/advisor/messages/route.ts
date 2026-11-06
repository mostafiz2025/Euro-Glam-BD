import { MessageRole } from "@prisma/client";
import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { adminAdvisorMessagesQuerySchema } from "@/lib/validation/advisor";

/**
 * GET /api/admin/advisor/messages
 *
 * The monitoring view. PRD §4 asks the admin to "monitor chatbot
 * recommendations" — this is where that happens: every advisor message
 * across every customer, filterable by conversation, by customer, by
 * whether the answer came from the mock or a real provider, and by date
 * range.
 *
 * ── The date range is inclusive on both ends ─────────────────────────────
 *
 * `from` and `to` are both `gte`/`lte`. A range that excluded the upper
 * bound would silently drop every message on the final day of the range,
 * which looks exactly like "there were no messages that day" — a silent
 * empty result, the bug class this codebase keeps guarding against.
 *
 * ── The counts use the same `where` shape as the list ────────────────────
 *
 * `total` is computed from the same filter, so a filter that matches
 * nothing shows `total: 0` and an empty list together. They cannot
 * disagree.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  try {
    const admin = await requireAdmin();

    const url = new URL(request.url);
    const query = adminAdvisorMessagesQuerySchema.parse({
      conversationId: url.searchParams.get("conversationId") ?? undefined,
      userId: url.searchParams.get("userId") ?? undefined,
      isMocked: url.searchParams.get("isMocked") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    // ── The filter ────────────────────────────────────────────────────────
    const where = {
      ...(query.conversationId
        ? { conversationId: query.conversationId }
        : {}),
      ...(query.userId
        ? { conversation: { userId: query.userId } }
        : {}),
      ...(query.isMocked !== undefined ? { isMocked: query.isMocked } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [rows, total] = await Promise.all([
      db.advisorMessage.findMany({
        where,
        select: {
          id: true,
          conversationId: true,
          role: true,
          content: true,
          provider: true,
          model: true,
          isMocked: true,
          meta: true,
          createdAt: true,
          conversation: {
            select: {
              id: true,
              title: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: query.limit,
      }),
      db.advisorMessage.count({ where }),
    ]);

    return ok({
      admin: { id: admin.id, email: admin.email },
      messages: rows.map((row) => ({
        id: row.id,
        conversationId: row.conversationId,
        role:
          row.role === MessageRole.USER
            ? "USER"
            : row.role === MessageRole.ASSISTANT
              ? "ASSISTANT"
              : "SYSTEM",
        content: row.content,
        provider: row.provider,
        model: row.model,
        isMocked: row.isMocked,
        meta: row.meta,
        createdAt: row.createdAt.toISOString(),
        conversation: {
          id: row.conversation.id,
          title: row.conversation.title,
          user: row.conversation.user,
        },
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
