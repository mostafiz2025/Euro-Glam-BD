"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { DiscoveryImageField } from "@/components/admin/discovery/DiscoveryImageField";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The hero-banner create / edit dialog.
 *
 * ── Why the form carries the copy and not just the artwork ───────────────
 *
 * A hero banner is an **editorial** unit. Its eyebrow, headline, body
 * and two calls to action are the shop's opening line — the words every
 * customer reads first. So the form edits the words, and the words are
 * validated on the server against the same rules the carousel renders
 * them under.
 *
 * ── Why the gradient and the glow are **presets**, not free text ─────────
 *
 * The gradient is a Tailwind class string and the glow is a background
 * colour utility. Both could be typed, and a free-text field for a class
 * string is a way to smuggle arbitrary styling into the storefront.
 *
 * So they are **presets**: a fixed list the admin picks from, each one a
 * complete, designed combination. The list is small and curated because
 * the gradient is not a per-campaign decision — it is the campaign's
 * *mood*, and there are only a handful of moods a skincare shop has.
 *
 * The server validates the value against the same shape regardless, so
 * even a hand-crafted request cannot smuggle a class through.
 */

/**
 * The banner as the form sees it.
 */
export type HeroBannerFormValue = {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly ctaHref: string;
  readonly secondaryCtaLabel: string;
  readonly secondaryCtaHref: string;
  readonly trust: readonly string[];
  readonly image: string | null;
  readonly gradient: string;
  readonly glow: string;
  readonly isActive: boolean;
  readonly sortOrder: number;
};

/**
 * The gradient presets.
 *
 * Each is a **complete** wash — a three-stop gradient that reads as a
 * deliberate colour field rather than as a tint. They are the same
 * washes the static slides use, plus two more for the campaigns the
 * admin panel now makes possible.
 */
const GRADIENT_PRESETS = [
  {
    value: "bg-[linear-gradient(135deg,#fdf2f8_0%,#fce7f3_40%,#fff7fb_80%)]",
    label: "Rose",
  },
  {
    value: "bg-[linear-gradient(135deg,#fff1f5_0%,#ffe4ed_38%,#ffffff_78%)]",
    label: "Blush",
  },
  {
    value: "bg-[linear-gradient(135deg,#eff6ff_0%,#e0e7ff_40%,#ffffff_80%)]",
    label: "Porcelain",
  },
  {
    value: "bg-[linear-gradient(135deg,#f7f5f0_0%,#eceae4_45%,#ffffff_82%)]",
    label: "Sand",
  },
  {
    value: "bg-[linear-gradient(135deg,#f0fdfa_0%,#ccfbf1_40%,#ffffff_80%)]",
    label: "Mint",
  },
  {
    value: "bg-[linear-gradient(135deg,#faf5ff_0%,#ede9fe_40%,#ffffff_80%)]",
    label: "Lilac",
  },
] as const;

/**
 * The glow presets.
 *
 * The accent bloom in the slide's corner. Each one pairs with a
 * gradient of the same mood.
 */
const GLOW_PRESETS = [
  { value: "bg-brand-400/45", label: "Rose" },
  { value: "bg-brand-300/50", label: "Blush" },
  { value: "bg-indigo-300/40", label: "Porcelain" },
  { value: "bg-stone-300/50", label: "Sand" },
  { value: "bg-teal-300/40", label: "Mint" },
  { value: "bg-violet-300/40", label: "Lilac" },
] as const;

/**
 * The maximum number of trust points a banner may carry.
 *
 * Four. The hero shows them in a single row, and a fifth would wrap onto
 * a second line and break the composition.
 */
const MAX_TRUST_POINTS = 4;

export function HeroBannerFormDialog({
  banner,
}: {
  /**
   * The banner being edited. `null` for an add.
   */
  readonly banner?: HeroBannerFormValue | null;
}) {
  const router = useRouter();

  const isEdit = Boolean(banner);

  const [isOpen, setIsOpen] = useState(false);
  const [eyebrow, setEyebrow] = useState(banner?.eyebrow ?? "");
  const [title, setTitle] = useState(banner?.title ?? "");
  const [body, setBody] = useState(banner?.body ?? "");
  const [ctaLabel, setCtaLabel] = useState(banner?.ctaLabel ?? "");
  const [ctaHref, setCtaHref] = useState(banner?.ctaHref ?? "/products");
  const [secondaryCtaLabel, setSecondaryCtaLabel] = useState(
    banner?.secondaryCtaLabel ?? "",
  );
  const [secondaryCtaHref, setSecondaryCtaHref] = useState(
    banner?.secondaryCtaHref ?? "/advisor",
  );
  const [trust, setTrust] = useState((banner?.trust ?? []).join(", "));
  const [image, setImage] = useState<string | null>(banner?.image ?? null);
  const [gradient, setGradient] = useState(
    banner?.gradient ?? GRADIENT_PRESETS[0].value,
  );
  const [glow, setGlow] = useState(banner?.glow ?? GLOW_PRESETS[0].value);
  const [isActive, setIsActive] = useState(banner?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(banner?.sortOrder ?? 0);

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    titleRef.current?.focus();
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

    const trimmedEyebrow = eyebrow.trim();
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    const trimmedCtaLabel = ctaLabel.trim();
    const trimmedCtaHref = ctaHref.trim();
    const trimmedSecondaryLabel = secondaryCtaLabel.trim();
    const trimmedSecondaryHref = secondaryCtaHref.trim();

    if (trimmedEyebrow.length === 0) {
      setError("The banner needs an eyebrow.");
      return;
    }

    if (trimmedTitle.length === 0) {
      setError("The banner needs a headline.");
      return;
    }

    if (trimmedBody.length === 0) {
      setError("The banner needs a supporting line.");
      return;
    }

    if (trimmedCtaLabel.length === 0 || trimmedCtaHref.length === 0) {
      setError("The main button needs a label and a link.");
      return;
    }

    if (trimmedSecondaryLabel.length === 0 || trimmedSecondaryHref.length === 0) {
      setError("The second button needs a label and a link.");
      return;
    }

    if (!isInternalPath(trimmedCtaHref) || !isInternalPath(trimmedSecondaryHref)) {
      setError("Links must be a path within the shop, starting with a slash.");
      return;
    }

    const parsedTrust = trust
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (parsedTrust.length > MAX_TRUST_POINTS) {
      setError(`A banner can carry at most ${MAX_TRUST_POINTS} trust points.`);
      return;
    }

    setIsPending(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = {
        eyebrow: trimmedEyebrow,
        title: trimmedTitle,
        body: trimmedBody,
        ctaLabel: trimmedCtaLabel,
        ctaHref: trimmedCtaHref,
        secondaryCtaLabel: trimmedSecondaryLabel,
        secondaryCtaHref: trimmedSecondaryHref,
        trust: parsedTrust,
        image,
        gradient,
        glow,
        isActive,
        sortOrder,
      };

      const response = await fetch(
        banner ? `/api/admin/hero-banners/${banner.id}` : "/api/admin/hero-banners",
        {
          method: banner ? "PATCH" : "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
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
        {isEdit ? "Edit" : "Add banner"}
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
        aria-label="Close the banner form"
        onClick={() => {
          setIsOpen(false);
          setError(null);
        }}
        className="fixed inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hero-banner-form-title"
        className="relative my-8 w-full max-w-2xl rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="hero-banner-form-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isEdit ? "Edit banner" : "Add banner"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isEdit
            ? "Only the fields you change are saved."
            : "The banner appears in the homepage carousel as soon as you save it."}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Eyebrow
            </span>

            <input
              type="text"
              value={eyebrow}
              onChange={(event) => setEyebrow(event.target.value)}
              maxLength={80}
              required
              placeholder="e.g. La Roche-Posay"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Headline
            </span>

            <input
              ref={titleRef}
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              required
              placeholder="e.g. Derm-science for skin that reacts"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Supporting line
            </span>

            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={400}
              required
              rows={3}
              placeholder="e.g. The French pharmacy range, authorised and stocked locally."
              className="mt-1 w-full rounded-2xl border border-border bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          {/*
            The two calls to action.

            They are side by side because they are a **pair** in the
            hero — the primary button and the secondary one beneath it.
            Splitting them across the form would hide the relationship.
          */}
          <fieldset className="rounded-2xl border border-border p-4">
            <legend className="px-1 text-xs font-medium text-foreground-muted">
              Main button
            </legend>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-foreground-muted">
                  Label
                </span>

                <input
                  type="text"
                  value={ctaLabel}
                  onChange={(event) => setCtaLabel(event.target.value)}
                  maxLength={60}
                  required
                  placeholder="e.g. Shop La Roche-Posay"
                  className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              </label>

              <label className="block">
                <span className="text-xs font-medium text-foreground-muted">
                  Link
                </span>

                <input
                  type="text"
                  value={ctaHref}
                  onChange={(event) => setCtaHref(event.target.value)}
                  maxLength={255}
                  required
                  placeholder="/products?search=La%20Roche-Posay"
                  className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="rounded-2xl border border-border p-4">
            <legend className="px-1 text-xs font-medium text-foreground-muted">
              Second button
            </legend>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-foreground-muted">
                  Label
                </span>

                <input
                  type="text"
                  value={secondaryCtaLabel}
                  onChange={(event) => setSecondaryCtaLabel(event.target.value)}
                  maxLength={60}
                  required
                  placeholder="e.g. Explore sunscreens"
                  className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              </label>

              <label className="block">
                <span className="text-xs font-medium text-foreground-muted">
                  Link
                </span>

                <input
                  type="text"
                  value={secondaryCtaHref}
                  onChange={(event) => setSecondaryCtaHref(event.target.value)}
                  maxLength={255}
                  required
                  placeholder="/products?category=sunscreens"
                  className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              </label>
            </div>
          </fieldset>

          <p className="-mt-2 text-xs text-foreground-muted">
            Links must be a path within the shop, starting with a single
            slash — for example <code>/products?category=serums</code>.
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Trust points
            </span>

            <input
              type="text"
              value={trust}
              onChange={(event) => setTrust(event.target.value)}
              placeholder="e.g. Dermatologist tested, Authenticity guaranteed"
              aria-describedby="hero-trust-hint"
              className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </label>

          <p id="hero-trust-hint" className="text-xs text-foreground-muted">
            Comma-separated, up to {MAX_TRUST_POINTS}. Shown under the
            buttons as the short reasons to trust the banner.
          </p>

          <DiscoveryImageField
            value={image}
            onChange={setImage}
            uploadEndpoint="/api/admin/hero-banners/images"
            label="Background artwork"
            shape="rounded"
            hint="JPEG, PNG or WebP, up to 5 MB. Optional — the banner shows its gradient wash on its own. The copy is laid over the artwork behind a scrim, so it stays readable."
          />

          {/*
            The gradient and the glow.

            **Presets**, not free text. A class string typed by hand is a
            way to smuggle arbitrary styling into the storefront, and the
            gradient is not a per-campaign decision — it is the
            campaign's mood, and there are only a handful of moods.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Gradient
              </span>

              <select
                value={gradient}
                onChange={(event) => setGradient(event.target.value)}
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                {GRADIENT_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Accent glow
              </span>

              <select
                value={glow}
                onChange={(event) => setGlow(event.target.value)}
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              >
                {GLOW_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Order
              </span>

              <input
                type="number"
                value={sortOrder}
                onChange={(event) => setSortOrder(Number(event.target.value))}
                min={0}
                max={10000}
                step={1}
                className="mt-1 h-10 w-full rounded-full border border-border bg-surface px-3.5 text-sm text-foreground focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </label>

            {/*
              The switch.

              A **switch** rather than a checkbox, because the label is
              "Shown on the storefront" and that is a state, not an
              action. A checkbox says "tick this to agree"; a switch says
              "this is on".
            */}
            <div className="flex items-end pb-2">
              <label className="inline-flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(event) => setIsActive(event.target.checked)}
                  className="h-4 w-4 rounded border-border text-brand-600 focus:ring-2 focus:ring-brand-200"
                />

                <span className="text-xs font-medium text-foreground-muted">
                  Shown on the storefront
                </span>
              </label>
            </div>
          </div>

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
                  : "Add banner"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Whether a link is a path **within the shop**.
 *
 * The same rule the server enforces: a path, and nothing else. A
 * protocol-relative URL (`//evil.example`) is rejected alongside an
 * absolute one, because it resolves to another host exactly the same
 * way.
 */
function isInternalPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}
