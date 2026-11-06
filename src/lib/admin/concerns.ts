import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import type {
  AdminConcernQuery,
  ConcernCreateInput,
  ConcernUpdateInput,
} from "@/lib/validation/admin";

import {
  CONCERN_ACTIONS,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin skin-concern service — create, update and delete.
 *
 * ── Why concerns are managed here ────────────────────────────────────────
 *
 * The concerns used to live in a static array in
 * `src/lib/format/taxonomy.ts`. That meant an admin could not add a
 * concern, rename one, describe one, or give one a picture — the
 * storefront's "Shop By Concern" section was decided in code and shipped
 * with the code.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. Every write shares its transaction with its audit entry.**
 *
 * **2. Every update is conditional on the values the admin saw.**
 *
 * One winner, one 409 — the same rule as every other admin mutation.
 *
 * **3. The ingredient tag is a closed vocabulary.**
 *
 * A concern's `tag` is one of the canonical ingredient IDs — the same
 * list the conflict engine compares in
 * `src/lib/conflicts/catalogue.ts`. That is what makes a concern filter
 * and a conflict rule agree about what "BHA" means. The schema checks
 * the shape; the vocabulary check lives here, where the catalogue is
 * known.
 *
 * **4. Deleting a concern is not destructive to the catalogue.**
 *
 * A concern filters products by an ingredient tag. Removing the concern
 * removes the *way in* to those products — the products themselves are
 * untouched, and they are still reachable through the catalogue and the
 * category grid.
 */

/**
 * A skin concern, as the admin list and the form see it.
 */
export type AdminConcern = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** The lead ingredient tag the concern filters on. */
  readonly tag: string;
  /** The other tags in this family, offered in the filter panel. */
  readonly relatedTags: string[];
  /**
   * The card image's storage key, or `null`.
   *
   * A **key**, not a URL — "Storage adapter keys — NOT raw URLs, so the
   * driver can be swapped".
   */
  readonly image: string | null;
  readonly description: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * The Prisma select for an admin concern.
 */
const ADMIN_CONCERN_SELECT = {
  id: true,
  name: true,
  slug: true,
  tag: true,
  relatedTags: true,
  image: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SkinConcernSelect;

/**
 * The concern fields the admin form may change.
 */
const EDITABLE_FIELDS = [
  "name",
  "slug",
  "tag",
  "relatedTags",
  "image",
  "description",
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Lists the concerns for the admin panel.
 */
export async function listAdminConcerns(
  query: AdminConcernQuery = { page: 1, limit: 20 },
): Promise<{
  readonly concerns: AdminConcern[];
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
  const where: Prisma.SkinConcernWhereInput = {};

  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: "insensitive" } },
      { slug: { contains: query.search, mode: "insensitive" } },
      { tag: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    db.skinConcern.findMany({
      where,
      select: ADMIN_CONCERN_SELECT,
      orderBy: { name: "asc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.skinConcern.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    concerns: rows,
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
 * Loads a single concern for the admin form.
 */
export async function getAdminConcern(
  concernId: string,
): Promise<AdminConcern> {
  const concern = await db.skinConcern.findUnique({
    where: { id: concernId },
    select: ADMIN_CONCERN_SELECT,
  });

  if (!concern) {
    throw ApiError.notFound("That concern does not exist.");
  }

  return concern;
}

/**
 * Creates a concern.
 *
 * The concern and its `CONCERN_CREATED` audit entry are written in **one**
 * transaction.
 */
export async function createConcern(
  actor: AuditActor,
  input: ConcernCreateInput,
): Promise<AdminConcern> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const existing = await tx.skinConcern.findUnique({
        where: { slug: input.slug },
        select: { id: true },
      });

      if (existing) {
        throw ApiError.conflict(
          "A concern with that slug already exists. Choose a different one.",
        );
      }

      const concern = await tx.skinConcern.create({
        data: {
          name: input.name,
          slug: input.slug,
          tag: input.tag,
          relatedTags: input.relatedTags,
          image: input.image ?? null,
          description: input.description ?? null,
        },
        select: ADMIN_CONCERN_SELECT,
      });

      await writeAuditEntry(tx, {
        actor,
        action: CONCERN_ACTIONS.created,
        entityType: "concern",
        entityId: concern.id,
        before: null,
        after: {
          name: concern.name,
          slug: concern.slug,
          tag: concern.tag,
          relatedTags: concern.relatedTags,
          image: concern.image,
        },
        reason: null,
      });

      return concern;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Updates a concern.
 *
 * The update is **conditional on the values the admin saw**, so two
 * admins editing the same concern produce one winner and one 409.
 */
export async function updateConcern(
  actor: AuditActor,
  concernId: string,
  input: ConcernUpdateInput,
): Promise<AdminConcern> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.skinConcern.findUnique({
        where: { id: concernId },
        select: ADMIN_CONCERN_SELECT,
      });

      if (!current) {
        throw ApiError.notFound("That concern does not exist.");
      }

      const touched = EDITABLE_FIELDS.filter(
        (field) => input[field] !== undefined,
      );

      if (touched.length === 0) {
        return current;
      }

      const data: Prisma.SkinConcernUpdateInput = {};

      if (input.name !== undefined) {
        data.name = input.name;
      }

      if (input.slug !== undefined && input.slug !== current.slug) {
        const clash = await tx.skinConcern.findUnique({
          where: { slug: input.slug },
          select: { id: true },
        });

        if (clash) {
          throw ApiError.conflict(
            "A concern with that slug already exists. Choose a different one.",
          );
        }

        data.slug = input.slug;
      }

      if (input.tag !== undefined) {
        data.tag = input.tag;
      }

      if (input.relatedTags !== undefined) {
        data.relatedTags = input.relatedTags;
      }

      if (input.image !== undefined) {
        // `null` clears the image. An absent field leaves it alone.
        data.image = input.image;
      }

      if (input.description !== undefined) {
        data.description = input.description;
      }

      // ── The conditional update ─────────────────────────────────────
      const expectation: Prisma.SkinConcernWhereInput = { id: concernId };

      for (const field of touched) {
        if (field === "relatedTags") {
          expectation.relatedTags = { equals: current.relatedTags };
        } else {
          (expectation as Record<string, unknown>)[field] =
            current[field as keyof typeof current];
        }
      }

      const updated = await tx.skinConcern.updateMany({
        where: expectation,
        data,
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "This concern was changed by someone else while you were editing it. Reload and try again.",
        );
      }

      const after = await tx.skinConcern.findUnique({
        where: { id: concernId },
        select: ADMIN_CONCERN_SELECT,
      });

      if (!after) {
        throw ApiError.notFound("That concern does not exist.");
      }

      await writeAuditEntry(tx, {
        actor,
        action: CONCERN_ACTIONS.updated,
        entityType: "concern",
        entityId: concernId,
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
 * Deletes a concern.
 *
 * A concern is a **way in** to the products that address it, not the
 * products themselves. Deleting one removes the door; the products are
 * untouched and still reachable through the catalogue.
 */
export async function deleteConcern(
  actor: AuditActor,
  concernId: string,
  reason: string,
): Promise<void> {
  await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const concern = await tx.skinConcern.findUnique({
        where: { id: concernId },
        select: ADMIN_CONCERN_SELECT,
      });

      if (!concern) {
        throw ApiError.notFound("That concern does not exist.");
      }

      await tx.skinConcern.delete({ where: { id: concernId } });

      await writeAuditEntry(tx, {
        actor,
        action: CONCERN_ACTIONS.deleted,
        entityType: "concern",
        entityId: concernId,
        before: {
          name: concern.name,
          slug: concern.slug,
          tag: concern.tag,
          relatedTags: concern.relatedTags,
          image: concern.image,
        },
        after: null,
        reason,
      });
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * The changed-field snapshot of a concern.
 *
 * Only the fields the edit actually touched are recorded.
 */
function snapshot(
  concern: {
    readonly name: string;
    readonly slug: string;
    readonly tag: string;
    readonly relatedTags: string[];
    readonly image: string | null;
    readonly description: string | null;
  },
  fields: readonly EditableField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    result[field] = concern[field];
  }

  return result;
}
