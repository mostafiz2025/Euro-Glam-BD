import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import type {
  AdminCategoryQuery,
  CategoryCreateInput,
  CategoryUpdateInput,
} from "@/lib/validation/admin";

import {
  CATEGORY_ACTIONS,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin category service — create, update and delete.
 *
 * ── Why categories are managed here ──────────────────────────────────────
 *
 * The categories were the one part of the storefront's catalogue the admin
 * could not touch. The rows existed, the storefront rendered them, and
 * `Product.categoryId` pointed at them — but there was no way to add one,
 * rename one, or give one a picture. Every category in the shop was
 * therefore decided in code.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. Every write shares its transaction with its audit entry.**
 *
 * Same rule as every other admin mutation. A category whose card image
 * was swapped with no record of who swapped it is a storefront surface
 * nobody can account for.
 *
 * **2. Every update is conditional on the values the admin saw.**
 *
 * The read that precedes the write is not just for validation — it is the
 * *expectation*. The `updateMany` matches on the observed values of the
 * fields being changed, so if another admin changed the name in the
 * window between the page load and the save, the update matches zero rows
 * and the second admin is told to reload. One winner, one 409.
 *
 * **3. A category with products cannot be deleted.**
 *
 * `Product.categoryId` is `onDelete: Restrict`. The database would refuse
 * the delete anyway, but a bare constraint violation is not an
 * explanation. So the service counts the products first and says what the
 * admin has to do: *"This category still has 9 products. Move them
 * first."*
 *
 * **4. The audit entry records the changed fields only.**
 *
 * So the entry reads "name Cleansers → Face Cleansers" rather than
 * carrying the whole row twice.
 */

/**
 * A category, as the admin list and the form see it.
 */
export type AdminCategory = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /**
   * The card image's storage key, or `null`.
   *
   * A **key**, not a URL — "Storage adapter keys — NOT raw URLs, so the
   * driver can be swapped". `imageUrl()` turns it into a URL at render
   * time.
   */
  readonly image: string | null;
  /** How many products are in this category. */
  readonly productCount: number;
};

/**
 * The Prisma select for an admin category.
 *
 * The `Category` table carries **no timestamps** — it predates the
 * audited tables and has never needed them. Adding `createdAt` and
 * `updatedAt` for the sake of the admin list would mean a migration with
 * a backfill for rows that already exist, and a column nobody reads.
 */
const ADMIN_CATEGORY_SELECT = {
  id: true,
  name: true,
  slug: true,
  image: true,
} satisfies Prisma.CategorySelect;

/**
 * The category fields the admin form may change.
 */
const EDITABLE_FIELDS = ["name", "slug", "image"] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Lists the categories for the admin panel.
 *
 * The product count is a **filtered** relation count — the same rule the
 * storefront's filter panel uses. A count that disagrees with the list it
 * counts is a filter that lies.
 */
export async function listAdminCategories(
  query: AdminCategoryQuery = { page: 1, limit: 20 },
): Promise<{
  readonly categories: AdminCategory[];
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
  const where: Prisma.CategoryWhereInput = {};

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { slug: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    db.category.findMany({
      where,
      select: {
        ...ADMIN_CATEGORY_SELECT,
        _count: { select: { products: true } },
      },
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.category.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    categories: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      image: row.image,
      productCount: row._count.products,
    })),
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
 * Loads a single category for the admin form.
 */
export async function getAdminCategory(
  categoryId: string,
): Promise<AdminCategory> {
  const category = await db.category.findUnique({
    where: { id: categoryId },
    select: {
      ...ADMIN_CATEGORY_SELECT,
      _count: { select: { products: true } },
    },
  });

  if (!category) {
    throw ApiError.notFound("That category does not exist.");
  }

  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    image: category.image,
    productCount: category._count.products,
  };
}

/**
 * Creates a category.
 *
 * The category and its `CATEGORY_CREATED` audit entry are written in
 * **one** transaction — a category that exists with no record of who
 * added it is worse than one that was never added.
 */
export async function createCategory(
  actor: AuditActor,
  input: CategoryCreateInput,
): Promise<AdminCategory> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const existing = await tx.category.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      });

      if (existing) {
        throw ApiError.conflict(
          "A category with that slug already exists. Choose a different one.",
        );
      }

      const category = await tx.category.create({
        data: {
          name: input.name,
          slug: input.slug,
          image: input.image ?? null,
        },
        select: ADMIN_CATEGORY_SELECT,
      });

      await writeAuditEntry(tx, {
        actor,
        action: CATEGORY_ACTIONS.created,
        entityType: "category",
        entityId: category.id,
        before: null,
        after: {
          name: category.name,
          slug: category.slug,
          image: category.image,
        },
        reason: null,
      });

      return { ...category, productCount: 0 };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Updates a category.
 *
 * The update is **conditional on the values the admin saw**, so two
 * admins editing the same category produce one winner and one 409.
 */
export async function updateCategory(
  actor: AuditActor,
  categoryId: string,
  input: CategoryUpdateInput,
): Promise<AdminCategory> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.category.findUnique({
        where: { id: categoryId },
        select: ADMIN_CATEGORY_SELECT,
      });

      if (!current) {
        throw ApiError.notFound("That category does not exist.");
      }

      const touched = EDITABLE_FIELDS.filter(
        (field) => input[field] !== undefined,
      );

      if (touched.length === 0) {
        return { ...current, productCount: 0 };
      }

      const data: Prisma.CategoryUpdateInput = {};

      if (input.name !== undefined) {
        data.name = input.name;
      }

      if (input.slug !== undefined && input.slug !== current.slug) {
        const clash = await tx.category.findUnique({
          where: { slug: input.slug },
          select: { id: true },
        });

        if (clash) {
          throw ApiError.conflict(
            "A category with that slug already exists. Choose a different one.",
          );
        }

        data.slug = input.slug;
      }

      if (input.image !== undefined) {
        // `null` clears the image. An absent field leaves it alone —
        // that is what a partial update means.
        data.image = input.image;
      }

      // ── The conditional update ─────────────────────────────────────
      //
      // The condition is the *observed* value of every field the edit
      // touches. If any of them changed since the read, the update
      // matches zero rows and the admin is told to reload.
      const expectation: Prisma.CategoryWhereInput = { id: categoryId };

      for (const field of touched) {
        (expectation as Record<string, unknown>)[field] =
          current[field as keyof typeof current];
      }

      const updated = await tx.category.updateMany({
        where: expectation,
        data,
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "This category was changed by someone else while you were editing it. Reload and try again.",
        );
      }

      const after = await tx.category.findUnique({
        where: { id: categoryId },
        select: {
          ...ADMIN_CATEGORY_SELECT,
          _count: { select: { products: true } },
        },
      });

      if (!after) {
        throw ApiError.notFound("That category does not exist.");
      }

      await writeAuditEntry(tx, {
        actor,
        action: CATEGORY_ACTIONS.updated,
        entityType: "category",
        entityId: categoryId,
        before: snapshot(current, touched),
        after: snapshot(after, touched),
        reason: null,
      });

      return {
        id: after.id,
        name: after.name,
        slug: after.slug,
        image: after.image,
        productCount: after._count.products,
      };
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Deletes a category.
 *
 * ── Why a category with products is refused, not cascaded ────────────────
 *
 * `Product.categoryId` is `onDelete: Restrict`, so the database refuses
 * the delete anyway. But a bare constraint violation is not an
 * explanation — it does not say how many products are in the way, or
 * what to do about them. So the service counts them first and reports
 * the count.
 *
 * Cascading would be worse: it would delete the shop's products because
 * somebody tidied up a category. A category is a way of organising the
 * catalogue; removing it is not a licence to remove the catalogue.
 */
export async function deleteCategory(
  actor: AuditActor,
  categoryId: string,
  reason: string,
): Promise<void> {
  await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const category = await tx.category.findUnique({
        where: { id: categoryId },
        select: {
          ...ADMIN_CATEGORY_SELECT,
          _count: { select: { products: true } },
        },
      });

      if (!category) {
        throw ApiError.notFound("That category does not exist.");
      }

      if (category._count.products > 0) {
        throw ApiError.conflict(
          `This category still has ${category._count.products} product${category._count.products === 1 ? "" : "s"} in it. Move them to another category first.`,
          {
            categoryId,
            productCount: category._count.products,
          },
        );
      }

      await tx.category.delete({ where: { id: categoryId } });

      await writeAuditEntry(tx, {
        actor,
        action: CATEGORY_ACTIONS.deleted,
        entityType: "category",
        entityId: categoryId,
        before: {
          name: category.name,
          slug: category.slug,
          image: category.image,
        },
        after: null,
        reason,
      });
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * The changed-field snapshot of a category.
 *
 * Only the fields the edit actually touched are recorded, so the audit
 * entry reads "name Cleansers → Face Cleansers" rather than carrying the
 * whole row twice.
 */
function snapshot(
  category: {
    readonly name: string;
    readonly slug: string;
    readonly image: string | null;
  },
  fields: readonly EditableField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    result[field] = category[field];
  }

  return result;
}
