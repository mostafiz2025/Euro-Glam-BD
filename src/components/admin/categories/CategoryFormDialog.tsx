"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DiscoveryImageField } from "@/components/admin/discovery/DiscoveryImageField";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The category create / edit dialog.
 *
 * ── Why the image is a separate upload, not a field on the form ───────────
 *
 * The category's name and slug travel as JSON. Its image does not: it is
 * bytes, and it has to be validated, size-capped, renamed and written to
 * disk before it is a key. So the file is uploaded **as soon as it is
 * chosen**, and the field holds the **key** — which is what the row
 * stores, so the driver can be swapped for a bucket without rewriting
 * every row.
 *
 * The category row is therefore never written pointing at a file that
 * has not already been validated and stored.
 *
 * ── Why the slug is editable on an existing category ─────────────────────
 *
 * A slug is part of a URL — `/products?category=<slug>` — so changing it
 * changes a link that may already have been shared. The form says so
 * plainly rather than hiding the field, because an admin who does not
 * know the slug is editable will assume it is not, and will not think to
 * ask.
 */
export function CategoryFormDialog({
  category,
}: {
  /**
   * The category being edited. `null` for an add.
   */
  readonly category?: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly image: string | null;
  } | null;
}) {
  const router = useRouter();

  const isEdit = Boolean(category);

  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState(category?.name ?? "");
  const [slug, setSlug] = useState(category?.slug ?? "");
  const [image, setImage] = useState<string | null>(category?.image ?? null);

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    nameRef.current?.focus();
  }, [isOpen]);

  // Close on `Escape`.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      setIsOpen(false);
      setError(null);
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending) return;

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();

    if (trimmedName.length === 0) {
      setError("The category needs a name.");
      return;
    }

    if (!isSlug(trimmedSlug)) {
      setError(
        "Use lowercase letters, digits and single dashes only for the slug.",
      );
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: trimmedName,
        slug: trimmedSlug,
        image,
      };

      const response = await fetch(
        category ? `/api/admin/categories/${category.id}` : "/api/admin/categories",
        {
          method: category ? "PATCH" : "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      const envelope = (await response.json()) as ApiEnvelope<unknown>;

      if (!envelope.ok) {
        setError(envelope.error.message);
        setIsPending(false);
        return;
      }

      setIsPending(false);
      setIsOpen(false);

      // The list on the server is now stale. Re-render it.
      router.refresh();
    } catch {
      setError("We could not reach the server. Nothing was changed.");
      setIsPending(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-9 items-center rounded-full bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2"
      >
        {isEdit ? "Edit" : "Add category"}
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close the category form"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="fixed inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-form-title"
        className="relative my-8 w-full max-w-xl rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="category-form-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isEdit ? "Edit category" : "Add category"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isEdit
            ? "Only the fields you change are saved."
            : "The category appears in the shop's \"Shop By Category\" row as soon as you save it."}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">Name</span>

            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              placeholder="e.g. Cleansers"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">Slug</span>

            <input
              type="text"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              maxLength={140}
              required
              placeholder="e.g. cleansers"
              aria-describedby="category-slug-hint"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p id="category-slug-hint" className="text-xs text-foreground-muted">
            {isEdit
              ? "The slug is part of the category's shop link. Changing it changes that link."
              : "Lowercase letters, digits and single dashes. This is the part of the shop link after \"category=\"."}
          </p>

          <DiscoveryImageField
            value={image}
            onChange={setImage}
            uploadEndpoint="/api/admin/categories/images"
            label="Card image"
            shape="circle"
            hint="JPEG, PNG or WebP, up to 5 MB. Optional — a category without one shows its icon instead."
          />

          {error ? (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setError(null);
              }}
              className="inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={isPending}
              className="inline-flex h-9 items-center rounded-full bg-neutral-900 px-4 text-sm font-medium text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
            >
              {isPending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Add category"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Whether a string is a usable slug.
 *
 * The same rule the server enforces — lowercase letters, digits and
 * single dashes — so the form catches a bad slug before the request does.
 */
function isSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
