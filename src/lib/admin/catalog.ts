import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import type { SessionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import {
  BEST_SELLER_BADGE,
  NEW_ARRIVAL_BADGE,
} from "@/lib/format/badges";
import { canonicalBrand } from "@/lib/format/brand";
import type {
  ProductCreateInput,
  ProductUpdateInput,
} from "@/lib/validation/admin";

import {
  PRODUCT_ACTIONS,
  toAuditActor,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin catalogue service — product create, update, archive, delete.
 *
 * ── Why this is a separate module from `products.ts` ─────────────────────
 *
 * `src/lib/admin/products.ts` is the **stock desk**. It answers one
 * question: "how many units are on the shelf?" — and its write path is a
 * signed delta, which cannot clobber a concurrent checkout.
 *
 * This module is the **catalogue desk**. It answers "what is this
 * product, and what does it cost?" — and its write path is a set of
 * discrete fields, each of which is a commercial decision.
 *
 * The two are separate files because the rules are genuinely different:
 * a stock delta is commutative and two admins adding five correctly
 * compose to "add ten"; a price is not, and two admins setting a price
 * must produce one winner and one 409. Merging them would mean one
 * write path with two sets of rules, and the stricter set would leak
 * into the stock path — where it does not belong.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. Every write shares its transaction with its audit entry.**
 *
 * Same rule as every other admin mutation, for the same reason: a
 * product that was repriced with no record of why is indistinguishable
 * from a product that was never repriced.
 *
 * **2. Every update is conditional on the values the admin saw.**
 *
 * The read that precedes the write is not just for validation — it is
 * the *expectation*. The `updateMany` matches on the observed values of
 * the fields being changed, so if another admin changed the price in
 * the window between the admin's page load and their save, the update
 * matches zero rows and the second admin is told to reload. One
 * winner, one 409.
 *
 * **3. A price change requires a reason.**
 *
 * The price is a commercial decision, and an audit entry that says
 * "price 95000 → 120000" with no reason cannot answer "why". A name
 * change does not need one — but it may carry one.
 *
 * **4. A stock change is a signed delta, never an absolute.**
 *
 * An Edit form that wrote an absolute stock quantity would destroy a
 * concurrent checkout's reservation without any trace — the two
 * operations look identical in the database. So the stock change on the
 * Edit form is a `stockDelta`, and it is applied here in the same
 * transaction as the rest of the edit, with its own audit entry.
 *
 * **5. "Delete" means archive.**
 *
 * `OrderItem.productId` is `onDelete: Restrict`, and the order line
 * snapshots the product's name and price *precisely so that history
 * survives*. So a hard delete is only safe for a product that has never
 * been ordered, never been carted, and never been reviewed. Everything
 * else is archived.
 *
 * **6. The audit entry records the changed fields only.**
 *
 * A `before`/`after` pair holding the whole product row would bury the
 * one field that changed under eleven that did not. The entry says
 * "price 95000 → 120000", not "here is the product, twice".
 */

/**
 * The full product detail, as the admin product form sees it.
 */
export type AdminProductDetail = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /**
   * The product's brand.
   *
   * `null` means "unknown" — the storefront renders no brand line at all
   * rather than a blank one.
   */
  readonly brand: string | null;
  readonly categoryId: string;
  readonly category: { readonly id: string; readonly name: string; readonly slug: string };
  readonly pricePaisa: number;
  readonly discountPricePaisa: number | null;
  readonly discountPercentage: number | null;
  /**
   * What the shop paid for one unit, in poisha.
   *
   * `null` means "not known" — the product's cost has never been
   * recorded. It is **not** zero, and a margin computed against a
   * missing cost is excluded rather than counted as if the goods were
   * free.
   */
  readonly purchasePricePaisa: number | null;
  /**
   * What the customer is charged for one unit, in poisha.
   *
   * `null` means "not known".
   */
  readonly sellingPricePaisa: number | null;
  /**
   * How many units of this product have been sold.
   *
   * A convenience counter, maintained at the point of sale. The
   * authoritative figure is always the sum of the order items, and the
   * profit numbers are computed from the order items rather than from
   * this column.
   */
  readonly soldCount: number;
  readonly stockQuantity: number;
  readonly ingredientTags: string[];
  /**
   * The skin concerns this product addresses — "Shop by Concern".
   *
   * The **slugs** of the concerns in the `SkinConcern` table, not their
   * ids. A slug is the shop's own stable, readable name for a concern,
   * and it is what the storefront's URLs already speak.
   */
  readonly concernSlugs: string[];
  readonly climateTips: string | null;
  readonly images: string[];
  /**
   * The promotional badges.
   *
   * The **source of truth** for the product's promotional labels. The
   * two booleans below are a mirror of two entries in this list.
   */
  readonly badges: string[];
  readonly isNewArrival: boolean;
  readonly isBestSeller: boolean;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * The Prisma select for the full admin product detail.
 */
const ADMIN_PRODUCT_DETAIL_SELECT = {
  id: true,
  name: true,
  description: true,
  brand: true,
  categoryId: true,
  category: { select: { id: true, name: true, slug: true } },
  pricePaisa: true,
  discountPricePaisa: true,
  discountPercentage: true,
  purchasePricePaisa: true,
  sellingPricePaisa: true,
  soldCount: true,
  stockQuantity: true,
  ingredientTags: true,
  concernSlugs: true,
  climateTips: true,
  images: true,
  badges: true,
  isNewArrival: true,
  isBestSeller: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

/**
 * The product fields the admin form may change.
 *
 * Every field is optional — a partial update changes only what it
 * names. A save that changes the name and the description does not
 * silently reset the price.
 */
const EDITABLE_FIELDS = [
  "name",
  "description",
  "brand",
  "categoryId",
  "pricePaisa",
  "discountPricePaisa",
  "purchasePricePaisa",
  "sellingPricePaisa",
  "ingredientTags",
  "concernSlugs",
  "climateTips",
  "images",
  "badges",
  "isNewArrival",
  "isBestSeller",
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Loads a single product for the admin form.
 *
 * Unlike the storefront, the admin read **does not** filter archived
 * products — an admin has to be able to find and restore one.
 */
export async function getAdminProduct(
  productId: string,
): Promise<AdminProductDetail> {
  const product = await db.product.findUnique({
    where: { id: productId },
    select: ADMIN_PRODUCT_DETAIL_SELECT,
  });

  if (!product) {
    throw ApiError.notFound("That product does not exist.");
  }

  return product;
}

/**
 * The discount percentage, derived from the two prices.
 *
 * The column is a convenience mirror for badge rendering, and it is
 * always recomputed rather than trusted — a stored percentage that
 * disagrees with the prices it was derived from is a lie the storefront
 * would tell.
 */
function discountPercentage(
  pricePaisa: number,
  discountPricePaisa: number | null,
): number | null {
  if (discountPricePaisa === null || pricePaisa <= 0) {
    return null;
  }

  if (discountPricePaisa >= pricePaisa) {
    return 0;
  }

  return Math.round(((pricePaisa - discountPricePaisa) / pricePaisa) * 100);
}

/**
 * The badge list and the two booleans the storefront reads.
 *
 * ── Why this is resolved in one place ────────────────────────────────────
 *
 * The product carries a **badge list** — "New Arrival", "Best Seller",
 * "Limited Edition", plus any custom tag. The storefront reads the two
 * **booleans** `isNewArrival` and `isBestSeller`, because that is what
 * its badge rendering was written against.
 *
 * So the two must be kept in step, and there is exactly **one** place
 * that does it. A second implementation — a rule in the update path and
 * another in the create path — is two rules that will drift, and the
 * symptom would be a product whose admin form says "New Arrival" and
 * whose storefront says nothing.
 *
 * ### Which side wins
 *
 * **The badge list wins**, and the legacy booleans are merged into it.
 *
 * A client that sends `badges: ["New Arrival"]` and `isNewArrival:
 * false` is making a more specific statement with the list, and the
 * more specific statement is the one that was meant. So the list is
 * authoritative for the two badges it can express, and the booleans
 * can only *add* to it — they can never subtract.
 *
 * That means an older client that still sends only the booleans keeps
 * working, and a newer client that sends only the list gets exactly
 * what it asked for.
 */
function resolveBadges(
  badges: readonly string[],
  legacyNewArrival: boolean | undefined,
  legacyBestSeller: boolean | undefined,
): { readonly badges: string[]; readonly isNewArrival: boolean; readonly isBestSeller: boolean } {
  const resolved = [...badges];

  const has = (badge: string): boolean =>
    resolved.some((entry) => entry.toLowerCase() === badge.toLowerCase());

  // The legacy booleans can only add. They are checked against the
  // *normalised* list, so a badge already present under any spelling
  // is not added twice.
  if (legacyNewArrival === true && !has(NEW_ARRIVAL_BADGE)) {
    resolved.push(NEW_ARRIVAL_BADGE);
  }

  if (legacyBestSeller === true && !has(BEST_SELLER_BADGE)) {
    resolved.push(BEST_SELLER_BADGE);
  }

  return {
    badges: resolved,
    isNewArrival: has(NEW_ARRIVAL_BADGE),
    isBestSeller: has(BEST_SELLER_BADGE),
  };
}

/**
 * The Prisma data for a create, with the discount mirror computed.
 */
function createData(input: ProductCreateInput): Prisma.ProductCreateInput {
  const resolved = resolveBadges(
    input.badges,
    input.isNewArrival,
    input.isBestSeller,
  );

  return {
    name: input.name,
    description: input.description ?? "",
    brand: normaliseBrand(input.brand),
    category: { connect: { id: input.categoryId } },
    pricePaisa: input.pricePaisa,
    discountPricePaisa: input.discountPricePaisa ?? null,
    discountPercentage: discountPercentage(
      input.pricePaisa,
      input.discountPricePaisa ?? null,
    ),
    /**
     * The cost side of the ledger.
     *
     * `null` when the cost is not known. It is **not** defaulted to
     * zero — a product recorded as costing nothing would report a 100%
     * margin on every sale it made.
     */
    purchasePricePaisa: input.purchasePricePaisa ?? null,
    sellingPricePaisa: input.sellingPricePaisa ?? null,
    stockQuantity: input.stockQuantity,
    ingredientTags: input.ingredientTags,
    concernSlugs: input.concernSlugs ?? [],
    climateTips: input.climateTips ?? null,
    images: input.images,
    badges: resolved.badges,
    isNewArrival: resolved.isNewArrival,
    isBestSeller: resolved.isBestSeller,
  };
}

/**
 * Checks that every concern slug names a concern the shop actually has.
 *
 * ── Why the check lives here and not in the schema ─────────────────────────
 *
 * The concern vocabulary is a **table**, not a constant. An admin adds
 * "Redness" in the Concerns panel, and it is available in the product
 * picker immediately — with no code change and no redeploy.
 *
 * That flexibility is exactly why the check cannot live in the Zod
 * schema: the schema cannot know what the table holds at request time.
 * So the schema checks the **shape** of a slug, and this function checks
 * its **existence**.
 *
 * ── Why an unknown slug is refused rather than dropped ────────────────────
 *
 * Dropping it would make the admin's save *appear* to work while
 * quietly losing the selection — and the product would then be missing
 * from the concern page the admin was trying to put it on. A refusal
 * says what happened.
 *
 * @param slugs - The slugs the client sent.
 * @param tx    - The transaction the write is happening in.
 *
 * @throws ApiError 400 when a slug names no concern.
 */
async function assertConcernsExist(
  slugs: readonly string[],
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (slugs.length === 0) return;

  const known = await tx.skinConcern.findMany({
    where: { slug: { in: [...slugs] } },
    select: { slug: true },
  });

  const knownSlugs = new Set(known.map((concern) => concern.slug));

  const unknown = slugs.filter((slug) => !knownSlugs.has(slug));

  if (unknown.length > 0) {
    throw ApiError.validation(
      `Those skin concerns do not exist: ${unknown.join(", ")}.`,
      {
        fieldErrors: {
          concernSlugs: unknown.map(
            (slug) => `There is no skin concern called "${slug}".`,
          ),
        },
      },
    );
  }
}

/**
 * The brand as it is stored.
 *
 * ── Why the service canonicalises, and not only the schema ─────────────
 *
 * The Zod schema already folds a known brand to its registry spelling,
 * so a request through the API never carries "cerave" to the database.
 *
 * But this service is a **public API of its own** — the admin form
 * calls it, the route calls it, and a future caller will call it. If
 * the canonicalisation lived only in the schema, then a caller that
 * bypassed the schema could store "cerave" on one product and "CeraVe"
 * on another, and the shop would show two brands that look identical.
 *
 * So the canonicalisation happens here, at the point of the write. The
 * schema's transform is a convenience — it lets the admin form show
 * the corrected spelling before the save — but the **guarantee** lives
 * in the service, where every path to the database passes through it.
 *
 * A `null` brand stays `null`, and a blank string becomes `null`:
 * "no brand" is one value, and there are two spellings of it.
 */
function normaliseBrand(brand: string | null | undefined): string | null {
  if (brand === null || brand === undefined) return null;

  return canonicalBrand(brand);
}

/**
 * Creates a product.
 *
 * ── The rules ───────────────────────────────────────────────────────────
 *
 * **1. The category must exist.** The client sends a category id, not a
 * category name; a product in a category that does not exist would be
 * invisible to the storefront's category pages.
 *
 * **2. The opening stock is absolute.** This is the one place an
 * absolute stock value is correct — a new product's stock is not
 * derived from anything, because there is nothing to derive it from.
 * It is recorded in the audit entry's `after` as the opening stock.
 *
 * **3. The product is created live.** `archivedAt` is not settable
 * here — archiving is a separate, deliberate act with its own audit
 * entry.
 *
 * @param actor - The admin creating the product.
 * @param input - The catalogue facts.
 *
 * @throws ApiError 404 when the category does not exist.
 */
export async function createProduct(
  actor: AuditActor,
  input: ProductCreateInput,
): Promise<AdminProductDetail> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const category = await tx.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true },
      });

      if (!category) {
        throw ApiError.notFound("That category does not exist.");
      }

      /**
       * The concerns must exist.
       *
       * The vocabulary is a table, so this cannot be checked by the
       * schema — see `assertConcernsExist`.
       */
      await assertConcernsExist(input.concernSlugs ?? [], tx);

      const product = await tx.product.create({
        data: createData(input),
        select: ADMIN_PRODUCT_DETAIL_SELECT,
      });

      await writeAuditEntry(tx, {
        actor,
        action: PRODUCT_ACTIONS.created,
        entityType: "product",
        entityId: product.id,
        before: null,
        after: {
          name: product.name,
          brand: product.brand,
          categoryId: product.categoryId,
          pricePaisa: product.pricePaisa,
          discountPricePaisa: product.discountPricePaisa,
          purchasePricePaisa: product.purchasePricePaisa,
          sellingPricePaisa: product.sellingPricePaisa,
          stockQuantity: product.stockQuantity,
          badges: product.badges,
          concernSlugs: product.concernSlugs,
          isNewArrival: product.isNewArrival,
          isBestSeller: product.isBestSeller,
        },
        reason: null,
      });

      return product;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * The changed-field snapshot of a product.
 *
 * Only the fields the edit actually touched are recorded, so the audit
 * entry reads "price 95000 → 120000" rather than carrying the whole row
 * twice.
 */
function snapshot(
  product: {
    readonly name: string;
    readonly description: string;
    readonly brand: string | null;
    readonly categoryId: string;
    readonly pricePaisa: number;
    readonly discountPricePaisa: number | null;
    readonly purchasePricePaisa: number | null;
    readonly sellingPricePaisa: number | null;
    readonly ingredientTags: string[];
    readonly concernSlugs: string[];
    readonly climateTips: string | null;
    readonly images: string[];
    readonly badges: string[];
    readonly isNewArrival: boolean;
    readonly isBestSeller: boolean;
  },
  fields: readonly EditableField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    result[field] = product[field];
  }

  return result;
}

/**
 * Updates a product.
 *
 * ── The rules ───────────────────────────────────────────────────────────
 *
 * **1. A partial update changes only what it names.** Every field is
 * optional, and a field that is absent is not written at all.
 *
 * **2. The write is conditional on the observed values.** The update
 * matches on the values of the fields being changed, as they were when
 * the admin's page was loaded. Two admins editing the same product
 * produce one winner and one 409.
 *
 * **3. A price change requires a reason.** Absent a reason, the edit
 * is refused — the price is a commercial decision, and "why" is part of
 * the record.
 *
 * **4. A stock change is a signed delta.** It is applied in the same
 * transaction as the rest of the edit, and it gets its own audit entry
 * — a stock adjustment that rode along with a rename would be invisible
 * in the stock trail.
 *
 * @param actor     - The admin making the change.
 * @param productId - The product to change.
 * @param input     - The fields to change.
 *
 * @throws ApiError 404 when the product does not exist.
 * @throws ApiError 404 when the category does not exist.
 * @throws ApiError 400 when a price changes with no reason.
 * @throws ApiError 409 when the product changed underneath the admin.
 */
export async function updateProduct(
  actor: AuditActor,
  productId: string,
  input: ProductUpdateInput,
): Promise<AdminProductDetail> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          description: true,
          brand: true,
          categoryId: true,
          pricePaisa: true,
          discountPricePaisa: true,
          purchasePricePaisa: true,
          sellingPricePaisa: true,
          stockQuantity: true,
          ingredientTags: true,
          concernSlugs: true,
          climateTips: true,
          images: true,
          badges: true,
          isNewArrival: true,
          isBestSeller: true,
        },
      });

      if (!current) {
        throw ApiError.notFound("That product does not exist.");
      }

      // ── The reason requirement ─────────────────────────────────────
      //
      // Only a *change* to a price needs a reason. Sending the same
      // price the product already has is not a change, so it does not
      // demand one — otherwise an admin editing only the description
      // of a discounted product would be forced to justify a price
      // they never touched.
      const touched = EDITABLE_FIELDS.filter(
        (field) => input[field] !== undefined,
      );

      const priceChanged =
        (input.pricePaisa !== undefined &&
          input.pricePaisa !== current.pricePaisa) ||
        (input.discountPricePaisa !== undefined &&
          input.discountPricePaisa !== current.discountPricePaisa);

      const reasonGiven = Boolean(input.reason && input.reason.trim().length > 0);

      if (priceChanged && !reasonGiven) {
        throw ApiError.validation(
          "Give a reason for the price change.",
          { fieldErrors: { reason: ["A price change needs a reason."] } },
        );
      }

      // ── The category must exist ───────────────────────────────────
      if (input.categoryId !== undefined && input.categoryId !== current.categoryId) {
        const category = await tx.category.findUnique({
          where: { id: input.categoryId },
          select: { id: true },
        });

        if (!category) {
          throw ApiError.notFound("That category does not exist.");
        }
      }

      // ── The concerns must exist ───────────────────────────────────
      //
      // The vocabulary is a table, so this cannot be checked by the
      // schema — see `assertConcernsExist`.
      if (input.concernSlugs !== undefined) {
        await assertConcernsExist(input.concernSlugs, tx);
      }

      // ── The data to write ──────────────────────────────────────────
      const data: Prisma.ProductUpdateInput = {};

      if (input.name !== undefined) {
        data.name = input.name;
      }

      if (input.description !== undefined) {
        data.description = input.description;
      }

      if (input.brand !== undefined) {
        // `null` clears the brand. An absent field leaves it alone —
        // that is what a partial update means.
        //
        // The write is canonicalised here, for the same reason the
        // create path is: the guarantee that the database holds one
        // spelling per brand must live at the write, not only in the
        // schema that happens to sit in front of one caller.
        data.brand = normaliseBrand(input.brand);
      }

      if (input.categoryId !== undefined) {
        data.category = { connect: { id: input.categoryId } };
      }

      if (input.pricePaisa !== undefined) {
        data.pricePaisa = input.pricePaisa;
      }

      if (input.discountPricePaisa !== undefined) {
        data.discountPricePaisa = input.discountPricePaisa;
      }

      // ── The cost side of the ledger ─────────────────────────────────
      //
      // `null` **clears** the cost. An absent field leaves it alone —
      // that is what a partial update means.
      //
      // A cost is never defaulted to zero here. A product recorded as
      // costing nothing would report a 100% margin on every sale it
      // made, and the margin figures exclude unknown costs rather
      // than pretending the goods were free.
      if (input.purchasePricePaisa !== undefined) {
        data.purchasePricePaisa = input.purchasePricePaisa;
      }

      if (input.sellingPricePaisa !== undefined) {
        data.sellingPricePaisa = input.sellingPricePaisa;
      }

      if (input.ingredientTags !== undefined) {
        data.ingredientTags = input.ingredientTags;
      }

      if (input.concernSlugs !== undefined) {
        data.concernSlugs = input.concernSlugs;
      }

      if (input.climateTips !== undefined) {
        data.climateTips = input.climateTips;
      }

      if (input.images !== undefined) {
        data.images = input.images;
      }

      // ── The badges, and the booleans derived from them ─────────────
      //
      // The badge list is the source of truth. The two booleans the
      // storefront reads are a **mirror** of two entries in it, and
      // they are resolved together — so a save can never leave the
      // admin form and the storefront disagreeing about whether a
      // product is new.
      //
      // A save that names the badge list replaces it wholesale. A save
      // that names only the booleans — an older client — adds to the
      // existing list. A save that names neither leaves both alone.
      if (input.badges !== undefined) {
        const resolved = resolveBadges(
          input.badges,
          input.isNewArrival,
          input.isBestSeller,
        );

        data.badges = resolved.badges;
        data.isNewArrival = resolved.isNewArrival;
        data.isBestSeller = resolved.isBestSeller;
      } else if (
        input.isNewArrival !== undefined ||
        input.isBestSeller !== undefined
      ) {
        // Only the booleans were named. The list is carried forward and
        // the booleans are re-derived from it, so a client that still
        // sends the legacy flags cannot desynchronise the two.
        const resolved = resolveBadges(
          current.badges,
          input.isNewArrival ?? current.isNewArrival,
          input.isBestSeller ?? current.isBestSeller,
        );

        data.badges = resolved.badges;
        data.isNewArrival = resolved.isNewArrival;
        data.isBestSeller = resolved.isBestSeller;
      }

      // The discount mirror is recomputed from the prices the product
      // will *have* after this edit, not from the ones it has now.
      const nextPrice =
        input.pricePaisa !== undefined ? input.pricePaisa : current.pricePaisa;
      const nextDiscount =
        input.discountPricePaisa !== undefined
          ? input.discountPricePaisa
          : current.discountPricePaisa;

      if (
        input.pricePaisa !== undefined ||
        input.discountPricePaisa !== undefined
      ) {
        data.discountPercentage = discountPercentage(nextPrice, nextDiscount);
      }

      // ── The conditional update ─────────────────────────────────────
      //
      // The condition is the *observed* value of every field the edit
      // touches. If any of them changed since the read, the update
      // matches zero rows and the admin is told to reload.
      //
      // The update is **skipped entirely** when the edit named no
      // editable field — a stock-only edit, say. Prisma's `updateMany`
      // with an empty `data` matches zero rows rather than matching
      // the one row, so running it unconditionally would turn every
      // stock-only edit into a spurious 409.
      if (touched.length > 0) {
        const expectation: Prisma.ProductWhereInput = { id: productId };

        for (const field of touched) {
          if (field === "discountPricePaisa") {
            expectation.discountPricePaisa = current.discountPricePaisa;
          } else if (field === "climateTips") {
            expectation.climateTips = current.climateTips;
          } else if (field === "ingredientTags") {
            expectation.ingredientTags = { equals: current.ingredientTags };
          } else if (field === "concernSlugs") {
            expectation.concernSlugs = { equals: current.concernSlugs };
          } else if (field === "images") {
            expectation.images = { equals: current.images };
          } else if (field === "badges") {
            expectation.badges = { equals: current.badges };
          } else {
            // The scalar fields. Prisma narrows this union at runtime;
            // the cast keeps the type checker honest about the shape
            // without repeating ten near-identical branches.
            (expectation as Record<string, unknown>)[field] =
              current[field as keyof typeof current];
          }
        }

        const updated = await tx.product.updateMany({
          where: expectation,
          data,
        });

        if (updated.count === 0) {
          throw ApiError.conflict(
            "This product was changed by someone else while you were editing it. Reload and try again.",
          );
        }
      }

      // ── The stock change ───────────────────────────────────────────
      //
      // A signed delta, applied in the same transaction as the rest of
      // the edit. It cannot drive the stock negative — that is a
      // refusal, not a clamp.
      if (input.stockDelta !== undefined) {
        const newQuantity = current.stockQuantity + input.stockDelta;

        if (newQuantity < 0) {
          throw ApiError.conflict(
            `That change would leave the stock at ${newQuantity}. There are only ${current.stockQuantity} units on the shelf.`,
            {
              productId,
              currentQuantity: current.stockQuantity,
              requestedDelta: input.stockDelta,
              resultingQuantity: newQuantity,
            },
          );
        }

        const stockUpdated = await tx.product.updateMany({
          where: { id: productId, stockQuantity: current.stockQuantity },
          data: { stockQuantity: newQuantity },
        });

        if (stockUpdated.count === 0) {
          throw ApiError.conflict(
            "This product's stock was changed by someone else while you were editing it. Reload and try again.",
          );
        }

        // The stock change gets its **own** audit entry. A stock
        // adjustment that rode along inside a rename would be invisible
        // in the stock trail — and the stock trail is what an operator
        // reads to answer "why is this product short?".
        await writeAuditEntry(tx, {
          actor,
          action: PRODUCT_ACTIONS.stockAdjusted,
          entityType: "product",
          entityId: productId,
          before: { stockQuantity: current.stockQuantity },
          after: { stockQuantity: newQuantity },
          reason: input.reason ?? null,
        });
      }

      // ── The audit entry for the edit itself ───────────────────────
      //
      // `before` and `after` carry **only the changed fields**, so the
      // entry reads as a diff rather than as two copies of the row.
      if (touched.length > 0) {
        const after = await tx.product.findUnique({
          where: { id: productId },
          select: {
            name: true,
            description: true,
            brand: true,
            categoryId: true,
            pricePaisa: true,
            discountPricePaisa: true,
            purchasePricePaisa: true,
            sellingPricePaisa: true,
            ingredientTags: true,
            concernSlugs: true,
            climateTips: true,
            images: true,
            badges: true,
            isNewArrival: true,
            isBestSeller: true,
          },
        });

        if (!after) {
          throw ApiError.notFound("That product does not exist.");
        }

        await writeAuditEntry(tx, {
          actor,
          action: PRODUCT_ACTIONS.updated,
          entityType: "product",
          entityId: productId,
          before: snapshot(current, touched),
          after: snapshot(after, touched),
          reason: input.reason ?? null,
        });
      }

      const detail = await tx.product.findUnique({
        where: { id: productId },
        select: ADMIN_PRODUCT_DETAIL_SELECT,
      });

      if (!detail) {
        throw ApiError.notFound("That product does not exist.");
      }

      return detail;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * The result of a delete or archive.
 */
export type AdminProductRemovalResult = {
  readonly id: string;
  readonly name: string;
  /**
   * `"ARCHIVED"` — withdrawn from sale, still in the database.
   * `"DELETED"` — removed from the database.
   */
  readonly outcome: "ARCHIVED" | "DELETED";
  readonly archivedAt: Date | null;
};

/**
 * Archives a product.
 *
 * ── Why this is the default "delete" ───────────────────────────────────
 *
 * `OrderItem.productId` is `onDelete: Restrict`, and the order line
 * snapshots the product's name and price *precisely so that history
 * survives*. So a product that has ever been ordered cannot be removed
 * from the database without destroying the record of that sale.
 *
 * Archiving withdraws the product from every storefront query — the
 * shared `ACTIVE_PRODUCT_WHERE` filter — while preserving the order
 * history. The product stays visible in the admin inventory list,
 * marked archived, and can be restored.
 *
 * The write is conditional on the product still being live, so two
 * admins archiving the same product produce one winner and one 409.
 *
 * @throws ApiError 404 when the product does not exist.
 * @throws ApiError 409 when the product is already archived.
 */
export async function archiveProduct(
  actor: AuditActor,
  productId: string,
  reason: string,
): Promise<AdminProductRemovalResult> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, archivedAt: true },
      });

      if (!current) {
        throw ApiError.notFound("That product does not exist.");
      }

      if (current.archivedAt !== null) {
        throw ApiError.conflict(
          "That product is already archived.",
          { productId, archivedAt: current.archivedAt },
        );
      }

      const archivedAt = new Date();

      const updated = await tx.product.updateMany({
        where: { id: productId, archivedAt: null },
        data: { archivedAt },
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "That product was changed by someone else. Reload and try again.",
        );
      }

      await writeAuditEntry(tx, {
        actor,
        action: PRODUCT_ACTIONS.deleted,
        entityType: "product",
        entityId: productId,
        before: { archivedAt: null },
        after: { archivedAt },
        reason,
      });

      return {
        id: current.id,
        name: current.name,
        outcome: "ARCHIVED" as const,
        archivedAt,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Removes a product from the database outright.
 *
 * ── When this is possible ───────────────────────────────────────────────
 *
 * Only for a product with **no order items, no cart items and no
 * reviews**. Anything else is refused, and the refusal names the
 * remedy — archiving is almost always the right answer.
 *
 * The check is a read, and the delete happens after it, so a product
 * that gains an order item between the check and the delete will raise
 * a foreign-key violation at the database level. That is mapped to a
 * 409 by `handleApiError`, with a message that says to archive it
 * instead — a conflict, not a crash.
 *
 * @throws ApiError 404 when the product does not exist.
 * @throws ApiError 409 when the product is still referenced.
 */
export async function hardDeleteProduct(
  actor: AuditActor,
  productId: string,
  reason: string,
): Promise<AdminProductRemovalResult> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          archivedAt: true,
          pricePaisa: true,
          discountPricePaisa: true,
          stockQuantity: true,
          _count: {
            select: { orderItems: true, cartItems: true, reviews: true },
          },
        },
      });

      if (!current) {
        throw ApiError.notFound("That product does not exist.");
      }

      const blockers: string[] = [];

      if (current._count.orderItems > 0) {
        blockers.push(`${current._count.orderItems} order item(s)`);
      }

      if (current._count.cartItems > 0) {
        blockers.push(`${current._count.cartItems} cart item(s)`);
      }

      if (current._count.reviews > 0) {
        blockers.push(`${current._count.reviews} review(s)`);
      }

      if (blockers.length > 0) {
        throw ApiError.conflict(
          `That product cannot be deleted because it is still referenced by ${blockers.join(", ")}. Archive it instead.`,
          {
            productId,
            orderItems: current._count.orderItems,
            cartItems: current._count.cartItems,
            reviews: current._count.reviews,
          },
        );
      }

      // The full row, captured **before** the delete — it is the audit
      // entry's `before`, and after the delete there is nothing left to
      // read.
      const before = {
        name: current.name,
        pricePaisa: current.pricePaisa,
        discountPricePaisa: current.discountPricePaisa,
        stockQuantity: current.stockQuantity,
        archivedAt: current.archivedAt,
      };

      await tx.product.delete({ where: { id: productId } });

      await writeAuditEntry(tx, {
        actor,
        action: PRODUCT_ACTIONS.deleted,
        entityType: "product",
        entityId: productId,
        before,
        after: null,
        reason,
      });

      return {
        id: current.id,
        name: current.name,
        outcome: "DELETED" as const,
        archivedAt: current.archivedAt,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Restores an archived product to the storefront.
 *
 * The counterpart to `archiveProduct` — a withdrawn product can be put
 * back on sale.
 *
 * @throws ApiError 404 when the product does not exist.
 * @throws ApiError 409 when the product is not archived.
 */
export async function restoreProduct(
  actor: AuditActor,
  productId: string,
  reason: string,
): Promise<AdminProductDetail> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, name: true, archivedAt: true },
      });

      if (!current) {
        throw ApiError.notFound("That product does not exist.");
      }

      if (current.archivedAt === null) {
        throw ApiError.conflict("That product is not archived.");
      }

      const updated = await tx.product.updateMany({
        where: { id: productId, archivedAt: current.archivedAt },
        data: { archivedAt: null },
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "That product was changed by someone else. Reload and try again.",
        );
      }

      await writeAuditEntry(tx, {
        actor,
        action: PRODUCT_ACTIONS.updated,
        entityType: "product",
        entityId: productId,
        before: { archivedAt: current.archivedAt },
        after: { archivedAt: null },
        reason,
      });

      const detail = await tx.product.findUnique({
        where: { id: productId },
        select: ADMIN_PRODUCT_DETAIL_SELECT,
      });

      if (!detail) {
        throw ApiError.notFound("That product does not exist.");
      }

      return detail;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Convenience wrapper that creates a product on behalf of a session user.
 */
export async function createProductAsUser(
  user: SessionUser,
  input: ProductCreateInput,
): Promise<AdminProductDetail> {
  return createProduct(toAuditActor(user), input);
}

/**
 * Convenience wrapper that updates a product on behalf of a session user.
 */
export async function updateProductAsUser(
  user: SessionUser,
  productId: string,
  input: ProductUpdateInput,
): Promise<AdminProductDetail> {
  return updateProduct(toAuditActor(user), productId, input);
}
