"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ProductBadgeEditor } from "@/components/admin/products/ProductBadgeEditor";
import { ProductConcernPicker } from "@/components/admin/products/ProductConcernPicker";
import { ProductImagePicker } from "@/components/admin/products/ProductImagePicker";
import { BrandPicker } from "@/components/ui/brand-picker";
import {
  readErrorMessage,
  readFieldErrors,
  type FieldErrors,
} from "@/lib/format/field-errors";
import { formatPaisa } from "@/lib/format/money";
import type { ApiEnvelope } from "@/lib/format/types";

/**
 * The product add / edit dialog.
 *
 * ── What the form may and may not send ───────────────────────────────────
 *
 * The form sends the **catalogue facts**: what the product is called,
 * what it costs, which category it belongs to, what is in it, and what
 * it looks like.
 *
 * It does **not** send an absolute stock quantity on edit. Stock is a
 * *derived* value — a checkout deducts a unit at the moment a customer
 * orders — so an Edit form that wrote an absolute quantity would
 * destroy a concurrent checkout's reservation without any trace. The
 * two operations look identical in the database.
 *
 * So a stock change on the Edit form is a **signed `stockDelta`**, and
 * the server applies it with its own `PRODUCT_STOCK_ADJUSTED` audit
 * entry. The form refuses to send a stock change at all when the
 * quantity is unchanged — "change the stock by zero" is not a change.
 *
 * ── A price change requires a reason ─────────────────────────────────────
 *
 * The price is a commercial decision. An audit entry that says
 * "price 95000 → 120000" with no reason cannot answer "why", and the
 * answer is the whole point of the trail. The server refuses the
 * change without one; this form asks for one up front, so the admin is
 * never surprised by a 400.
 *
 * ── The cost side of the ledger ───────────────────────────────────────────
 *
 * The form also carries the **purchase price** — what the shop paid —
 * and the **selling price** — what it charges. These are what make
 * the profit figures possible: the margin on a sale is the selling
 * price minus the purchase price minus any discount given away.
 *
 * Both fields are **optional**, and blank means "not known" rather than
 * "free". A product whose cost has never been recorded is *excluded*
 * from the profit figures — so a blank field is a truthful gap, and a
 * zero would report a 100% margin on goods the shop paid real money
 * for.
 *
 * A cost above the selling price is refused here, on the field it is
 * about. It is not a margin; it is a loss on every sale, and it is far
 * more likely to be the admin typing into the wrong box than a
 * deliberate decision.
 *
 * ── The images are uploaded, not typed ───────────────────────────────────
 *
 * The image list is a list of **storage keys**, not URLs. The picker
 * uploads each chosen file to its own endpoint and holds the returned
 * key; this form sends those keys in the JSON body, and the product's
 * audit entry records the change like any other field.
 *
 * So an image is never referenced before it has been validated, stored
 * and named. A failed upload leaves an orphaned file for the cleanup
 * job — never a product pointing at a file that does not exist.
 *
 * ── The badges are a list, not two checkboxes ─────────────────────────────
 *
 * The form sends a **badge list** — the known badges the admin ticked,
 * plus any custom tags they typed. The list is the source of truth; the
 * `isNewArrival` and `isBestSeller` columns are a mirror of two entries
 * in it, maintained by the catalogue service. So the admin edits one
 * thing, and the storefront's "New" and "Best Seller" labels follow
 * without the storefront having to learn about badge lists.
 *
 * The list is only sent when it actually changed. A save that meant to
 * change the price must not also re-send the badges it did not touch —
 * that is how one admin's badge gets reverted by another's price edit.
 *
 * ── The skin concerns are a **picker**, not a text field ───────────────────
 *
 * "Shop by Concern" decides which browse pages a product appears on, so
 * the choices come from the `SkinConcern` table — the shop's own
 * vocabulary — rather than from a free-text box. An admin adds "Redness"
 * in the Concerns panel and it is available here immediately, and a
 * mistyped slug cannot create a concern that exists on no page.
 *
 * The selection is sent only when it changed, for the same reason the
 * badge list is: "send the concerns I did not touch" is how a
 * concurrent admin's careful tagging gets reverted by a save that only
 * meant to change the price.
 *
 * ── The brand is a stored field, and it is optional ───────────────────────
 *
 * The brand used to be *derived* from the product's name — a registry of
 * nine known prefixes, matched longest-first against the front of the
 * name. That was a good fallback, but it was not a field: an admin could
 * not correct a wrong brand, could not filter the catalogue by one, and
 * could not enter a brand the registry had never heard of.
 *
 * So the brand is now a real column on `Product`, and the derivation
 * survives only as the fallback for rows written before the column
 * existed. The picker offers the known brands and lets the admin type a
 * new one; the server canonicalises it, so "cerave" is stored as
 * "CeraVe" and the shop cannot end up with three spellings of the same
 * brand on the storefront.
 *
 * A `null` brand is a legitimate value — a product genuinely may have no
 * brand — so the field is never required, and "Clear the brand" in the
 * picker is a real edit rather than a way of emptying a required field.
 *
 * ── The server's answer is shown on the field it is about ────────────────
 *
 * When the server refuses the save, it says **which** field was wrong
 * and why — the envelope's `details.fieldErrors` maps a field path to
 * its messages. Those messages are rendered **under the field they are
 * about**, so the admin is told what to fix without having to work out
 * which of a dozen fields the server meant.
 *
 * This form used to render only the envelope's `message` — which is
 * deliberately generic, because the server cannot know what the admin
 * was looking at. The result was the worst kind of error: "The request
 * failed validation", on a form that looked complete, with nothing
 * pointing at the field that was actually wrong.
 *
 * The generic message is still shown when **no** field is to blame — a
 * conflict, a network failure, a server fault — because those failures
 * genuinely are about the submission as a whole.
 */
export function ProductFormDialog({
  categories,
  concerns,
  product,
}: {
  /**
   * The categories the product may belong to.
   */
  readonly categories: readonly { id: string; name: string }[];
  /**
   * The skin concerns the product may be tagged with — "Shop by Concern".
   *
   * Read from the `SkinConcern` table, so the vocabulary is the shop's
   * own and an admin can add a concern without a code change.
   */
  readonly concerns: readonly {
    readonly slug: string;
    readonly name: string;
    readonly description?: string | null;
  }[];
  /**
   * The product being edited. `null` for an add.
   */
  readonly product?: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /**
     * The product's stored brand, or `null` when it has none.
     */
    readonly brand: string | null;
    readonly categoryId: string;
    readonly pricePaisa: number;
    readonly discountPricePaisa: number | null;
    /**
     * What the shop paid for one unit, in poisha.
     *
     * `null` means "not known" — the cost has never been recorded. It is
     * **not** zero, and a margin computed against a missing cost is
     * excluded from the profit figures rather than counted as if the
     * goods were free.
     */
    readonly purchasePricePaisa: number | null;
    /**
     * What the customer is charged for one unit, in poisha.
     *
     * `null` means "not known".
     */
    readonly sellingPricePaisa: number | null;
    readonly stockQuantity: number;
    readonly ingredientTags: string[];
    /**
     * The skin concerns the product is tagged with.
     */
    readonly concernSlugs: string[];
    readonly climateTips: string | null;
    readonly images: string[];
    readonly badges: string[];
    readonly isNewArrival: boolean;
    readonly isBestSeller: boolean;
    readonly archivedAt: Date | null;
  } | null;
}) {
  const router = useRouter();

  const isEdit = Boolean(product);

  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [brand, setBrand] = useState<string | null>(product?.brand ?? null);
  const [categoryId, setCategoryId] = useState(
    product?.categoryId ?? categories[0]?.id ?? "",
  );
  const [price, setPrice] = useState(
    product ? String(product.pricePaisa / 100) : "",
  );
  const [discountPrice, setDiscountPrice] = useState(
    product?.discountPricePaisa != null
      ? String(product.discountPricePaisa / 100)
      : "",
  );
  const [stockDelta, setStockDelta] = useState("");
  /**
   * The cost side of the ledger.
   *
   * Both fields are **optional and blank-able**, and blank means "not
   * known" rather than "zero". A blank cost is the honest state of a
   * product the shop has not priced yet, and the profit figures exclude
   * such a sale rather than pretending the goods were free.
   */
  const [purchasePrice, setPurchasePrice] = useState(
    product?.purchasePricePaisa != null
      ? String(product.purchasePricePaisa / 100)
      : "",
  );
  const [sellingPrice, setSellingPrice] = useState(
    product?.sellingPricePaisa != null
      ? String(product.sellingPricePaisa / 100)
      : "",
  );
  const [ingredientTags, setIngredientTags] = useState(
    product?.ingredientTags.join(", ") ?? "",
  );
  /**
   * The skin concerns the product is tagged with.
   *
   * A **list of slugs**, not a free-text field. The vocabulary is the
   * `SkinConcern` table, so the admin picks from what the shop actually
   * has — and a typo cannot create a concern that exists on no page.
   */
  const [concernSlugs, setConcernSlugs] = useState<string[]>(
    product?.concernSlugs ?? [],
  );
  const [climateTips, setClimateTips] = useState(product?.climateTips ?? "");
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [badges, setBadges] = useState<string[]>(product?.badges ?? []);
  const [reason, setReason] = useState("");

  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The server's per-field messages.
   *
   * A field path to one message — "name", "pricePaisa",
   * "discountPricePaisa", "climateTips", "images", "badges". These are
   * rendered under the field they are about, and they are the reason
   * the form does not show a bare "the request failed validation".
   */
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    nameRef.current?.focus();
  }, [isOpen]);

  /**
   * The dialog's close handler.
   *
   * One function, because there are three ways to close — the backdrop,
   * the Cancel button and `Escape` — and all three have to clear the
   * same state. A stale field error left behind would greet the admin
   * who reopens the dialog with a complaint about a field they had
   * already fixed.
   */
  function closeDialog(): void {
    setIsOpen(false);
    setError(null);
    setFieldErrors({});
  }

  // Close on `Escape`.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;

      closeDialog();
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  /**
   * The prices, in poisha.
   *
   * The form works in **taka** — the number a human reads — and the API
   * works in poisha. The conversion happens here, at the edge, so the
   * integer money type never has to survive a round-trip through a
   * `parseFloat`.
   */
  const pricePaisa = toPaisa(price);
  const discountPricePaisa = toPaisa(discountPrice);
  const purchasePricePaisa = toPaisa(purchasePrice);
  const sellingPricePaisa = toPaisa(sellingPrice);

  /**
   * The stock change, as a signed delta.
   */
  const parsedDelta = stockDelta.trim() === "" ? 0 : Number.parseInt(stockDelta, 10);

  const projectedStock =
    product && Number.isFinite(parsedDelta)
      ? product.stockQuantity + parsedDelta
      : null;

  /**
   * Whether this edit changes the price.
   *
   * Sending the price the product already has is not a change, so it
   * does not demand a reason — otherwise editing only the description
   * of a discounted product would force the admin to justify a price
   * they never touched.
   */
  const priceChanged = (() => {
    if (!product) return false;

    if (pricePaisa !== null && pricePaisa !== product.pricePaisa) return true;

    if (
      discountPricePaisa !== null &&
      discountPricePaisa !== product.discountPricePaisa
    ) {
      return true;
    }

    return false;
  })();

  const reasonRequired = !isEdit || priceChanged;

  /**
   * Renders a failed save.
   *
   * ── Why the two outcomes are different ──────────────────────────────────
   *
   * A **validation** failure names its fields. The server's
   * `details.fieldErrors` says which field was wrong and why, and each
   * of those messages goes under the field it is about.
   *
   * A **conflict, a network failure or a server fault** names no field.
   * Those are about the submission as a whole, so they get the one
   * banner at the bottom — the same place a reader's eye already goes
   * for "the save did not work".
   *
   * The old behaviour rendered the envelope's `message` in both cases,
   * which is why a form the admin had filled in correctly could fail
   * with "The request failed validation" and nothing else.
   */
  function applyFailure(error: unknown): void {
    const fields = readFieldErrors(error);

    setFieldErrors(fields);

    if (Object.keys(fields).length > 0) {
      setError(null);
      return;
    }

    setError(readErrorMessage(error));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isPending) return;

    /**
     * The client-side checks.
     *
     * Each of these is a field-level rule, so each of them sets the
     * message **on the field it is about** rather than in one banner at
     * the bottom of the form. A banner tells the admin the form is
     * wrong; a message under the field tells them what to do about it.
     */
    const clientErrors: FieldErrors = {};

    if (name.trim().length === 0) {
      clientErrors.name = "The product needs a name.";
    }

    if (categoryId.length === 0) {
      clientErrors.categoryId = "Choose a category.";
    }

    if (pricePaisa === null) {
      clientErrors.pricePaisa = "Enter a price in taka.";
    }

    if (discountPricePaisa !== null && pricePaisa !== null && discountPricePaisa > pricePaisa) {
      clientErrors.discountPricePaisa =
        "The discount price cannot be higher than the price.";
    }

    /**
     * The cost cannot exceed the price.
     *
     * A cost above the selling price is not a margin — it is a loss on
     * every sale, and the shop almost certainly means to type the price
     * in the wrong box. Refusing it here, on the field it is about, is
     * friendlier than saving it and discovering the loss on the
     * dashboard.
     */
    if (
      purchasePricePaisa !== null &&
      pricePaisa !== null &&
      purchasePricePaisa > pricePaisa
    ) {
      clientErrors.purchasePricePaisa =
        "The cost cannot be higher than the price the customer pays.";
    }

    if (
      sellingPricePaisa !== null &&
      pricePaisa !== null &&
      sellingPricePaisa > pricePaisa
    ) {
      clientErrors.sellingPricePaisa =
        "The selling price cannot be higher than the regular price.";
    }

    if (projectedStock !== null && projectedStock < 0) {
      clientErrors.stockQuantity = `That stock change would leave ${projectedStock} units on the shelf. The stock cannot go below zero.`;
    }

    if (reasonRequired && reason.trim().length === 0) {
      clientErrors.reason = isEdit
        ? "Give a reason for the price change — it is recorded in the audit log."
        : "Give a reason for adding this product — it is recorded in the audit log.";
    }

    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      setError(null);
      return;
    }

    setIsPending(true);
    setError(null);
    setFieldErrors({});

    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        brand,
        categoryId,
        pricePaisa,
        ingredientTags: splitList(ingredientTags),
        concernSlugs,
        climateTips: climateTips.trim() || null,
        images,
        badges,
      };

      if (discountPricePaisa !== null) {
        body.discountPricePaisa = discountPricePaisa;
      }

      /**
       * The cost side of the ledger.
       *
       * A blank field is sent as `null` — "not known" — which is a
       * deliberate edit on an existing product, not an absent field. On
       * a **new** product it is also sent as `null`, because the column
       * is nullable and the default of zero would report a 100% margin
       * on a product the shop paid real money for.
       */
      body.purchasePricePaisa = purchasePricePaisa;
      body.sellingPricePaisa = sellingPricePaisa;

      if (product) {
        // Only send the fields that actually changed. A partial update
        // changes only what it names — a save that changes the name
        // does not silently reset the price.
        const changed: string[] = [];

        if (name.trim() !== product.name) changed.push("name");
        if (description.trim() !== product.description) changed.push("description");
        if (brand !== product.brand) changed.push("brand");
        if (categoryId !== product.categoryId) changed.push("categoryId");
        if (pricePaisa !== product.pricePaisa) changed.push("pricePaisa");
        if (discountPricePaisa !== product.discountPricePaisa) {
          changed.push("discountPricePaisa");
        }
        if (splitList(ingredientTags).join("|") !== product.ingredientTags.join("|")) {
          changed.push("ingredientTags");
        }
        if (concernSlugs.join("|") !== product.concernSlugs.join("|")) {
          changed.push("concernSlugs");
        }
        if ((climateTips.trim() || null) !== product.climateTips) {
          changed.push("climateTips");
        }
        if (images.join("|") !== product.images.join("|")) {
          changed.push("images");
        }
        if (badges.join("|") !== product.badges.join("|")) {
          changed.push("badges");
        }
        if (parsedDelta !== 0) changed.push("stockDelta");
        if (purchasePricePaisa !== product.purchasePricePaisa) {
          changed.push("purchasePricePaisa");
        }
        if (sellingPricePaisa !== product.sellingPricePaisa) {
          changed.push("sellingPricePaisa");
        }

        if (changed.length === 0) {
          setError("Nothing has changed.");
          setIsPending(false);
          return;
        }

        const payload: Record<string, unknown> = {};

        if (changed.includes("name")) payload.name = body.name;
        if (changed.includes("description")) payload.description = body.description;
        if (changed.includes("brand")) payload.brand = body.brand;
        if (changed.includes("categoryId")) payload.categoryId = body.categoryId;
        if (changed.includes("pricePaisa")) payload.pricePaisa = body.pricePaisa;
        if (changed.includes("discountPricePaisa")) {
          payload.discountPricePaisa = body.discountPricePaisa;
        }
        if (changed.includes("ingredientTags")) {
          payload.ingredientTags = body.ingredientTags;
        }
        if (changed.includes("concernSlugs")) {
          payload.concernSlugs = body.concernSlugs;
        }
        if (changed.includes("climateTips")) payload.climateTips = body.climateTips;
        if (changed.includes("images")) payload.images = body.images;
        if (changed.includes("badges")) payload.badges = body.badges;
        if (changed.includes("stockDelta")) payload.stockDelta = parsedDelta;
        if (changed.includes("purchasePricePaisa")) {
          payload.purchasePricePaisa = body.purchasePricePaisa;
        }
        if (changed.includes("sellingPricePaisa")) {
          payload.sellingPricePaisa = body.sellingPricePaisa;
        }

        if (reason.trim().length > 0) payload.reason = reason.trim();

        const response = await fetch(`/api/admin/products/${product.id}`, {
          method: "PATCH",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        const envelope = (await response.json()) as ApiEnvelope<unknown>;

        if (!envelope.ok) {
          applyFailure(envelope.error);
          setIsPending(false);
          return;
        }
      } else {
        // The opening stock is an **absolute** on creation — there is
        // nothing to derive it from.
        body.stockQuantity = Number.parseInt(stockDelta, 10) || 0;

        if (reason.trim().length > 0) body.reason = reason.trim();

        const response = await fetch("/api/admin/products", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const envelope = (await response.json()) as ApiEnvelope<unknown>;

        if (!envelope.ok) {
          applyFailure(envelope.error);
          setIsPending(false);
          return;
        }
      }

      setIsPending(false);
      setIsOpen(false);
      setReason("");

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
        {isEdit ? "Edit" : "Add product"}
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
        aria-label="Close the product form"
        onClick={closeDialog}
        className="fixed inset-0 cursor-default bg-neutral-900/40 backdrop-blur-[2px]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-form-title"
        className="relative my-8 w-full max-w-2xl rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-xl"
      >
        <h2
          id="product-form-title"
          className="font-serif text-lg font-bold text-foreground"
        >
          {isEdit ? "Edit product" : "Add product"}
        </h2>

        <p className="mt-1 text-sm text-foreground-muted">
          {isEdit
            ? "Only the fields you change are saved. A price change needs a reason."
            : "The product goes live as soon as you save it."}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">Name</span>

            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={160}
              required
              aria-invalid={fieldErrors.name ? true : undefined}
              aria-describedby={
                fieldErrors.name ? "product-name-error" : undefined
              }
              className={[
                "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted",
                "focus:outline-none focus:ring-2",
                fieldErrors.name
                  ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                  : "border-border focus:border-brand-300 focus:ring-brand-200",
              ].join(" ")}
            />

            <FieldError id="product-name-error" message={fieldErrors.name} />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Description
            </span>

            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={2000}
              aria-invalid={fieldErrors.description ? true : undefined}
              aria-describedby={
                fieldErrors.description ? "product-description-error" : undefined
              }
              className={[
                "mt-1 w-full rounded-2xl border bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-foreground-muted",
                "focus:outline-none focus:ring-2",
                fieldErrors.description
                  ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                  : "border-border focus:border-brand-300 focus:ring-brand-200",
              ].join(" ")}
            />

            <FieldError
              id="product-description-error"
              message={fieldErrors.description}
            />
          </label>

          <div className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Brand
            </span>

            <BrandPicker
              value={brand}
              onChange={setBrand}
              describedBy="brand-hint"
            />

            <p id="brand-hint" className="text-xs text-foreground-muted">
              Pick a brand or type a new one. Leave it blank if the product
              has no brand.
            </p>

            <FieldError id="product-brand-error" message={fieldErrors.brand} />
          </div>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Category
            </span>

            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              required
              aria-invalid={fieldErrors.categoryId ? true : undefined}
              aria-describedby={
                fieldErrors.categoryId ? "product-category-error" : undefined
              }
              className={[
                "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm text-foreground",
                "focus:outline-none focus:ring-2",
                fieldErrors.categoryId
                  ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                  : "border-border focus:border-brand-300 focus:ring-brand-200",
              ].join(" ")}
            >
              {categories.length === 0 ? (
                <option value="">No categories yet</option>
              ) : null}

              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>

          {/*
            The two prices.

            **"Regular price" is what the product normally costs.**
            **"Discount price" is what the customer pays today**, and it
            is struck through next to the regular price wherever the
            product is shown.

            The labels say which is which because a form that calls them
            "Price" and "Discount price" leaves the admin guessing which
            one the customer pays. Getting that backwards on a live
            product is a real, visible error.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Regular price (BDT)
              </span>

              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                required
                aria-invalid={fieldErrors.pricePaisa ? true : undefined}
                aria-describedby={
                  fieldErrors.pricePaisa
                    ? "product-price-error"
                    : "regular-price-hint"
                }
                className={[
                  "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm tabular-nums text-foreground",
                  "focus:outline-none focus:ring-2",
                  fieldErrors.pricePaisa
                    ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                    : "border-border focus:border-brand-300 focus:ring-brand-200",
                ].join(" ")}
              />

              <FieldError
                id="product-price-error"
                message={fieldErrors.pricePaisa}
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-foreground-muted">
                Discount price (BDT)
              </span>

              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={discountPrice}
                onChange={(event) => setDiscountPrice(event.target.value)}
                placeholder="No discount"
                aria-invalid={fieldErrors.discountPricePaisa ? true : undefined}
                aria-describedby={
                  fieldErrors.discountPricePaisa
                    ? "product-discount-price-error"
                    : "regular-price-hint"
                }
                className={[
                  "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm tabular-nums text-foreground placeholder:text-foreground-muted",
                  "focus:outline-none focus:ring-2",
                  fieldErrors.discountPricePaisa
                    ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                    : "border-border focus:border-brand-300 focus:ring-brand-200",
                ].join(" ")}
              />

              <FieldError
                id="product-discount-price-error"
                message={fieldErrors.discountPricePaisa}
              />
            </label>
          </div>

          <p id="regular-price-hint" className="text-xs text-foreground-muted">
            {discountPricePaisa !== null && pricePaisa !== null ? (
              discountPricePaisa < pricePaisa ? (
                `The customer pays ${formatPaisa(discountPricePaisa)} — ${formatPaisa(pricePaisa - discountPricePaisa)} off the regular price. The regular price is shown struck through.`
              ) : discountPricePaisa === pricePaisa ? (
                "The discount price matches the regular price, so no discount is shown."
              ) : (
                "The discount price is higher than the regular price — it will not be shown as a discount."
              )
            ) : (
              "Leave the discount price blank when the product is not on sale."
            )}
          </p>

          {/*
            The cost side of the ledger.

            These two fields are what make the profit figures possible.
            The **purchase price** is what the shop paid; the **selling
            price** is what it charges — which is not always the regular
            price above, because a product on sale is sold for less.

            Both are **optional**, and blank means "not known" rather than
            "free". A sale of a product with no recorded cost is
            *excluded* from the profit figures — so a blank field is a
            truthful gap, not a zero that would report a 100% margin on
            goods the shop paid real money for.
          */}
          <fieldset className="rounded-2xl border border-border bg-surface-muted/40 p-4">
            <legend className="px-1 text-xs font-medium text-foreground-muted">
              Cost tracking
            </legend>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium text-foreground-muted">
                  Purchase price (BDT)
                </span>

                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={purchasePrice}
                  onChange={(event) => setPurchasePrice(event.target.value)}
                  placeholder="Not known"
                  aria-invalid={
                    fieldErrors.purchasePricePaisa ? true : undefined
                  }
                  aria-describedby={
                    fieldErrors.purchasePricePaisa
                      ? "product-purchase-price-error"
                      : "cost-tracking-hint"
                  }
                  className={[
                    "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm tabular-nums text-foreground placeholder:text-foreground-muted",
                    "focus:outline-none focus:ring-2",
                    fieldErrors.purchasePricePaisa
                      ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                      : "border-border focus:border-brand-300 focus:ring-brand-200",
                  ].join(" ")}
                />

                <FieldError
                  id="product-purchase-price-error"
                  message={fieldErrors.purchasePricePaisa}
                />
              </label>

              <label className="block">
                <span className="text-xs font-medium text-foreground-muted">
                  Selling price (BDT)
                </span>

                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={sellingPrice}
                  onChange={(event) => setSellingPrice(event.target.value)}
                  placeholder="Not known"
                  aria-invalid={
                    fieldErrors.sellingPricePaisa ? true : undefined
                  }
                  aria-describedby={
                    fieldErrors.sellingPricePaisa
                      ? "product-selling-price-error"
                      : "cost-tracking-hint"
                  }
                  className={[
                    "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm tabular-nums text-foreground placeholder:text-foreground-muted",
                    "focus:outline-none focus:ring-2",
                    fieldErrors.sellingPricePaisa
                      ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                      : "border-border focus:border-brand-300 focus:ring-brand-200",
                  ].join(" ")}
                />

                <FieldError
                  id="product-selling-price-error"
                  message={fieldErrors.sellingPricePaisa}
                />
              </label>
            </div>

            <p id="cost-tracking-hint" className="mt-2 text-xs text-foreground-muted">
              What the shop paid, and what it charges. Leave a field blank when
              the cost is not known — sales of that product are then left out of
              the profit figures rather than counted as if the goods were free.
              {purchasePricePaisa !== null && pricePaisa !== null ? (
                <>
                  {" "}
                  The margin on the regular price would be{" "}
                  {formatPaisa(pricePaisa - purchasePricePaisa)} (
                  {Math.round(
                    ((pricePaisa - purchasePricePaisa) / pricePaisa) * 100,
                  )}
                  %).
                </>
              ) : null}
            </p>
          </fieldset>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              {isEdit ? "Change stock by" : "Opening stock"}
            </span>

            <input
              type="number"
              inputMode="numeric"
              step={1}
              value={stockDelta}
              onChange={(event) => setStockDelta(event.target.value)}
              placeholder={isEdit ? "+10 or -3" : "0"}
              aria-invalid={fieldErrors.stockQuantity ? true : undefined}
              aria-describedby={
                fieldErrors.stockQuantity
                  ? "product-stock-error"
                  : "stock-delta-hint"
              }
              className={[
                "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm tabular-nums text-foreground placeholder:text-foreground-muted",
                "focus:outline-none focus:ring-2",
                fieldErrors.stockQuantity
                  ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                  : "border-border focus:border-brand-300 focus:ring-brand-200",
              ].join(" ")}
            />

            <FieldError
              id="product-stock-error"
              message={fieldErrors.stockQuantity}
            />
          </label>

          <p id="stock-delta-hint" className="text-xs text-foreground-muted">
            {isEdit ? (
              projectedStock === null ? (
                "A signed change — positive adds units, negative removes them. Leave blank to leave the stock alone."
              ) : projectedStock < 0 ? (
                <span className="text-red-700">
                  That would leave {projectedStock} units on the shelf. The stock
                  cannot go below zero.
                </span>
              ) : (
                `The stock would become ${projectedStock}.`
              )
            ) : (
              "How many units are on the shelf when the product is added."
            )}
          </p>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Ingredient tags
            </span>

            <input
              type="text"
              value={ingredientTags}
              onChange={(event) => setIngredientTags(event.target.value)}
              placeholder="AHA, NIACINAMIDE, VITAMIN_C"
              aria-invalid={fieldErrors.ingredientTags ? true : undefined}
              aria-describedby={
                fieldErrors.ingredientTags
                  ? "product-ingredient-tags-error"
                  : undefined
              }
              className={[
                "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted",
                "focus:outline-none focus:ring-2",
                fieldErrors.ingredientTags
                  ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                  : "border-border focus:border-brand-300 focus:ring-brand-200",
              ].join(" ")}
            />

            <FieldError
              id="product-ingredient-tags-error"
              message={fieldErrors.ingredientTags}
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Climate tips
            </span>

            <textarea
              value={climateTips}
              onChange={(event) => setClimateTips(event.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="How to use this in Bangladesh's heat and humidity"
              aria-invalid={fieldErrors.climateTips ? true : undefined}
              aria-describedby={
                fieldErrors.climateTips ? "product-climate-tips-error" : undefined
              }
              className={[
                "mt-1 w-full rounded-2xl border bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-foreground-muted",
                "focus:outline-none focus:ring-2",
                fieldErrors.climateTips
                  ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                  : "border-border focus:border-brand-300 focus:ring-brand-200",
              ].join(" ")}
            />

            <FieldError
              id="product-climate-tips-error"
              message={fieldErrors.climateTips}
            />
          </label>

          {/*
            The picker's `onChange` is a **state setter**, so it accepts
            both a plain list and a function of the current list. The
            picker uses the functional form for its upload append — the
            upload is asynchronous, so the list it appends to must be
            the one that is current when the request comes back, not the
            one that was captured when the upload started.
          */}
          <ProductImagePicker images={images} onChange={setImages} />

          {/*
            The image list's own error.

            The picker owns its own messages — an upload failure is
            shown by the picker, right where the file was chosen. But a
            **list-level** refusal ("that image reference points
            outside the upload directory") comes back from the save
            request, and it belongs to the image list rather than to
            any one input.
          */}
          <FieldError message={fieldErrors.images} />

          <ProductBadgeEditor
            badges={badges}
            onChange={setBadges}
            hasDiscount={
              pricePaisa !== null &&
              discountPricePaisa !== null &&
              discountPricePaisa < pricePaisa
            }
          />

          <FieldError message={fieldErrors.badges} />

          {/*
            The skin concerns.

            It sits right after the badges because the two are the same
            kind of thing — a set of shoppable labels the admin picks
            from — and the product's marketing tags belong together on
            the form.
          */}
          <ProductConcernPicker
            concerns={concerns}
            selected={concernSlugs}
            onChange={setConcernSlugs}
          />

          <FieldError message={fieldErrors.concernSlugs} />

          <label className="block">
            <span className="text-xs font-medium text-foreground-muted">
              Reason{" "}
              {reasonRequired ? (
                <span className="text-red-600">*</span>
              ) : (
                <span className="font-normal">(optional)</span>
              )}
            </span>

            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                isEdit
                  ? "e.g. supplier price increase"
                  : "e.g. new product from the spring range"
              }
              maxLength={500}
              aria-invalid={fieldErrors.reason ? true : undefined}
              aria-describedby={
                fieldErrors.reason ? "product-reason-error" : undefined
              }
              className={[
                "mt-1 h-10 w-full rounded-full border bg-surface px-3.5 text-sm text-foreground placeholder:text-foreground-muted",
                "focus:outline-none focus:ring-2",
                fieldErrors.reason
                  ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                  : "border-border focus:border-brand-300 focus:ring-brand-200",
              ].join(" ")}
            />

            <FieldError id="product-reason-error" message={fieldErrors.reason} />
          </label>

          {/*
            The whole-form error.

            Shown only when **no** field is to blame — a conflict, a
            network failure, a server fault. Those failures are about
            the submission as a whole, so they belong in one place rather
            than under a field that did nothing wrong.
          */}
          {error ? (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={closeDialog}
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
                  : "Add product"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * One field's error message.
 *
 * ── Why it renders nothing at all ─────────────────────────────────────────
 *
 * A form with a red box under every field is a form that looks broken.
 * So the message is rendered **only when there is one**, and it is
 * rendered immediately under the input it is about — close enough that
 * the admin does not have to hunt for which of a dozen fields the
 * server was talking about.
 *
 * `role="alert"` means a screen reader announces it the moment it
 * appears, without the admin having to go looking for it.
 */
function FieldError({
  id,
  message,
}: {
  /**
   * The element id, so the input can point at it with
   * `aria-describedby`. Omitted for the list-level errors, which have
   * no input to attach to.
   */
  readonly id?: string;
  /**
   * The message, or `undefined` when the field is fine.
   */
  readonly message?: string;
}) {
  if (!message) return null;

  return (
    <p id={id} role="alert" className="mt-1.5 text-xs text-red-700">
      {message}
    </p>
  );
}

/**
 * Converts a taka string to poisha.
 *
 * `null` when the input is not a number. The API works in poisha — an
 * integer — and the conversion happens here, at the edge, so the
 * integer money type never has to survive a `parseFloat`.
 */
function toPaisa(value: string): number | null {
  const trimmed = value.trim();

  if (trimmed.length === 0) return null;

  const parsed = Number.parseFloat(trimmed);

  if (!Number.isFinite(parsed) || parsed < 0) return null;

  return Math.round(parsed * 100);
}

/**
 * Splits a comma-separated list into trimmed, non-empty entries.
 */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
