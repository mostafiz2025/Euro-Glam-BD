import { connection } from "next/server";

import { ApiError, handleApiError } from "@/lib/api/errors";
import { ok } from "@/lib/api/respond";
import { readFilesFromForm } from "@/lib/admin/form-data-files";
import { uploadProductImages } from "@/lib/admin/product-images";
import { requireAdmin } from "@/lib/auth/guards";

/**
 * POST /api/admin/products/images
 *
 * Uploads one or more product images and returns their **storage keys**.
 *
 * ── Why the upload is its own endpoint ────────────────────────────────────
 *
 * The product's facts travel as JSON; an image is bytes. Bolting a
 * `multipart/form-data` body onto `POST /api/admin/products` would force
 * every product create and update through a multipart parser, for a
 * field most of them do not touch.
 *
 * So the flow is two steps:
 *
 *   1. `POST` here, with the files. This returns the storage keys.
 *   2. `POST /api/admin/products` (or `PATCH …/[id]`), with the product's
 *      JSON body — including those keys.
 *
 * The product row is therefore never written with a file that has not
 * already been validated and stored. A half-finished upload leaves an
 * orphaned file for the cleanup job to collect; it never leaves a
 * product pointing at a file that does not exist.
 *
 * ── What comes back ──────────────────────────────────────────────────────
 *
 * The **key**, not the URL. `Product.images` holds storage adapter keys
 * so the driver can be swapped for a bucket without rewriting every row;
 * `imageUrl()` turns a key into a public URL at render time. The `url`
 * is returned too, so the form can show a preview without having to
 * reconstruct the prefix itself.
 *
 * ── Admin only ───────────────────────────────────────────────────────────
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
     * the admin is told they chose no images when they chose several.
     */
    const files = readFilesFromForm(form, "images");

    if (files.length === 0) {
      throw ApiError.validation(
        "Choose at least one image to upload.",
        {
          fieldErrors: {
            images: ["Attach at least one image file."],
          },
        },
      );
    }

    const uploaded = await uploadProductImages(files);

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
