import { connection } from "next/server";

import { handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireUser } from "@/lib/auth/guards";
import { listConversations } from "@/lib/ai/conversations";
import { conversationListQuerySchema } from "@/lib/validation/advisor";

/**
 * GET /api/advisor/conversations
 *
 * The signed-in user's advisor conversations, newest first.
 *
 * ── The ownership rule ────────────────────────────────────────────────────
 *
 * The list is scoped by `userId` in the `where` clause inside the service
 * layer, not filtered here. A conversation belonging to somebody else is
 * indistinguishable from one that does not exist — there is no code path
 * that returns another user's conversation, however the query is built.
 *
 * The pagination is **cursor**-based, not offset-based. A conversation list
 * sorted by `lastMessageAt` shifts under an offset: a customer who starts a
 * new conversation while paginating would see an item twice, or miss one
 * entirely. A cursor anchored to the last row's id cannot skip.
 */
export async function GET(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie.
  // `connection()` MUST be outside the try block.
  await connection();

  try {
    const user = await requireUser();

    const url = new URL(request.url);
    const query = conversationListQuerySchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });

    const { conversations, nextCursor } = await listConversations(
      user.id,
      query.limit,
      query.cursor,
    );

    return ok({
      conversations,
      nextCursor,
      limit: query.limit,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
