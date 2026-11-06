import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireUser } from "@/lib/auth/guards";
import { PROFILE_PHOTO_CONVERSATION_TITLE } from "@/lib/ai/conversations";
import { db } from "@/lib/db";
import { deleteStoredObject, uploadImage } from "@/lib/storage";
import { UploadValidationError } from "@/lib/upload/validate";

/**
 * POST /api/advisor/profile/photo
 *
 * Sets or clears the customer's profile photo.
 *
 * ── Why this is a separate route ─────────────────────────────────────────
 *
 * The photo has rules the JSON profile body does not: it goes through the
 * upload pipeline, it is stored in storage, and it is attached to a row
 * with a one-to-one constraint. Letting a JSON body carry an image id
 * would let a customer point their profile at somebody else's photo.
 *
 * ── Why the photo needs a conversation ───────────────────────────────────
 *
 * `AdvisorImage.conversationId` is required — an image belongs to a
 * conversation, and the cascade is what deletes the file record when the
 * conversation goes. A profile photo set *before* any conversation exists
 * therefore needs somewhere to live.
 *
 * Rather than weakening the schema (making `conversationId` nullable,
 * which would break the cascade for every other image), this route keeps
 * a dedicated conversation per customer for profile photos. It is marked
 * by its title, is never shown in the customer's conversation list, and
 * is reused for every photo swap — so a customer does not accumulate one
 * hidden conversation per upload.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  try {
    const user = await requireUser();

    const form = await request.formData();

    // A `FormData` entry is a string or a `File` — never a boolean. The
    // flag therefore arrives as text and is compared as text.
    const rawClear = form.get("clear");
    const wantsClear =
      typeof rawClear === "string" &&
      (rawClear === "true" || rawClear === "1");

    // ── The profile row ───────────────────────────────────────────────────
    //
    // The photo is attached to a *profile*, not to a user. A customer who
    // has never created a profile gets one here, so the photo is not
    // silently discarded.
    const profile = await db.userSkinProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
      select: {
        id: true,
        profileImageId: true,
        profileImage: { select: { id: true, storageKey: true } },
      },
    });

    // ── The clear path ───────────────────────────────────────────────────
    if (wantsClear) {
      const attachedImageId = profile.profileImageId;

      if (!attachedImageId) {
        // Nothing to clear. This is not an error — the desired end state
        // already holds. Returning an error would make the client's
        // "remove photo" button fail on a profile that has no photo.
        return ok({ cleared: true, profileImageId: null });
      }

      await db.$transaction(async (tx) => {
        await tx.userSkinProfile.update({
          where: { id: profile.id },
          data: { profileImageId: null },
        });

        await tx.advisorImage.update({
          where: { id: attachedImageId },
          data: { isDeleted: true, isProfilePhoto: false },
        });
      });

      if (profile.profileImage) {
        try {
          await deleteStoredObject(profile.profileImage.storageKey);
        } catch (error) {
          console.error(
            `[advisor] Profile photo purge failed for "${profile.profileImage.storageKey}":`,
            error,
          );
        }
      }

      return ok({ cleared: true, profileImageId: null });
    }

    // ── The upload path ───────────────────────────────────────────────────
    const rawImage = form.get("image");

    if (!(rawImage instanceof File) || rawImage.size === 0) {
      throw ApiError.validation(
        "Attach a photo, or send clear=true to remove the one you have.",
      );
    }

    let storedKey: string;
    let storedMime: string;
    let storedSize: number;

    try {
      const uploaded = await uploadImage({
        bytes: Buffer.from(await rawImage.arrayBuffer()),
        declaredMime: rawImage.type,
        originalName: rawImage.name,
        scope: "advisor",
      });

      storedKey = uploaded.key;
      storedMime = uploaded.mimeType;
      storedSize = uploaded.byteSize;
    } catch (error) {
      if (error instanceof UploadValidationError) {
        throw new ApiError(
          error.code === "FILE_TOO_LARGE"
            ? "PAYLOAD_TOO_LARGE"
            : "UNSUPPORTED_MEDIA_TYPE",
          error.message,
        );
      }

      throw error;
    }

    // ── The profile-photo conversation ────────────────────────────────────
    //
    // One per customer, reused across swaps. It is titled so it is
    // identifiable, and it is hidden from the conversation list by
    // filtering on the title below.
    const holder = await db.advisorConversation.findFirst({
      where: { userId: user.id, title: PROFILE_PHOTO_CONVERSATION_TITLE },
      select: { id: true },
    });

    const conversationId =
      holder?.id ??
      (
        await db.advisorConversation.create({
          data: {
            userId: user.id,
            title: PROFILE_PHOTO_CONVERSATION_TITLE,
          },
          select: { id: true },
        })
      ).id;

    // ── The persistence ───────────────────────────────────────────────────
    const image = await db.advisorImage.create({
      data: {
        conversationId,
        storageKey: storedKey,
        mimeType: storedMime,
        byteSize: storedSize,
        isProfilePhoto: true,
      },
      select: { id: true },
    });

    const previous = profile.profileImage;

    await db.userSkinProfile.update({
      where: { id: profile.id },
      data: { profileImageId: image.id },
    });

    // ── The old file ─────────────────────────────────────────────────────
    //
    // The previous photo's *row* is already detached (the profile now
    // points at the new image). Its file is orphaned on disk until it is
    // purged, which happens now. A failed purge is logged and swallowed:
    // the customer already has their new photo, and an orphaned file is a
    // disk-space problem, not a correctness one.
    if (previous) {
      await db.advisorImage
        .update({
          where: { id: previous.id },
          data: { isDeleted: true, isProfilePhoto: false },
        })
        .catch((error: unknown) => {
          console.error(
            `[advisor] Old profile photo flag update failed for "${previous.id}":`,
            error,
          );
        });

      try {
        await deleteStoredObject(previous.storageKey);
      } catch (error) {
        console.error(
          `[advisor] Profile photo purge failed for "${previous.storageKey}":`,
          error,
        );
      }
    }

    return ok({ cleared: false, profileImageId: image.id });
  } catch (error) {
    return handleApiError(error);
  }
}
