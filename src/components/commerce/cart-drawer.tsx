"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { QuantitySelector } from "@/components/commerce/quantity-selector";
import { useCartDrawer } from "@/components/commerce/cart-drawer-provider";
import { ButtonLink } from "@/components/ui/button";
import { CloseIcon, TrashIcon, WarningIcon } from "@/components/ui/icons";
import { Price } from "@/components/ui/price";
import { ProductImage } from "@/components/ui/product-image";
import { formatPaisa } from "@/lib/format/money";

/**
 * The cart drawer.
 *
 * ── The rules that govern this component ─────────────────────────────────
 *
 * **1. It is a dialog, and it behaves like one.**
 *
 * The drawer is a modal: it traps focus, `Escape` closes it, clicking
 * the backdrop closes it, and the page behind it does not scroll. A
 * slide-in panel that does *not* do these things is a panel that leaves
 * a keyboard user tabbing through the page behind it, and a mouse user
 * scrolling a page they cannot see.
 *
 * **2. The body scroll is locked while it is open.**
 *
 * `overflow: hidden` on the `<body>`. Without it, scrolling the drawer
 * past its end scrolls the page behind it, which looks like a bug.
 * The previous `overflow` value is restored on close — the page may
 * have had a reason to set it.
 *
 * **3. The totals come from the server.**
 *
 * The subtotal is the server's number, rendered as it was received. The
 * client never multiplies a unit price by a quantity to show a line
 * total — the line total is in the server's response, and the server is
 * the one that charges the card.
 *
 * **4. A conflict is highlighted on the lines involved.**
 *
 * A `BLOCK` conflict is not a footnote. The two products involved get
 * a red ring, and the summary explains the interaction. The customer
 * has to be able to see *which* two products are the problem, not just
 * that there is a problem.
 */
export function CartDrawer() {
  const {
    cart,
    isLoading,
    error,
    isOpen,
    close,
    setQuantity,
    removeItem,
  } = useCartDrawer();

  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // ── The escape key ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, close]);

  // ── The body scroll lock ───────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  // ── The focus management ───────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;

    // The close button takes focus when the drawer opens. A modal that
    // opens without moving focus leaves a keyboard user's focus behind
    // the drawer, on a control they can no longer see.
    closeButtonRef.current?.focus();

    // The focus trap. Tabbing past the last focusable element wraps
    // back to the first, so focus cannot escape into the page behind.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );

      if (focusable.length === 0) return;

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
  }, [isOpen]);

  // The product ids involved in a blocking conflict. The lines are
  // highlighted so the customer can see *which* two products clash.
  const blockingProductIds = new Set(
    (cart?.conflicts ?? [])
      .filter((conflict) => conflict.severity === "BLOCK")
      .flatMap((conflict) => conflict.involvedProductIds),
  );

  const blockingConflicts = (cart?.conflicts ?? []).filter(
    (conflict) => conflict.severity === "BLOCK",
  );

  return (
    <>
      {/*
        The backdrop.

        `z-[80]`, above the sticky header's `z-50`. A drawer whose
        scrim sat at the same level as the header would let the header
        show through the dimmed page, and the shopper would be able to
        click the logo behind an open cart.
      */}
      <div
        aria-hidden={!isOpen}
        onClick={close}
        className={[
          "fixed inset-0 z-[80] bg-neutral-900/40 backdrop-blur-[2px]",
          "transition-opacity duration-300 ease-[var(--ease-out-soft)]",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
        ].join(" ")}
      />

      {/* ── The panel ─────────────────────────────────────────────────── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your cart"
        ref={panelRef}
        className={[
          "fixed inset-y-0 right-0 z-[80] flex w-full max-w-md flex-col",
          "bg-surface shadow-2xl",
          "transition-transform duration-300 ease-[var(--ease-out-soft)]",
          isOpen ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {/* ── The header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-serif text-lg font-bold text-foreground">
            Your cart
            {cart && cart.totalQuantity > 0 ? (
              <span className="ml-2 text-sm font-normal text-foreground-muted">
                ({cart.totalQuantity} {cart.totalQuantity === 1 ? "item" : "items"})
              </span>
            ) : null}
          </h2>

          <button
            type="button"
            ref={closeButtonRef}
            onClick={close}
            aria-label="Close the cart"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        {/* ── The error ────────────────────────────────────────────────── */}
        {error ? (
          <div
            role="alert"
            className="mx-5 mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800"
          >
            {error}
          </div>
        ) : null}

        {/* ── The body ─────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {!cart || cart.items.length === 0 ? (
            <EmptyDrawer />
          ) : (
            <>
              {/* The conflicts, at the top. A `BLOCK` conflict is the
                  most important thing on this screen, so it is not
                  buried under the summary. */}
              {blockingConflicts.length > 0 ? (
                <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4">
                  <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-red-700">
                    <WarningIcon width={14} height={14} />
                    Check this combination
                  </p>

                  <ul className="mt-2 space-y-2.5">
                    {blockingConflicts.map((conflict) => (
                      <li key={conflict.ruleId}>
                        <p className="text-xs font-semibold text-red-800">
                          {conflict.title}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-red-700">
                          {conflict.message}
                        </p>
                        <p className="mt-0.5 text-[11px] font-medium text-red-800">
                          {conflict.remedy}
                        </p>
                      </li>
                    ))}
                  </ul>

                  <p className="mt-2.5 text-[11px] leading-relaxed text-red-700">
                    The highlighted products are the ones involved. You can
                    still check out — we are telling you, not stopping you.
                  </p>
                </div>
              ) : null}

              <ul className="divide-y divide-border">
                {cart.items.map((line) => {
                  const isConflicting = blockingProductIds.has(
                    line.productId,
                  );

                  return (
                    <li
                      key={line.id}
                      aria-busy={isLoading}
                      className={[
                        "flex gap-3 py-4",
                        isConflicting ? "rounded-xl" : "",
                      ].join(" ")}
                    >
                      <Link
                        href={`/products/${line.product.id}`}
                        onClick={close}
                        className={[
                          "shrink-0 overflow-hidden rounded-xl bg-surface-muted",
                          isConflicting
                            ? "ring-2 ring-red-300 ring-offset-2"
                            : "",
                        ].join(" ")}
                      >
                        <div className="h-20 w-16 sm:h-24 sm:w-20">
                          <ProductImage
                            images={line.product.images}
                            name={line.product.name}
                            categoryName={line.product.category.name}
                            sizes="80px"
                          />
                        </div>
                      </Link>

                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-medium leading-snug text-foreground">
                          <Link
                            href={`/products/${line.product.id}`}
                            onClick={close}
                            className="line-clamp-2 transition-colors hover:text-brand-700 focus-visible:outline-none focus-visible:text-brand-700"
                          >
                            {line.product.name}
                          </Link>
                        </h3>

                        {isConflicting ? (
                          <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                            <WarningIcon width={10} height={10} />
                            Conflicts with another item
                          </p>
                        ) : null}

                        {line.exceedsStock ? (
                          <p className="mt-1 text-[11px] font-medium text-amber-600">
                            Only {line.product.stockQuantity} left
                          </p>
                        ) : null}

                        <div className="mt-2 flex flex-wrap items-center gap-2.5">
                          <QuantitySelector
                            value={line.quantity}
                            onChange={(quantity) => {
                              void setQuantity(line.id, quantity);
                            }}
                            stockQuantity={line.product.stockQuantity}
                            className="scale-[0.85] origin-left"
                          />

                          <button
                            type="button"
                            onClick={() => {
                              void removeItem(line.id);
                            }}
                            aria-label={`Remove ${line.product.name} from the cart`}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground-muted transition-colors hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                          >
                            <TrashIcon width={13} height={13} />
                            Remove
                          </button>
                        </div>
                      </div>

                      <div className="shrink-0 text-right">
                        <Price
                          pricePaisa={line.unitPricePaisa}
                          discountPricePaisa={
                            line.product.discountPricePaisa !== null &&
                            line.product.discountPricePaisa <
                              line.product.pricePaisa
                              ? line.product.discountPricePaisa
                              : null
                          }
                          size="sm"
                        />

                        <p className="mt-1 text-sm font-semibold text-foreground">
                          {formatPaisa(line.lineTotalPaisa)}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {/* ── The footer ───────────────────────────────────────────────── */}
        {cart && cart.items.length > 0 ? (
          <div className="border-t border-border bg-surface px-5 py-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm font-semibold text-foreground">
                Subtotal
              </span>
              <span className="text-lg font-bold tabular-nums text-foreground">
                {formatPaisa(cart.subtotalPaisa)}
              </span>
            </div>

            <p className="mt-1 text-[11px] text-foreground-muted">
              Delivery is calculated at checkout. Cash on delivery available.
            </p>

            <div className="mt-4 grid gap-2.5">
              <ButtonLink
                href="/checkout"
                variant="primary"
                size="lg"
                fullWidth
                onClick={close}
              >
                Checkout
              </ButtonLink>

              <ButtonLink
                href="/cart"
                variant="outline"
                size="md"
                fullWidth
                onClick={close}
              >
                View full cart
              </ButtonLink>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The empty drawer's contents.
 */
function EmptyDrawer() {
  return (
    <div className="flex h-full flex-col items-center justify-center py-16 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-brand-400"
          aria-hidden="true"
        >
          <circle cx="9" cy="21" r="1" />
          <circle cx="20" cy="21" r="1" />
          <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
        </svg>
      </div>

      <p className="mt-4 text-sm font-semibold text-foreground">
        Your cart is empty
      </p>

      <p className="mx-auto mt-1.5 max-w-xs text-xs text-foreground-muted">
        Nothing here yet. Start with a bestseller, or browse by what your
        skin needs.
      </p>

      <div className="mt-5">
        <ButtonLink href="/products" variant="primary" size="md">
          Start shopping
        </ButtonLink>
      </div>
    </div>
  );
}
