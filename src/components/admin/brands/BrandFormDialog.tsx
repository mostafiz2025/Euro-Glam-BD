"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DiscoveryImageField } from "@/components/admin/discovery/DiscoveryImageField";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The brand create / edit dialog.
 *
 * ── Why the monogram is still required ────────────────────────────────────
 *
 * The monogram is the **fallback**. A brand with no uploaded logo still
 * has to render something in the carousel, and the monogram is what it
 * renders. So the monogram is a required field even when a logo is
 * uploaded — an uploaded logo is an enhancement, not a replacement.
 *
 * ── Why the trademark caveat is in the form ───────────────────────────────
 *
 * Shipping a trademarked logo requires permission from the trademark's
 * owner. The shop is responsible for holding that permission; the code
 * cannot verify a licence, so the form states the obligation where the
 * admin is actually making the decision.
 */
export function BrandFormDialog({
  brand,
}: {
  /**
   * The brand being edited. `null` for an add.
   */
  readonly brand?: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly monogram: string;
    readonly logo: string | null;
    readonly description: string | null;
    readonly sortOrder: number;
  } | null;
}) {
  const router = useRouter();

  const isEdit = Boolean(brand);

  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState(brand?.name ?? "");
  const [slug, setSlug] = useState(brand?.slug ?? "");
  const [monogram, setMonogram] = useState(brand?.monogram ?? "");
  const [logo, setLogo] = useState<string | null>(brand?.logo ?? null);
  const [description, setDescription] = useState(brand?.description ?? "");
  const [sortOrder, setSortOrder] = useState(
    brand ? String(brand.sortOrder) : "0",
  );

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
    const trimmedMonogram = monogram.trim().toUpperCase();

    if (trimmedName.length === 0) {
      setError("The brand needs a name.");
      return;
    }

    if (!isSlug(trimmedSlug)) {
      setError(
        "Use lowercase letters, digits and single dashes only for the slug.",
      );
      return;
    }

    if (!isMonogram(trimmedMonogram)) {
      setError("The monogram is one to four letters, with no spaces.");
      return;
    }

    const parsedOrder = parseInt(sortOrder, 10);

    if (!Number.isFinite(parsedOrder) || parsedOrder < 0) {
      setError("The order must be a whole number of zero or more.");
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: trimmedName,
        slug: trimmedSlug,
        monogram: trimmedMonogram,
        logo,
        description: description.trim() || null,
        sortOrder: parsedOrder,
      };

      const response = await fetch(
        brand ? `/api/admin/brands/${brand.id}` : "/api/admin/brands",
        {
          method: brand ? "PATCH" : "POST",
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
        {isEdit ? "Edit" : "Add brand"}
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
        aria-label="Close the brand form"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="fixed inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="brand-form-title"
        className="relative my-8 w-full max-w-xl rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="brand-form-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isEdit ? "Edit brand" : "Add brand"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isEdit
            ? "Only the fields you change are saved."
            : "The brand appears in the shop's \"Shop By Brand\" carousel as soon as you save it."}
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
              placeholder="e.g. CeraVe"
              aria-describedby="brand-name-hint"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p id="brand-name-hint" className="text-xs text-foreground-muted">
            The name the products carry. It is matched to the brand registry
            spelling, so &quot;cerave&quot; is stored as &quot;CeraVe&quot;.
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">Slug</span>

            <input
              type="text"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              maxLength={140}
              required
              placeholder="e.g. cerave"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Monogram
              </span>

              <input
                type="text"
                value={monogram}
                onChange={(event) => setMonogram(event.target.value)}
                maxLength={4}
                required
                placeholder="CV"
                aria-describedby="brand-monogram-hint"
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm uppercase tracking-wide text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Order
              </span>

              <input
                type="number"
                inputMode="numeric"
                step={1}
                min={0}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value)}
                aria-describedby="brand-order-hint"
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm tabular-nums text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </label>
          </div>

          <p id="brand-monogram-hint" className="text-xs text-foreground-muted">
            One to four letters. Shown in the carousel whenever a brand has
            no logo of its own.
          </p>

          <p id="brand-order-hint" className="text-xs text-foreground-muted">
            Lower comes first in the carousel.
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
              placeholder="e.g. Dermatologist-recommended barrier care"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <DiscoveryImageField
            value={logo}
            onChange={setLogo}
            uploadEndpoint="/api/admin/brands/images"
            label="Logo"
            shape="rounded"
            hint="Only upload a logo you have permission to use. Brands without a logo show their monogram instead."
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
                  : "Add brand"}
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

/**
 * Whether a string is a usable monogram.
 *
 * One to four letters, no spaces. The server enforces the same rule and
 * uppercases the result.
 */
function isMonogram(value: string): boolean {
  return /^[A-Za-z]{1,4}$/.test(value);
}
