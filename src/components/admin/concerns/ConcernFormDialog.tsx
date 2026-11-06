"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DiscoveryImageField } from "@/components/admin/discovery/DiscoveryImageField";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The skin-concern create / edit dialog.
 *
 * ── Why the ingredient tag is a free-text field with a hint ──────────────
 *
 * A concern filters on a **canonical ingredient ID** — the same list the
 * conflict engine compares — so a concern filter and a conflict rule
 * always agree about what "BHA" means.
 *
 * The field is free text rather than a dropdown because the ingredient
 * vocabulary is the catalogue's, not the admin panel's, and a dropdown
 * here would be a second copy of a list that already exists somewhere
 * else. The server validates the value; the field just records it.
 */
export function ConcernFormDialog({
  concern,
}: {
  /**
   * The concern being edited. `null` for an add.
   */
  readonly concern?: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly tag: string;
    readonly relatedTags: readonly string[];
    readonly image: string | null;
    readonly description: string | null;
  } | null;
}) {
  const router = useRouter();

  const isEdit = Boolean(concern);

  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState(concern?.name ?? "");
  const [slug, setSlug] = useState(concern?.slug ?? "");
  const [tag, setTag] = useState(concern?.tag ?? "");
  const [relatedTags, setRelatedTags] = useState(
    (concern?.relatedTags ?? []).join(", "),
  );
  const [image, setImage] = useState<string | null>(concern?.image ?? null);
  const [description, setDescription] = useState(concern?.description ?? "");

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
    const trimmedTag = tag.trim();

    if (trimmedName.length === 0) {
      setError("The concern needs a name.");
      return;
    }

    if (!isSlug(trimmedSlug)) {
      setError(
        "Use lowercase letters, digits and single dashes only for the slug.",
      );
      return;
    }

    if (trimmedTag.length === 0) {
      setError("Choose the ingredient this concern filters on.");
      return;
    }

    const parsedRelatedTags = relatedTags
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    setIsPending(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: trimmedName,
        slug: trimmedSlug,
        tag: trimmedTag,
        relatedTags: parsedRelatedTags,
        image,
        description: description.trim() || null,
      };

      const response = await fetch(
        concern ? `/api/admin/concerns/${concern.id}` : "/api/admin/concerns",
        {
          method: concern ? "PATCH" : "POST",
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
        {isEdit ? "Edit" : "Add concern"}
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
        aria-label="Close the concern form"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="fixed inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="concern-form-title"
        className="relative my-8 w-full max-w-xl rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="concern-form-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isEdit ? "Edit concern" : "Add concern"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isEdit
            ? "Only the fields you change are saved."
            : "The concern appears in the shop's \"Shop By Concern\" section as soon as you save it."}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">Name</span>

            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              placeholder="e.g. Acne"
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
              placeholder="e.g. acne"
              aria-describedby="concern-slug-hint"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p id="concern-slug-hint" className="text-xs text-foreground-muted">
            Lowercase letters, digits and single dashes.
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Ingredient tag
            </span>

            <input
              type="text"
              value={tag}
              onChange={(event) => setTag(event.target.value)}
              maxLength={60}
              required
              placeholder="e.g. BHA"
              aria-describedby="concern-tag-hint"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p id="concern-tag-hint" className="text-xs text-foreground-muted">
            The canonical ingredient ID this concern filters on — the same
            list the conflict engine compares. Use the ID, not the display
            name.
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Related tags
            </span>

            <input
              type="text"
              value={relatedTags}
              onChange={(event) => setRelatedTags(event.target.value)}
              placeholder="e.g. SALICYLIC_ACID, BENZOYL_PEROXIDE"
              aria-describedby="concern-related-hint"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p id="concern-related-hint" className="text-xs text-foreground-muted">
            Comma-separated. The other ingredients in this family, offered in
            the filter panel.
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Description
            </span>

            <input
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={200}
              placeholder="e.g. For blemish-prone skin"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <DiscoveryImageField
            value={image}
            onChange={setImage}
            uploadEndpoint="/api/admin/concerns/images"
            label="Card image"
            shape="circle"
            hint="JPEG, PNG or WebP, up to 5 MB. Optional — a concern without one shows as a plain chip."
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
                  : "Add concern"}
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
