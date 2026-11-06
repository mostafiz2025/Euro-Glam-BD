import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import { canonicalBrand } from "@/lib/format/brand";
import type {
  AdminBrandQuery,
  BrandCreateInput,
  BrandUpdateInput,
} from "@/lib/validation/admin";

import {
  BRAND_ACTIONS,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin brand service — create, update and delete.
 *
 * ── Why a brand table, when Step 16 deliberately avoided one ─────────────
 *
 * Step 16 made `Product.brand` a plain nullable string rather than a
 * foreign key, and that decision **stands**. A foreign key would mean a
 * join on every product read and a migration rewriting every seeded row,
 * for a label with a closed vocabulary.
 *
 * This table is different in kind. It holds the **presentation** data —
 * the logo, the monogram, the display name, the ordering — and the
 * product still stores the brand *name* it was given. The two are kept in
 * agreement by canonicalising the name with the same `canonicalBrand`
 * the product path uses.
 *
 * So the product read is unchanged: no join, no extra column, no
 * migration of existing rows.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. Every write shares its transaction with its audit entry.**
 *
 * **2. Every update is conditional on the values the admin saw.**
 *
 * One winner, one 409 — the same rule as every other admin mutation.
 *
 * **3. The name is canonicalised at the write.**
 *
 * `Brand.name` is unique, and it is the string `Product.brand` holds. If
 * the admin typed "cerave" and the row was created as "cerave", the shop
 * would have a brand called "cerave" that no product carries, and a brand
 * called "CeraVe" that every product carries — two rows, one brand. So
 * the write folds the name to its registry spelling.
 *
 * **4. Deleting a brand does not touch the products that carry it.**
 *
 * `Product.brand` is a plain string, not a foreign key. Removing the
 * brand row removes the logo and the description; the products keep their
 * brand name, and they simply have no logo to show, because the
 * storefront falls back to the monogram.
 */

/**
 * A brand, as the admin list and the form see it.
 */
export type AdminBrand = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** The two-letter monogram shown when no logo is uploaded. */
  readonly monogram: string;
  /**
   * The logo's storage key, or `null`.
   *
   * A **key**, not a URL — "Storage adapter keys — NOT raw URLs, so the
   * driver can be swapped". A `null` logo means the storefront falls back
   * to the monogram.
   */
  readonly logo: string | null;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * The Prisma select for an admin brand.
 */
const ADMIN_BRAND_SELECT = {
  id: true,
  name: true,
  slug: true,
  monogram: true,
  logo: true,
  description: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BrandSelect;

/**
 * The brand fields the admin form may change.
 */
const EDITABLE_FIELDS = [
  "name",
  "slug",
  "monogram",
  "logo",
  "description",
  "sortOrder",
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Lists the brands for the admin panel.
 */
export async function listAdminBrands(
  query: AdminBrandQuery = { page: 1, limit: 20 },
): Promise<{
  readonly brands: AdminBrand[];
  readonly total: number;
  readonly pagination: {
    readonly page: number;
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
  };
}> {
  const where: Prisma.BrandWhereInput = {};

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { slug: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    db.brand.findMany({
      where,
      select: ADMIN_BRAND_SELECT,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.brand.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    brands: rows,
    total,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
  };
}

/**
 * Loads a single brand for the admin form.
 */
export async function getAdminBrand(brandId: string): Promise<AdminBrand> {
  const brand = await db.brand.findUnique({
    where: { id: brandId },
    select: ADMIN_BRAND_SELECT,
  });

  if (!brand) {
    throw ApiError.notFound("That brand does not exist.");
  }

  return brand;
}

/**
 * Creates a brand.
 *
 * The brand and its `BRAND_CREATED` audit entry are written in **one**
 * transaction.
 */
export async function createBrand(
  actor: AuditActor,
  input: BrandCreateInput,
): Promise<AdminBrand> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // The name is canonicalised **here**, at the write — not only in
      // the schema. The schema is a convenience; the service is where
      // every path to the database passes, and the guarantee that one
      // brand cannot exist under two spellings has to live there.
      const name = canonicalBrand(input.name) ?? input.name;

      const existing = await tx.brand.findFirst({
        where: { OR: [{ name }, { slug: input.slug }] },
        select: { id: true, name: true, slug: true },
      });

      if (existing) {
        throw ApiError.conflict(
          existing.name === name
            ? `The brand "${name}" already exists.`
            : "A brand with that slug already exists. Choose a different one.",
        );
      }

      const brand = await tx.brand.create({
        data: {
          name,
          slug: input.slug,
          monogram: input.monogram,
          logo: input.logo ?? null,
          description: input.description ?? null,
          sortOrder: input.sortOrder,
        },
        select: ADMIN_BRAND_SELECT,
      });

      await writeAuditEntry(tx, {
        actor,
        action: BRAND_ACTIONS.created,
        entityType: "brand",
        entityId: brand.id,
        before: null,
        after: {
          name: brand.name,
          slug: brand.slug,
          monogram: brand.monogram,
          logo: brand.logo,
          description: brand.description,
        },
        reason: null,
      });

      return brand;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Updates a brand.
 *
 * The update is **conditional on the values the admin saw**, so two
 * admins editing the same brand produce one winner and one 409.
 */
export async function updateBrand(
  actor: AuditActor,
  brandId: string,
  input: BrandUpdateInput,
): Promise<AdminBrand> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.brand.findUnique({
        where: { id: brandId },
        select: ADMIN_BRAND_SELECT,
      });

      if (!current) {
        throw ApiError.notFound("That brand does not exist.");
      }

      const touched = EDITABLE_FIELDS.filter(
        (field) => input[field] !== undefined,
      );

      if (touched.length === 0) {
        return current;
      }

      const data: Prisma.BrandUpdateInput = {};

      if (input.name !== undefined) {
        // Canonicalised at the write — the same guarantee as the create
        // path. A brand cannot end up spelled two ways.
        const name = canonicalBrand(input.name) ?? input.name;

        if (name !== current.name) {
          const clash = await tx.brand.findFirst({
            where: { name, id: { not: brandId } },
            select: { id: true },
          });

          if (clash) {
            throw ApiError.conflict(`The brand "${name}" already exists.`);
          }
        }

        data.name = name;
      }

      if (input.slug !== undefined && input.slug !== current.slug) {
        const clash = await tx.brand.findFirst({
          where: { slug: input.slug, id: { not: brandId } },
          select: { id: true },
        });

        if (clash) {
          throw ApiError.conflict(
            "A brand with that slug already exists. Choose a different one.",
          );
        }

        data.slug = input.slug;
      }

      if (input.monogram !== undefined) {
        data.monogram = input.monogram;
      }

      if (input.logo !== undefined) {
        // `null` clears the logo, and the storefront falls back to the
        // monogram. An absent field leaves it alone.
        data.logo = input.logo;
      }

      if (input.description !== undefined) {
        data.description = input.description;
      }

      if (input.sortOrder !== undefined) {
        data.sortOrder = input.sortOrder;
      }

      // ── The conditional update ─────────────────────────────────────
      const expectation: Prisma.BrandWhereInput = { id: brandId };

      for (const field of touched) {
        (expectation as Record<string, unknown>)[field] =
          current[field as keyof typeof current];
      }

      const updated = await tx.brand.updateMany({
        where: expectation,
        data,
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "This brand was changed by someone else while you were editing it. Reload and try again.",
        );
      }

      const after = await tx.brand.findUnique({
        where: { id: brandId },
        select: ADMIN_BRAND_SELECT,
      });

      if (!after) {
        throw ApiError.notFound("That brand does not exist.");
      }

      await writeAuditEntry(tx, {
        actor,
        action: BRAND_ACTIONS.updated,
        entityType: "brand",
        entityId: brandId,
        before: snapshot(current, touched),
        after: snapshot(after, touched),
        reason: null,
      });

      return after;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Deletes a brand.
 *
 * ── Why this does not touch the products ────────────────────────────────
 *
 * `Product.brand` is a plain string, not a foreign key, so there is
 * nothing to cascade to and nothing that can block the delete. The
 * products that carry this brand name keep it — they simply have no logo
 * to show, because the storefront falls back to the monogram.
 *
 * So the deletion removes the *brand presentation*, not the brand's
 * products. The reason is the record of why the shop stopped featuring
 * it.
 */
export async function deleteBrand(
  actor: AuditActor,
  brandId: string,
  reason: string,
): Promise<void> {
  await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const brand = await tx.brand.findUnique({
        where: { id: brandId },
        select: ADMIN_BRAND_SELECT,
      });

      if (!brand) {
        throw ApiError.notFound("That brand does not exist.");
      }

      await tx.brand.delete({ where: { id: brandId } });

      await writeAuditEntry(tx, {
        actor,
        action: BRAND_ACTIONS.deleted,
        entityType: "brand",
        entityId: brandId,
        before: {
          name: brand.name,
          slug: brand.slug,
          monogram: brand.monogram,
          logo: brand.logo,
          description: brand.description,
        },
        after: null,
        reason,
      });
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * The changed-field snapshot of a brand.
 *
 * Only the fields the edit actually touched are recorded.
 */
function snapshot(
  brand: {
    readonly name: string;
    readonly slug: string;
    readonly monogram: string;
    readonly logo: string | null;
    readonly description: string | null;
    readonly sortOrder: number;
  },
  fields: readonly EditableField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    result[field] = brand[field];
  }

  return result;
}
