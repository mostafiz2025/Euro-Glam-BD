"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Price } from "@/components/ui/price";
import { CartIcon, CheckIcon } from "@/components/ui/icons";

import type { AdvisorRecommendation } from "@/lib/format/types";

/**
 * A recommended product.
 *
 * ── The reason is code-written ───────────────────────────────────────────
 *
 * The `reason` line is composed in the service layer, not written by the
 * model. It says why *this* product was chosen based on facts the code
 * decided — the ingredient tags, and whether it conflicts with the
 * customer's cart. It is shown verbatim.
 *
 * ── The add-to-cart is the same API the shop uses ────────────────────────
 *
 * The card posts to `/api/cart`, exactly as the product page does, so
 * the cart's conflict rules apply identically. A customer who adds an
 * advisor-recommended product that blocks against their cart sees the
 * same conflict banner they would see on the product page. There is no
 * second, more permissive path.
 */
export type ProductRecommendationCardProps = {
  readonly recommendation: AdvisorRecommendation;
  readonly className?: string;
};

export function ProductRecommendationCard({
  recommendation,
  className,
}: ProductRecommendationCardProps) {
  const [state, setState] = useState<"idle" | "pending" | "added" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function addToCart() {
    if (state === "pending") return;

    setState("pending");
    setError(null);

    try {
      const response = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: recommendation.productId,
          quantity: 1,
        }),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message: string };
      };

      if (!payload.ok) {
        setState("error");
        setError(payload.error?.message ?? "That could not be added.");
        return;
      }

      setState("added");
    } catch {
      setState("error");
      setError("We could not reach the shop. Please try again.");
    }
  }

  const isDiscounted =
    recommendation.discountPricePaisa !== null &&
    recommendation.discountPricePaisa < recommendation.pricePaisa;

  return (
    <article
      className={[
        "flex flex-col rounded-2xl border border-border bg-surface p-4",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="min-w-0 text-sm font-semibold leading-snug text-foreground">
          <Link
            href={`/products/${recommendation.productId}`}
            className="hover:text-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            {recommendation.name}
          </Link>
        </h4>

        {isDiscounted ? (
          <span className="shrink-0 rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-semibold text-white">
            SALE
          </span>
        ) : null}
      </div>

      <div className="mt-2">
        <Price
          pricePaisa={recommendation.pricePaisa}
          discountPricePaisa={recommendation.discountPricePaisa}
          size="sm"
        />
      </div>

      <p className="mt-2 flex-1 text-xs leading-relaxed text-foreground-muted">
        {recommendation.reason}
      </p>

      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-3">
        <Button
          size="sm"
          variant={state === "added" ? "secondary" : "outline"}
          onClick={addToCart}
          disabled={state === "pending" || state === "added"}
          fullWidth
        >
          {state === "pending" ? (
            "Adding…"
          ) : state === "added" ? (
            <>
              <CheckIcon width={16} height={16} />
              Added
            </>
          ) : (
            <>
              <CartIcon width={16} height={16} />
              Add to bag
            </>
          )}
        </Button>
      </div>
    </article>
  );
}
