import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireUser } from "@/lib/auth/guards";
import { deleteConversation, getConversation } from "@/lib/ai/conversations";
import { entityIdSchema } from "@/lib/validation/commerce";

/**
 * GET /api/advisor/conversations/[id]
 *
 * One conversation with its full message history.
 *
 * A conversation that does not exist and a conversation belonging to
 * somebody else both answer `404`. A `403` would confirm the id is real,
 * which leaks the existence of other people's conversations — so the
 * service layer returns `null` for both cases and this route cannot tell
 * them apart.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    const user = await requireUser();

    const { id } = await context.params;
    const conversationId = entityIdSchema.parse(id);

    const conversation = await getConversation(user.id, conversationId);

    if (!conversation) {
      throw ApiError.notFound("That conversation does not exist.");
    }

    return ok({ conversation });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/advisor/conversations/[id]
 *
 * Removes the conversation, its messages, its images, and the image files
 * in storage.
 *
 * The storage purge happens *after* the rows are deleted, because a
 * database cascade cannot reach the filesystem. A failed purge is logged
 * and swallowed — the user asked for the conversation to be gone, and it
 * is. The orphaned file is a disk-space problem, not a correctness one.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  await connection();

  try {
    const user = await requireUser();

    const { id } = await context.params;
    const conversationId = entityIdSchema.parse(id);

    const deleted = await deleteConversation(user.id, conversationId);

    if (!deleted) {
      throw ApiError.notFound("That conversation does not exist.");
    }

    return ok({ deleted: true, conversationId });
  } catch (error) {
    return handleApiError(error);
  }
}
