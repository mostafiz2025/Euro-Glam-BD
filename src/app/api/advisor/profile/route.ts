import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { updateProfileSchema } from "@/lib/validation/advisor";

/**
 * GET /api/advisor/profile
 *
 * The customer's skin profile.
 *
 * A customer with no profile row gets a **default empty profile**, not a
 * 404. The advisor is useful before a profile exists — a new customer
 * should be able to ask a question immediately — and a 404 here would
 * make "you have no profile yet" indistinguishable from "this route is
 * broken".
 */
export async function GET(): Promise<Response> {
  await connection();

  try {
    const user = await requireUser();

    const profile = await db.userSkinProfile.findUnique({
      where: { userId: user.id },
      select: {
        id: true,
        skinType: true,
        concerns: true,
        notes: true,
        estimatedEmptyAt: true,
        smsOptIn: true,
        profileImageId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!profile) {
      return ok({
        profile: {
          id: null,
          skinType: null,
          concerns: [],
          notes: null,
          estimatedEmptyAt: null,
          smsOptIn: false,
          profileImageId: null,
          isEmpty: true,
          createdAt: null,
          updatedAt: null,
        },
      });
    }

    return ok({
      profile: {
        id: profile.id,
        skinType: profile.skinType,
        concerns: profile.concerns,
        notes: profile.notes,
        estimatedEmptyAt: profile.estimatedEmptyAt?.toISOString() ?? null,
        smsOptIn: profile.smsOptIn,
        profileImageId: profile.profileImageId,
        isEmpty: false,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PUT /api/advisor/profile
 *
 * Updates the skin profile. The route upserts: a customer who has never
 * created a profile gets one.
 *
 * ── What this route will not do ───────────────────────────────────────────
 *
 * It does **not** touch `profileImageId`. The photo has its own rules (the
 * image upload pipeline, the one-photo-per-profile constraint) and letting
 * a JSON body point at an arbitrary image id would let a customer attach
 * somebody else's photo.
 *
 * It does **not** remove a concern that is not in the incoming list —
 * actually, it does. `concerns` is a full replacement, not a merge. A
 * customer editing the profile form expects the list they submit to *be*
 * their list, and a merge would make unchecking a box impossible. (The
 * advisor's automatic concern inference is additive — that lives in the
 * chat route, and the two never fight because the chat route only adds.)
 */
export async function PUT(request: Request): Promise<Response> {
  await connection();

  try {
    const user = await requireUser();

    const body: unknown = await request.json();
    const input = updateProfileSchema.parse(body);

    const now = new Date();

    const profile = await db.userSkinProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        ...(input.skinType !== undefined ? { skinType: input.skinType } : {}),
        ...(input.concerns !== undefined ? { concerns: input.concerns } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.estimatedEmptyAt !== undefined
          ? {
              estimatedEmptyAt:
                input.estimatedEmptyAt === null
                  ? null
                  : new Date(input.estimatedEmptyAt),
            }
          : {}),
        ...(input.smsOptIn !== undefined ? { smsOptIn: input.smsOptIn } : {}),
      },
      update: {
        ...(input.skinType !== undefined ? { skinType: input.skinType } : {}),
        ...(input.concerns !== undefined ? { concerns: input.concerns } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.estimatedEmptyAt !== undefined
          ? {
              estimatedEmptyAt:
                input.estimatedEmptyAt === null
                  ? null
                  : new Date(input.estimatedEmptyAt),
            }
          : {}),
        ...(input.smsOptIn !== undefined ? { smsOptIn: input.smsOptIn } : {}),
      },
      select: {
        id: true,
        skinType: true,
        concerns: true,
        notes: true,
        estimatedEmptyAt: true,
        smsOptIn: true,
        profileImageId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // `updatedAt` is `@updatedAt` in the schema, but the upsert returns
    // the value the database holds — which is the moment of the write.
    // `now` is only used as a defensive fallback below.
    void now;

    return ok({
      profile: {
        id: profile.id,
        skinType: profile.skinType,
        concerns: profile.concerns,
        notes: profile.notes,
        estimatedEmptyAt: profile.estimatedEmptyAt?.toISOString() ?? null,
        smsOptIn: profile.smsOptIn,
        profileImageId: profile.profileImageId,
        isEmpty: false,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "SyntaxError"
    ) {
      throw ApiError.validation("The request body must be valid JSON.");
    }

    return handleApiError(error);
  }
}
