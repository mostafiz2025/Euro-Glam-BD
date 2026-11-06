"use client";

import Image from "next/image";
import { useRef, useState } from "react";

import { imageUrl } from "@/lib/format/image";
import type { ApiEnvelope } from "@/lib/format/types";
import {
  clearFileInput,
  readSelectedFiles,
} from "@/lib/admin/selected-files";
import { MAX_PRODUCT_IMAGES } from "@/lib/validation/admin";

/**
 * The product image picker.
 *
 * ── What this replaces ──────────────────────────────────────────────────
 *
 * It replaces a textarea in which an admin typed image URLs, one per
 * line. That was a **storage problem dressed as a data-entry problem**:
 *
 *   • The admin had to host the image somewhere and copy the link.
 *   • A typo in a URL produced a broken image with no way to tell
 *     whether the file was missing or the link was wrong.
 *   • The `Product.images` column holds **storage keys**, not URLs, so
 *     every hand-pasted URL was a row the driver could never delete.
 *
 * So the admin picks files, the server stores them, and the column gets
 * keys.
 *
 * ── How the upload is sequenced ──────────────────────────────────────────
 *
 * The files are uploaded **as soon as they are chosen**, not when the
 * form is submitted. Two reasons:
 *
 *   1. A product's JSON body is small and sends in milliseconds; a batch
 *      of five images does not. Uploading on submit would mean one slow
 *      request that could time out halfway through.
 *   2. The admin sees a preview of each file immediately, so a wrong
 *      pick is obvious before anything is written to the catalogue.
 *
 * The uploaded file's **key** is what the form holds and sends. The
 * product row is only written by the separate create / update request,
 * so a half-finished upload leaves an orphaned file (a cleanup job's
 * problem) rather than a product pointing at a file that does not exist.
 *
 * ── Why the existing images are kept until the form is saved ────────────
 *
 * Removing an image from the list does not delete the file. The file
 * might still be referenced by the product until the save lands, and
 * deleting it on the spot would break the live product page if the
 * admin then cancelled the dialog. The removal takes effect on save.
 */
export function ProductImagePicker({
  images,
  onChange,
  maxImages = MAX_PRODUCT_IMAGES,
}: {
  /**
   * The product's current image list — storage keys.
   */
  readonly images: readonly string[];
  /**
   * Called with the new list whenever it changes.
   *
   * Accepts **either** a plain list or a function of the current list —
   * the same shape as a `useState` setter. The functional form matters
   * for the upload, which is asynchronous: appending functionally means
   * the new keys join whatever the list is *now*, rather than the list
   * that was captured when the upload started.
   */
  readonly onChange: (
    update: string[] | ((current: string[]) => string[]),
  ) => void;
  /**
   * The maximum number of images the product may carry.
   */
  readonly maxImages?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The number of files the admin may still add.
   */
  const remaining = Math.max(0, maxImages - images.length);

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;

    /*
     * The files are **snapshotted into an array** before anything else
     * happens.
     *
     * ── Why this is not optional ──────────────────────────────────────────
     *
     * `input.files` is a `FileList`, and the HTML specification says
     * that setting a file input's `value` to the empty string "must
     * empty the list of selected files". So the line
     * `input.value = ""` — which the picker runs so that choosing the
     * *same* file twice fires a change event — **empties the very list
     * the upload is about to read**.
     *
     * The consequence is a silent, total failure:
     *
     *   1. The admin picks three images.
     *   2. The picker clears the input.
     *   3. The `FileList` is now empty, so the loop that appends the
     *      files to the `FormData` appends **nothing**.
     *   4. The multipart body carries no file parts at all.
     *   5. The server finds no files and answers "Choose at least one
     *      image to upload" — for a request the admin had every right
     *      to make.
     *
     * Whether the captured `FileList` reference survives the clear
     * depends on the browser: some return a fresh snapshot from
     * `input.files` on every access, others hand back the same live
     * list and empty it in place. Rather than depend on which browser
     * the admin happens to use, the files are copied out **first**, so
     * the upload sends exactly what was chosen on every browser.
     *
     * The `File` objects themselves are immutable snapshots of the
     * chosen file, so copying the list loses nothing.
     */
    const files = readSelectedFiles(input);

    if (files.length === 0) return;

    // The input is cleared so choosing the *same* file again fires a
    // change event. Without this, an admin who picks a file, sees the
    // error, and picks it again would see nothing happen.
    //
    // This runs **after** the snapshot above, because clearing the
    // input empties its file list.
    clearFileInput(input);

    if (files.length > remaining) {
      setError(
        `This product can carry ${maxImages} images. You can add ${remaining} more.`,
      );
      return;
    }

    setIsUploading(true);
    setError(null);

    try {
      const body = new FormData();

      for (const file of files) {
        body.append("images", file);
      }

      const response = await fetch("/api/admin/products/images", {
        method: "POST",
        headers: { accept: "application/json" },
        body,
      });

      const envelope = (await response.json()) as ApiEnvelope<{
        images: { key: string; url: string; originalName: string }[];
      }>;

      if (!envelope.ok) {
        setError(envelope.error.message);
        setIsUploading(false);
        return;
      }

      const uploaded = envelope.data.images.map((image) => image.key);

      /*
       * The list is **appended to functionally**, not from the `images`
       * captured when this handler was created.
       *
       * The upload is asynchronous, so by the time it resolves the list
       * may have changed underneath it — a second selection may have
       * landed first, or the admin may have removed an image while the
       * request was in flight. Writing `onChange([...images, ...uploaded])`
       * would publish the stale list plus the new keys, silently
       * discarding whatever happened in the meantime.
       *
       * The functional form applies the append to whatever the list is
       * **now**, so nothing is lost.
       */
      onChange((current) => [...current, ...uploaded]);
    } catch {
      setError("We could not reach the server. Nothing was uploaded.");
    } finally {
      setIsUploading(false);
    }
  }

  /**
   * Removes an image from the list.
   *
   * Functional, for the same reason the upload's append is: the list
   * the index refers to may not be the list that is current by the time
   * the click is handled.
   */
  function removeAt(index: number) {
    onChange((current) => current.filter((_, position) => position !== index));
  }

  /**
   * Moves an image within the list.
   *
   * The first image is the one the storefront shows, so being able to
   * reorder is how the admin chooses which one that is.
   */
  function move(index: number, direction: -1 | 1) {
    onChange((current) => {
      const target = index + direction;

      if (target < 0 || target >= current.length) return current;

      const next = [...current];
      const [moved] = next.splice(index, 1);

      next.splice(target, 0, moved);

      return next;
    });
  }

  return (
    <div>
      <span className="text-xs font-medium text-foreground-muted">
        Images
      </span>

      {/*
        The label wraps the input and the button, so the whole tile is a
        click target. The input itself is visually hidden rather than
        `display: none`, because a hidden input is not focusable and the
        admin could not reach it with the keyboard.
      */}
      <label className="mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface px-3.5 py-4 text-sm text-foreground-muted transition-colors hover:bg-surface-muted focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-200">
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={isUploading || remaining === 0}
          onChange={handleFiles}
          aria-describedby="product-images-hint"
          className="sr-only"
        />

        <span>
          {isUploading
            ? "Uploading…"
            : remaining === 0
              ? "Image limit reached"
              : "Choose images"}
        </span>
      </label>

      <p id="product-images-hint" className="mt-1.5 text-xs text-foreground-muted">
        {remaining === 0
          ? `This product already has ${maxImages} images. Remove one to add another.`
          : "JPEG, PNG or WebP, up to 5 MB each. The first image is the one the shop shows."}
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {images.length > 0 ? (
        <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {images.map((key, index) => (
            <li
              key={`${key}-${index}`}
              className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-surface-muted"
            >
              <Image
                src={imageUrl(key)}
                alt=""
                fill
                sizes="120px"
                className="object-cover"
              />

              {index === 0 ? (
                <span className="absolute left-1 top-1 rounded-full bg-neutral-900/80 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  Main
                </span>
              ) : null}

              <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-neutral-900/80 px-1.5 py-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label="Move this image earlier"
                  className="rounded px-1 text-xs text-white disabled:opacity-30"
                >
                  ←
                </button>

                <button
                  type="button"
                  onClick={() => removeAt(index)}
                  aria-label={`Remove image ${index + 1}`}
                  className="rounded px-1 text-xs text-white"
                >
                  Remove
                </button>

                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === images.length - 1}
                  aria-label="Move this image later"
                  className="rounded px-1 text-xs text-white disabled:opacity-30"
                >
                  →
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
