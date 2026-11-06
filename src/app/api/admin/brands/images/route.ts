import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import {
  DISCOVERY_IMAGE_SCOPES,
  uploadDiscoveryImages,
} from "@/lib/admin/discovery-images";
import { readFilesFromForm } from "@/lib/admin/form-data-files";
import { requireAdmin } from "@/lib/auth/guards";

/**
 * POST /api/admin/brands/images
 *
 * Uploads a brand's logo and returns its **storage key**.
 *
 * ── Why the upload is its own endpoint ────────────────────────────────────
 *
 * A brand's name, slug and monogram travel as JSON; a logo is bytes.
 * Bolting a `multipart/form-data` body onto `POST /api/admin/brands` would
 * force every brand create and update through a multipart parser, for a
 * field most of them do not touch.
 *
 * So the flow is two steps:
 *
 *   1. `POST` here, with the file. This returns the storage key.
 *   2. `POST /api/admin/brands` (or `PATCH …/[id]`), with the brand's
 *      JSON body — including that key.
 *
 * The brand row is therefore never written with a file that has not
 * already been validated and stored.
 *
 * ── The trademark note ───────────────────────────────────────────────────
 *
 * Shipping a trademarked logo requires permission. The code cannot verify
 * a licence, so the responsibility sits with the shop: the admin form says
 * so, and a brand with **no** logo still renders — it renders its
 * monogram, which is the fallback, not a removed feature.
 *
 * Admin only.
 */
export async function POST(request: Request): Promise<Response> {
  // Opt out of prerendering — this route reads the session cookie and
  // writes to the filesystem.
  await connection();

  try {
    // The proxy is a fast filter; the guard is the authority.
    await requireAdmin();

    const form = await request.formData();

    /*
     * The files arrive under the name "images". `FormData.getAll()`
     * returns every entry with that name, which is how a multi-file
     * selection arrives — one entry per file.
     *
     * The entries are read with `readFilesFromForm`, which checks each
     * one **structurally** rather than with `instanceof File`. That
     * matters because the files are created by the HTTP layer and the
     * `File` the route sees is the global one: if the two are not the
     * same object, `instanceof` says "not a file" for every file, and
     * the admin is told they chose no images when they chose one.
     */
    const files = readFilesFromForm(form, "images");

    if (files.length === 0) {
      throw ApiError.validation(
        "Choose a logo to upload.",
        {
          fieldErrors: {
            images: ["Attach an image file."],
          },
        },
      );
    }

    const uploaded = await uploadDiscoveryImages(
      files,
      DISCOVERY_IMAGE_SCOPES.brands,
    );

    return ok({
      images: uploaded.map((image) => ({
        key: image.key,
        url: image.url,
        originalName: image.originalName,
        mimeType: image.mimeType,
        byteSize: image.byteSize,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
