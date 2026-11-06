import { db } from "@/lib/db";

/**
 * The advisor conversation service.
 *
 * ── The ownership rule ───────────────────────────────────────────────────
 *
 * A conversation belongs to exactly one user. Every read and every
 * delete is scoped by `userId` in the `where` clause — not checked in
 * application code afterwards. A conversation id belonging to somebody
 * else returns `null`, exactly like a conversation that does not exist.
 *
 * The distinction matters: a `403` ("that conversation exists but is
 * not yours") confirms the id is real. A `404` does not. The service
 * returns `null` for both cases so the route can answer `404` for both.
 */

import { MessageRole, type Prisma } from "@prisma/client";

import { getStorageUrl } from "@/lib/storage";

/**
 * A conversation, as returned to the client.
 */
export type ConversationSummary = {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly lastMessageAt: string;
  readonly messageCount: number;
};

/**
 * A message, as returned to the client.
 */
export type ConversationMessage = {
  readonly id: string;
  readonly role: "USER" | "ASSISTANT";
  readonly content: string;
  readonly createdAt: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly isMocked: boolean;
  readonly meta: unknown;
  readonly images: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly mimeType: string;
  }>;
};

/**
 * The conversation with its full message history.
 */
export type ConversationDetail = ConversationSummary & {
  readonly messages: readonly ConversationMessage[];
};

/**
 * The title of the hidden conversation that holds a customer's profile
 * photo.
 *
 * `AdvisorImage.conversationId` is required, so a photo set before any
 * conversation exists needs a home. It gets one — a conversation with
 * this exact title, reused across swaps — and it is filtered out of every
 * customer-facing list.
 *
 * A sentinel title rather than a boolean column: a column would mean
 * every conversation query has to remember to exclude it, and a query
 * that forgets produces a phantom conversation in the customer's history.
 * One well-known title is a single, obvious place to look.
 */
export const PROFILE_PHOTO_CONVERSATION_TITLE = "__profile_photo__";

/**
 * The select for a conversation summary.
 */
const SUMMARY_SELECT = {
  id: true,
  title: true,
  createdAt: true,
  lastMessageAt: true,
  _count: { select: { messages: true } },
} satisfies Prisma.AdvisorConversationSelect;

/**
 * Lists the user's conversations, newest first.
 */
export async function listConversations(
  userId: string,
  limit: number,
  cursor?: string,
): Promise<{
  readonly conversations: ConversationSummary[];
  readonly nextCursor: string | null;
}> {
  const rows = await db.advisorConversation.findMany({
    where: {
      userId,
      // The profile-photo holder is internal scaffolding, not a
      // conversation the customer started.
      NOT: { title: PROFILE_PHOTO_CONVERSATION_TITLE },
    },
    select: SUMMARY_SELECT,
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    conversations: page.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
      messageCount: row._count.messages,
    })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * Loads one conversation with its messages, scoped to its owner.
 *
 * Returns `null` for a conversation that does not exist *or* belongs to
 * somebody else.
 */
export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationDetail | null> {
  const conversation = await db.advisorConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      ...SUMMARY_SELECT,
      messages: {
        select: {
          id: true,
          role: true,
          content: true,
          createdAt: true,
          provider: true,
          model: true,
          isMocked: true,
          meta: true,
        },
        orderBy: { createdAt: "asc" },
      },
      images: {
        select: { id: true, storageKey: true, mimeType: true },
      },
    },
  });

  if (!conversation) {
    return null;
  }

  // The images are attached to the messages that reference them. The
  // schema stores them against the conversation — the cascade needs
  // that — and the *message* records which image is its own attachment
  // in its `meta.imageId`. The meta is the join.
  const imagesById = new Map(
    conversation.images.map((image) => [image.id, image]),
  );

  /**
   * Reads the attached image id out of a message's meta.
   *
   * The meta is free-form JSON, so the value is checked rather than
   * assumed. A row written by an older build, or hand-edited, has no
   * `imageId` — and a malformed one has one of the wrong type. Either
   * way, the message simply has no image.
   */
  function attachedImageId(meta: Prisma.JsonValue | null): string | null {
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      return null;
    }

    const value = (meta as { imageId?: unknown }).imageId;

    return typeof value === "string" && value.length > 0 ? value : null;
  }

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    messageCount: conversation._count.messages,
    messages: conversation.messages.map((message) => {
      const imageId = attachedImageId(message.meta);
      const image = imageId === null ? undefined : imagesById.get(imageId);

      return {
        id: message.id,
        // The schema allows a `SYSTEM` role, but the advisor only ever
        // writes `USER` and `ASSISTANT` rows. Narrowing here keeps the
        // client type honest without pretending the database cannot hold
        // a third value.
        role: message.role === MessageRole.USER ? "USER" : "ASSISTANT",
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        provider: message.provider,
        model: message.model,
        isMocked: message.isMocked,
        meta: message.meta,
        images:
          image === undefined
            ? []
            : [
                {
                  id: image.id,
                  url: getStorageUrl(image.storageKey),
                  mimeType: image.mimeType,
                },
              ],
      };
    }),
  };
}

/**
 * Deletes a conversation and everything under it.
 *
 * The images are purged from storage as well: a database cascade cannot
 * reach the filesystem, so without this the disk fills with orphans.
 */
export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const conversation = await db.advisorConversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      id: true,
      images: { select: { storageKey: true } },
    },
  });

  if (!conversation) {
    return false;
  }

  await db.advisorConversation.delete({ where: { id: conversation.id } });

  // The rows are gone. The files are not — the adapter has to be told.
  const { deleteStoredObject } = await import("@/lib/storage");

  for (const image of conversation.images) {
    try {
      await deleteStoredObject(image.storageKey);
    } catch (error) {
      // A failed purge is a disk-space problem, not a correctness
      // problem: the user asked for the conversation to be gone, and it
      // is gone. Log it so the orphan can be swept later.
      console.error(
        `[advisor] Storage purge failed for "${image.storageKey}":`,
        error,
      );
    }
  }

  return true;
}
