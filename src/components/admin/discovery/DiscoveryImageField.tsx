"use client";

import Image from "next/image";
import { useRef, useState } from "react";

import { imageUrl } from "@/lib/format/image";
import type { ApiEnvelope } from "@/lib/format/types";
import {
  clearFileInput,
  readSelectedFiles,
} from "@/lib/admin/selected-files";

/**
 * The single-image field for a discovery entity.
 *
 * ── What this is ─────────────────────────────────────────────────────────
 *
 * The **single-image sibling** of `ProductImagePicker`. A category, a
 * concern and a brand each carry exactly one picture, so this field
 * holds one file, shows one preview, and offers one "Remove".
 *
 * It exists as a **shared component** so the upload behaviour is written
 * once. Three copies of the same fetch-and-preview logic would be three
 * places for it to drift — and the drift would show up as one of the
 * three sections quietly losing its upload.
 *
 * ── Why the file is uploaded as soon as it is chosen ─────────────────────
 *
 * The same reason as the product picker: the entity's JSON body is small
 * and sends in milliseconds, an upload does not. Uploading on submit
 * would mean one slow request that could time out halfway through.
 *
 * The uploaded file's **key** is what the field holds and sends — not
 * the URL. The column stores a storage key so the driver can be swapped
 * for a bucket without rewriting every row.
 *
 * ── Why "Remove" does not delete the file ────────────────────────────────
 *
 * Removing the image clears the field, but the file on disk stays until
 * the form is saved. The entity's row still points at that file until the
 * save lands, and deleting it on the spot would break the live storefront
 * if the admin then cancelled the dialog.
 */
export function DiscoveryImageField({
  value,
  onChange,
  uploadEndpoint,
  label,
  hint,
  shape = "circle",
}: {
  /**
   * The current image — a **storage key**, or `null` for none.
   */
  readonly value: string | null;
  /**
   * Called with the new key (or `null`) whenever it changes.
   */
  readonly onChange: (key: string | null) => void;
  /**
   * The endpoint the file is uploaded to.
   *
   * Each discovery scope has its own endpoint, because each writes under
   * its own storage scope.
   */
  readonly uploadEndpoint: string;
  /**
   * The field's label.
   */
  readonly label: string;
  /**
   * The hint under the field. The brand form uses it for the trademark
   * caveat.
   */
  readonly hint?: string;
  /**
   * The preview's shape.
   *
   * A **circle** for a category card and a concern chip; a **rounded
   * square** for a brand logo, because a logo is a rectangle and
   * cropping it to a circle is how a logo gets mangled.
   */
  readonly shape?: "circle" | "rounded";
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;

    /*
     * The file is read out **before** the input is cleared.
     *
     * Setting a file input's `value` to the empty string must "empty the
     * list of selected files" — so clearing the input empties the very
     * `FileList` the upload is about to read. Whether the captured
     * reference survives depends on the browser, so the file is copied
     * out first and the upload sends exactly what was chosen on every
     * browser.
     *
     * The same fix is applied to the product picker, which has the
     * same shape.
     */
    const file = readSelectedFiles(input)[0];

    if (!file) return;

    // The input is cleared so choosing the *same* file again fires a
    // change event. Without this, an admin who picks a file, sees the
    // error, and picks it again would see nothing happen.
    //
    // This runs **after** the snapshot above, because clearing the
    // input empties its file list.
    clearFileInput(input);

    setIsUploading(true);
    setError(null);

    try {
      const body = new FormData();

      body.append("images", file);

      const response = await fetch(uploadEndpoint, {
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

      const uploaded = envelope.data.images[0];

      if (!uploaded) {
        setError("The image could not be uploaded.");
        setIsUploading(false);
        return;
      }

      onChange(uploaded.key);
    } catch {
      setError("We could not reach the server. Nothing was uploaded.");
    } finally {
      setIsUploading(false);
    }
  }

  const previewShape =
    shape === "circle"
      ? "rounded-full"
      : "rounded-xl";

  return (
    <div>
      <span className="text-xs font-medium text-foreground-muted">{label}</span>

      <div className="mt-1 flex items-center gap-3">
        {/*
          The label wraps the input and the button, so the whole tile is a
          click target. The input itself is visually hidden rather than
          `display: none`, because a hidden input is not focusable and the
          admin could not reach it with the keyboard.
        */}
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface px-3.5 py-3 text-sm text-foreground-muted transition-colors hover:bg-surface-muted focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-200">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={isUploading}
            onChange={handleFile}
            aria-describedby="discovery-image-hint"
            className="sr-only"
          />

          <span>{isUploading ? "Uploading…" : "Choose image"}</span>
        </label>

        {value ? (
          <span
            className={`relative h-14 w-14 shrink-0 overflow-hidden ${previewShape} border border-border bg-surface-muted`}
          >
            <Image
              src={imageUrl(value)}
              alt=""
              fill
              sizes="56px"
              className="object-cover"
            />
          </span>
        ) : null}

        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="inline-flex h-9 items-center rounded-full px-3 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          >
            Remove
          </button>
        ) : null}
      </div>

      <p id="discovery-image-hint" className="mt-1.5 text-xs text-foreground-muted">
        {hint ?? "JPEG, PNG or WebP, up to 5 MB. Optional — the shop falls back to a plain icon without one."}
      </p>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
