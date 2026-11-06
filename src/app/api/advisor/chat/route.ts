import { MessageRole } from "@prisma/client";
import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireUser } from "@/lib/auth/guards";
import { buildMessageMeta, generateAdvisorResponse } from "@/lib/ai/service";
import { db } from "@/lib/db";
import { uploadImage } from "@/lib/storage";
import { UploadValidationError } from "@/lib/upload/validate";
import {
  advisorConversationIdSchema,
  advisorHistorySchema,
  advisorMessageSchema,
  MAX_MESSAGES_PER_HOUR,
  saveAsProfilePhotoSchema,
} from "@/lib/validation/advisor";
import type { AdvisorHistoryTurn } from "@/lib/ai/provider";

/**
 * POST /api/advisor/chat
 *
 * The advisor's primary endpoint. Multipart: a message, an optional
 * image, and an optional conversation id.
 *
 * ── The rules ────────────────────────────────────────────────────────────
 *
 * **1. The message or the image — at least one.**
 *
 * An advisor turn with neither is an empty turn, and an empty turn
 * would still cost a provider call.
 *
 * **2. The conversation belongs to the caller.**
 *
 * A conversation id belonging to somebody else is a `404`, not a `403`.
 * A `403` would confirm the id is real, which leaks the existence of
 * other people's conversations.
 *
 * **3. The rate limit is counted, not assumed.**
 *
 * The advisor is a paid call to a model provider. The count is taken
 * from the database rather than from a process-local counter, so it
 * holds across every instance of the deployment.
 *
 * **4. The provider's output is never trusted.**
 *
 * The response validation lives in the service layer, not here. This
 * route's job is to persist what the service decided and hand it back.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the database.
  await connection();

  try {
    const user = await requireUser();

    const form = await request.formData();

    // ── The message ──────────────────────────────────────────────────────
    const rawMessage = form.get("message");
    const messageText =
      typeof rawMessage === "string" ? rawMessage.trim() : "";

    // ── The image ───────────────────────────────────────────────────────
    const rawImage = form.get("image");
    const hasImage =
      rawImage instanceof File && rawImage.size > 0;

    if (messageText.length === 0 && !hasImage) {
      throw ApiError.validation(
        "Write a message or attach a photo — there is nothing to advise on.",
      );
    }

    const message =
      messageText.length > 0 ? advisorMessageSchema.parse(messageText) : "";

    // ── The conversation id ──────────────────────────────────────────────
    const rawConversationId = form.get("conversationId");
    const conversationId =
      typeof rawConversationId === "string" && rawConversationId.length > 0
        ? advisorConversationIdSchema.parse(rawConversationId)
        : undefined;

    // ── The conversation history ─────────────────────────────────────────
    //
    // The client sends the transcript it is holding, so the advisor has
    // the whole conversation even on a turn the database has not caught
    // up with. It is merged with the stored transcript in the service
    // layer — see `mergeHistory`.
    //
    // A malformed history is **not** a validation error. It is a
    // convenience field: the server can read the transcript from the
    // database by itself, and a client that sends a broken history
    // should still get an answer rather than a 400. So it is parsed
    // defensively, and a failure simply means "no client history".
    const clientHistory = parseClientHistory(form.get("history"));

    // ── The save-as-profile-photo flag ──────────────────────────────────
    const rawSave = form.get("saveAsProfilePhoto");
    const saveAsProfilePhoto = saveAsProfilePhotoSchema.parse(
      rawSave === null ? false : rawSave,
    );

    // ── The rate limit ──────────────────────────────────────────────────
    await assertWithinRateLimit(user.id);

    // ── The conversation ─────────────────────────────────────────────────
    //
    // An existing conversation must belong to the caller. The lookup is
    // scoped by `userId` in the `where` clause, so another person's
    // conversation is indistinguishable from one that does not exist.
    let conversation = null;

    if (conversationId) {
      conversation = await db.advisorConversation.findFirst({
        where: { id: conversationId, userId: user.id },
        select: { id: true },
      });

      if (!conversation) {
        throw ApiError.notFound("That conversation does not exist.");
      }
    }

    // ── The image upload ────────────────────────────────────────────────
    //
    // The upload happens before the provider call so the storage key is
    // available for the message row. The bytes are validated by magic
    // bytes, not by the declared `Content-Type`.
    let storedImage: {
      readonly key: string;
      readonly mimeType: string;
      readonly byteSize: number;
    } | null = null;

    /*
     * The bytes, kept for the provider call.
     *
     * The same buffer that is validated and written to storage is the
     * one sent to the provider. It is held in memory for the length of
     * one request and then dropped — the provider needs the image
     * *inline*, so it cannot be read back from storage afterwards
     * without a second read of the file.
     *
     * The image is only ever sent to a provider that supports vision.
     * The mock provider never needs it, and in mock mode nothing is
     * base64-encoded at all — which is what keeps the offline mode
     * honest: no megabytes are copied around for a canned answer.
     */
    let imageBytes: Buffer | null = null;

    if (hasImage && rawImage instanceof File) {
      try {
        const bytes = Buffer.from(await rawImage.arrayBuffer());

        const uploaded = await uploadImage({
          bytes,
          declaredMime: rawImage.type,
          originalName: rawImage.name,
          scope: "advisor",
        });

        storedImage = {
          key: uploaded.key,
          mimeType: uploaded.mimeType,
          byteSize: uploaded.byteSize,
        };

        imageBytes = bytes;
      } catch (error) {
        if (error instanceof UploadValidationError) {
          // The validator distinguishes *why* a file was rejected. Only
          // the size cap maps to 413; everything else — an unsupported
          // type, a MIME mismatch, a malformed file — is a 415. The
          // validator's own message is passed through because it
          // already explains the problem in plain language.
          const isTooLarge = error.code === "FILE_TOO_LARGE";

          throw new ApiError(
            isTooLarge ? "PAYLOAD_TOO_LARGE" : "UNSUPPORTED_MEDIA_TYPE",
            error.message,
          );
        }

        throw error;
      }
    }

    // ── The provider call ───────────────────────────────────────────────
    //
    // This is the expensive step, and it happens **before** the
    // conversation is written. A provider failure must not leave a
    // conversation with a user message and no answer in it.
    //
    // The conversation id is passed so the service can load the prior
    // turns, and the image bytes are passed so a provider that supports
    // vision can actually look at the photo the customer attached.
    const result = await generateAdvisorResponse({
      userId: user.id,
      userMessage: message,
      ...(conversation ? { conversationId: conversation.id } : {}),
      ...(clientHistory.length > 0 ? { clientHistory } : {}),
      ...(imageBytes && storedImage
        ? {
            image: {
              mimeType: storedImage.mimeType,
              bytes: imageBytes,
            },
          }
        : {}),
    });

    // ── The persistence ─────────────────────────────────────────────────
    const now = new Date();

    const persisted = await db.$transaction(async (tx) => {
      const target = conversation
        ? conversation
        : await tx.advisorConversation.create({
            data: {
              userId: user.id,
              title: message.slice(0, 160) || "Photo analysis",
              lastMessageAt: now,
            },
            select: { id: true },
          });

      let imageId: string | null = null;

      if (storedImage) {
        const created = await tx.advisorImage.create({
          data: {
            conversationId: target.id,
            storageKey: storedImage.key,
            mimeType: storedImage.mimeType,
            byteSize: storedImage.byteSize,
            isProfilePhoto: saveAsProfilePhoto,
          },
          select: { id: true },
        });

        imageId = created.id;
      }

      await tx.advisorMessage.create({
        data: {
          conversationId: target.id,
          role: MessageRole.USER,
          content: message || "(a photo was attached)",
          // The image id is recorded on the *message*, because that is
          // what the attachment belongs to. `AdvisorImage` is attached to
          // the conversation — the cascade needs that — but the
          // conversation may hold several messages and each may have its
          // own photo. The meta is the join.
          ...(imageId ? { meta: { imageId } as never } : {}),
        },
      });

      const assistant = await tx.advisorMessage.create({
        data: {
          conversationId: target.id,
          role: MessageRole.ASSISTANT,
          content: result.content,
          provider: result.provider.name,
          // The **model**, not the provider name. `gemini` and
          // `gemini-2.5-flash` are different facts, and the audit trail
          // needs to say which model actually wrote the advice.
          model: result.provider.model,
          isMocked: result.provider.isMocked,
          meta: buildMessageMeta(result) as never,
        },
      });

      await tx.advisorConversation.update({
        where: { id: target.id },
        data: { lastMessageAt: now },
      });

      return { conversationId: target.id, assistant };
    });

    // ── The skin profile ────────────────────────────────────────────────
    //
    // The profile is updated from the message only when the user has
    // shared something the profile does not already know. The advisor
    // must not overwrite a profile the customer has curated.
    await maybeUpdateProfile(user.id, message, result.skinProfile.concerns);

    return ok({
      conversationId: persisted.conversationId,
      message: {
        id: persisted.assistant.id,
        role: "ASSISTANT" as const,
        content: result.content,
        createdAt: persisted.assistant.createdAt.toISOString(),
      },
      recommendations: result.recommendations,
      conflicts: result.conflicts,
      skinProfile: result.skinProfile,
      disclaimer: result.disclaimer,
      provider: result.provider,
      intent: result.intent,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Parses the conversation history the client sent.
 *
 * ── Why a failure here is not a validation error ─────────────────────────
 *
 * The history is a **convenience**, not a requirement. The server reads
 * the transcript from the database on its own, so a client that sends a
 * broken history still gets a correct answer — just from the stored
 * transcript rather than the client's.
 *
 * Rejecting the turn instead would punish the customer for a bug in a
 * field that was never required. So a malformed history is logged and
 * dropped.
 *
 * @param raw - The `history` form field, if the client sent one.
 */
function parseClientHistory(
  raw: FormDataEntryValue | null,
): AdvisorHistoryTurn[] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }

  let decoded: unknown;

  try {
    decoded = JSON.parse(raw);
  } catch {
    console.warn(
      "[advisor] The client sent a history that is not valid JSON. Ignoring it.",
    );

    return [];
  }

  const parsed = advisorHistorySchema.safeParse(decoded);

  if (!parsed.success) {
    console.warn(
      "[advisor] The client sent a history that did not match the schema. Ignoring it.",
    );

    return [];
  }

  return parsed.data;
}

/**
 * Refuses the request when the user has sent too many messages this
 * hour.
 *
 * The count comes from the database, so it holds across every instance
 * of the deployment. A process-local counter would be reset on every
 * restart and would not be shared between instances — which is exactly
 * when a cap is needed.
 */
async function assertWithinRateLimit(userId: string): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const count = await db.advisorMessage.count({
    where: {
      role: MessageRole.USER,
      conversation: { userId },
      createdAt: { gte: oneHourAgo },
    },
  });

  if (count >= MAX_MESSAGES_PER_HOUR) {
    throw new ApiError(
      "RATE_LIMITED",
      "You have reached the hourly limit for advisor messages. Please try again in a little while.",
    );
  }
}

/**
 * Records the concerns the customer mentioned, without ever overwriting
 * a profile they have curated.
 *
 * The advisor is allowed to *add* a concern the customer raised. It is
 * not allowed to remove one, and it is not allowed to change the skin
 * type — a phrase in a chat message is weaker evidence than a profile
 * field the customer deliberately set.
 */
async function maybeUpdateProfile(
  userId: string,
  message: string,
  concerns: readonly string[],
): Promise<void> {
  if (concerns.length === 0 && message.length === 0) {
    return;
  }

  const existing = await db.userSkinProfile.findUnique({
    where: { userId },
    select: { concerns: true, skinType: true },
  });

  if (!existing) {
    // No profile yet. One is created, so the customer does not have to
    // fill in a form before the advisor knows anything about them.
    await db.userSkinProfile.create({
      data: { userId, concerns: [...concerns] },
    });

    return;
  }

  // The skin type is never inferred. The concerns are only added, never
  // removed — a customer who removes a concern on the profile form
  // means it.
  const merged = [...new Set([...existing.concerns, ...concerns])];

  if (merged.length === existing.concerns.length) {
    return;
  }

  await db.userSkinProfile.update({
    where: { userId },
    data: { concerns: merged },
  });
}
