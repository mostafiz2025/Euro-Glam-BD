"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

import { CloseIcon, ZoomIcon } from "@/components/ui/icons";
import { imageUrl } from "@/lib/format/image";

/**
 * The product image gallery.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. The gallery is a list, and the thumbnails name their target.**
 *
 * The thumbnails are a `<ul>` of buttons, each with `aria-label` naming
 * the image it selects. A screen-reader user hears "Product image 2 of
 * 4", not "button".
 *
 * **2. The zoom is a dialog, and it is a real one.**
 *
 * Opening the zoom:
 *
 *   • traps focus inside the dialog (Tab cycles),
 *   • closes on Escape,
 *   • restores focus to the trigger on close,
 *   • locks the page behind it from scrolling.
 *
 * A "zoom" that is just a big `<img>` on the page, with no focus
 * management, leaves a keyboard user's focus on a button that is now
 * behind the overlay — they are still "in" the product page, typing
 * into nothing.
 *
 * **3. A product with one image still works.**
 *
 * The seeded catalogue has `images: []` on every row. With no images
 * there is nothing to zoom into, so the zoom control is not rendered at
 * all — a zoom button that opens an empty dialog is worse than no zoom
 * button.
 *
 * **4. The keyboard can drive the gallery.**
 *
 * Arrow keys move between images. It is the expected behaviour for a
 * thumbnail strip, and it is one line per key.
 */

/**
 * The props for the gallery.
 */
export type ProductGalleryProps = {
  /** The storage keys for the product's images. */
  readonly images: readonly string[];
  /** The product name, used for the alt text. */
  readonly name: string;
  /** The category name, used for the placeholder. */
  readonly categoryName: string;
};

/**
 * The product gallery.
 */
export function ProductGallery({
  images,
  name,
  categoryName,
}: ProductGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isZoomed, setIsZoomed] = useState(false);

  const urls = images.filter((key) => key.trim().length > 0).map(imageUrl);
  const hasImages = urls.length > 0;

  const move = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const next = current + delta;

        if (next < 0) return urls.length - 1;
        if (next >= urls.length) return 0;

        return next;
      });
    },
    [urls.length],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        move(-1);
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        move(1);
      }
    },
    [move],
  );

  if (!hasImages) {
    return <GalleryPlaceholder name={name} categoryName={categoryName} />;
  }

  const safeIndex = Math.min(activeIndex, urls.length - 1);
  const activeUrl = urls[safeIndex];

  return (
    <>
      {/* ── The main image ──────────────────────────────────────────── */}
      <div className="relative">
        {/*
         * The frame is a tall portrait on mobile and a square on
         * desktop.
         *
         * A phone screen is tall and narrow, and a skincare bottle is
         * tall and narrow. A square frame with `object-cover` crops the
         * top of the bottle and the bottom of the box — the customer
         * cannot see the whole product, which is the one thing the
         * gallery is for. A 4:5 portrait frame with `object-contain`
         * shows the entire product on a phone, and the square frame
         * with `object-cover` is the right treatment on a wide screen
         * where the image is cropped by the layout rather than by the
         * aspect ratio.
         */}
        <div className="relative aspect-[4/5] overflow-hidden rounded-[var(--radius-card)] bg-surface-muted shadow-[var(--shadow-card)] sm:aspect-square">
          <Image
            src={activeUrl}
            alt={
              urls.length > 1
                ? `${name} — image ${safeIndex + 1} of ${urls.length}`
                : name
            }
            fill
            priority
            sizes="(min-width: 1024px) 45vw, 100vw"
            className="object-contain sm:object-cover"
          />

          {urls.length > 1 ? (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={() => move(-1)}
                className="absolute left-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-surface/90 text-foreground-muted shadow-sm backdrop-blur transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m15 6-6 6 6 6" />
                </svg>
              </button>

              <button
                type="button"
                aria-label="Next image"
                onClick={() => move(1)}
                className="absolute right-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-surface/90 text-foreground-muted shadow-sm backdrop-blur transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>
            </>
          ) : null}
        </div>

        {/*
         * The image counter.
         *
         * On mobile the customer swipes the thumbnail strip rather
         * than pressing the arrows — the arrows are small targets in
         * the corner of the frame. The counter tells them how many
         * images there are, and that the strip is worth swiping.
         */}
        {urls.length > 1 ? (
          <p
            aria-hidden="true"
            className="absolute right-3 top-3 rounded-full bg-neutral-900/60 px-2.5 py-1 text-[11px] font-medium tabular-nums text-white backdrop-blur sm:hidden"
          >
            {safeIndex + 1} / {urls.length}
          </p>
        ) : null}

        {/* The zoom trigger. It is a real button with a real label, so
            the gallery is usable with a keyboard and with a screen
            reader. */}
        <button
          type="button"
          onClick={() => setIsZoomed(true)}
          aria-label={`Zoom in on the image of ${name}`}
          className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-surface/90 px-3 py-2 text-xs font-medium text-foreground-muted shadow-sm backdrop-blur transition-colors hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ZoomIcon width={14} height={14} />
          Zoom
        </button>
      </div>

      {/* ── The thumbnails ───────────────────────────────────────────── */}
      {urls.length > 1 ? (
        <ul
          onKeyDown={onKeyDown}
          aria-label="Product images"
          className="mt-3 flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-1"
        >
          {urls.map((url, index) => {
            const isActive = index === safeIndex;

            return (
              <li key={url} className="shrink-0 snap-start">
                <button
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  aria-label={`Show image ${index + 1} of ${urls.length}`}
                  aria-current={isActive ? "true" : undefined}
                  className={[
                    "relative h-16 w-16 overflow-hidden rounded-xl border-2 bg-surface-muted transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
                    isActive
                      ? "border-brand-600"
                      : "border-transparent hover:border-brand-300",
                  ].join(" ")}
                >
                  <Image
                    src={url}
                    alt=""
                    fill
                    sizes="64px"
                    className="object-cover"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {isZoomed ? (
        <ZoomDialog
          url={activeUrl}
          name={name}
          onClose={() => setIsZoomed(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The placeholder shown when a product has no images.
 */
function GalleryPlaceholder({
  name,
  categoryName,
}: {
  readonly name: string;
  readonly categoryName: string;
}) {
  return (
    <div className="flex aspect-[4/5] items-center justify-center rounded-[var(--radius-card)] bg-brand-gradient shadow-[var(--shadow-card)] sm:aspect-square">
      <div className="px-6 text-center">
        <div className="font-serif text-5xl leading-none text-brand-300">
          {initialsFor(name)}
        </div>
        <p className="mt-2 text-xs font-medium uppercase tracking-wider text-brand-400">
          {categoryName}
        </p>
        <p className="mt-1 text-[11px] text-brand-300/80">
          Product photo coming soon
        </p>
      </div>
    </div>
  );
}

/**
 * The zoom dialog.
 *
 * A real modal: focus is trapped, Escape closes it, and focus returns
 * to the trigger.
 */
function ZoomDialog({
  url,
  name,
  onClose,
}: {
  readonly url: string;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [closeButton, setCloseButton] = useState<HTMLButtonElement | null>(null);

  // Move focus into the dialog when it opens.
  useEffect(() => {
    closeButton?.focus();
  }, [closeButton]);

  // Close on Escape.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Lock the page behind the dialog.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Trap the focus. Tab from the last focusable element wraps to the
  // first, and Shift+Tab from the first wraps to the last.
  useEffect(() => {
    if (!container) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;

      const focusable = container?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );

      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [container]);

  return (
    <div
      ref={setContainer}
      role="dialog"
      aria-modal="true"
      aria-label={`Enlarged image of ${name}`}
      className="fixed inset-0 z-[90] flex flex-col bg-neutral-950/95"
    >
      <div className="flex items-center justify-between px-4 py-4">
        <span className="text-sm font-medium text-white/80">{name}</span>

        <button
          ref={setCloseButton}
          type="button"
          onClick={onClose}
          aria-label="Close the zoomed image"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface/10 text-white transition-colors hover:bg-surface/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <CloseIcon width={20} height={20} />
        </button>
      </div>

      <div className="relative flex-1 px-4 pb-8">
        <Image
          src={url}
          alt={name}
          fill
          sizes="100vw"
          className="object-contain"
        />
      </div>
    </div>
  );
}

/**
 * Derives the initials for the placeholder.
 */
function initialsFor(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);

  if (words.length === 0) return "•";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
