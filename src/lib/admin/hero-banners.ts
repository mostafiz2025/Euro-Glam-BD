import { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import type {
  AdminHeroBannerQuery,
  HeroBannerCreateInput,
  HeroBannerUpdateInput,
} from "@/lib/validation/admin";

import {
  HERO_BANNER_ACTIONS,
  writeAuditEntry,
  type AuditActor,
} from "./audit";
import { deleteHeroBannerImage } from "./hero-images";

/**
 * The admin hero-banner service — create, update and delete.
 *
 * ── Why the hero needed a service at all ─────────────────────────────────
 *
 * The homepage carousel was a hard-coded array in
 * `src/components/home/hero-slides.ts`. Four slides, decided in code,
 * shipped with the code. An admin could not add a campaign, change a
 * headline, or retire a slide without a deploy — and the shop's *opening
 * line*, the one thing every customer sees, was not something the shop
 * could change without a developer.
 *
 * So the slides moved into the database. This service is the admin half
 * of that move; `listPublicHeroBanners` in
 * `src/lib/catalog/hero-banners.ts` is the storefront half.
 *
 * ── The rules that govern this module ───────────────────────────────────
 *
 * **1. Every write shares its transaction with its audit entry.**
 *
 * The same rule as every other admin mutation, and for the same reason:
 * the hero is the shop's opening line, so "who changed it and when" is a
 * question the shop must be able to answer.
 *
 * **2. Every update is conditional on the values the admin saw.**
 *
 * One winner, one 409 — the same rule as every other admin mutation.
 * Two admins editing the same banner produce one winner and one
 * conflict, not two silent overwrites.
 *
 * **3. Deleting a banner deletes its artwork.**
 *
 * A banner is the *only* thing that references its image. Nobody else
 * can be holding the same file — the upload endpoint writes one file
 * per request and hands back a key that only the banner that uploaded it
 * ever sees. So the file can go with the row, and it should: an orphan
 * in the upload directory is disk space nobody will ever reclaim.
 *
 * The file deletion happens **after** the transaction commits, and it is
 * best-effort. The row and its audit entry move together; the file is a
 * side effect of that, and a file that cannot be deleted is a cleanup
 * job's problem, not a reason to fail a request whose real work
 * succeeded.
 *
 * **4. A banner is switched off, not deleted, when a campaign ends.**
 *
 * `isActive` exists for that. The audit trail needs the row to still be
 * there to describe what happened to it.
 */

/**
 * A hero banner, as the admin list and the form see it.
 */
export type AdminHeroBanner = {
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly ctaHref: string;
  readonly secondaryCtaLabel: string;
  readonly secondaryCtaHref: string;
  readonly trust: string[];
  /**
   * The banner's background artwork — a **storage key**, or `null`.
   *
   * A key, not a URL, so the driver can be swapped for a bucket without
   * rewriting every row.
   */
  readonly image: string | null;
  readonly gradient: string;
  readonly glow: string;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * The Prisma select for an admin hero banner.
 */
const ADMIN_HERO_BANNER_SELECT = {
  id: true,
  eyebrow: true,
  title: true,
  body: true,
  ctaLabel: true,
  ctaHref: true,
  secondaryCtaLabel: true,
  secondaryCtaHref: true,
  trust: true,
  image: true,
  gradient: true,
  glow: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HeroBannerSelect;

/**
 * The banner fields the admin form may change.
 */
const EDITABLE_FIELDS = [
  "eyebrow",
  "title",
  "body",
  "ctaLabel",
  "ctaHref",
  "secondaryCtaLabel",
  "secondaryCtaHref",
  "trust",
  "image",
  "gradient",
  "glow",
  "isActive",
  "sortOrder",
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * Lists the banners for the admin panel.
 *
 * Ordered by `sortOrder` and then by creation time, so the carousel's
 * order is exactly the order the admin sees in the list. An admin who
 * drags nothing still gets a stable order.
 */
export async function listAdminHeroBanners(
  query: AdminHeroBannerQuery = { page: 1, limit: 20 },
): Promise<{
  readonly banners: AdminHeroBanner[];
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
  const where: Prisma.HeroBannerWhereInput = {};

  if (query.search) {
    where.OR = [
      { eyebrow: { contains: query.search, mode: "insensitive" } },
      { title: { contains: query.search, mode: "insensitive" } },
      { body: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    db.heroBanner.findMany({
      where,
      select: ADMIN_HERO_BANNER_SELECT,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    db.heroBanner.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    banners: rows,
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
 * Loads a single banner for the admin form.
 */
export async function getAdminHeroBanner(
  bannerId: string,
): Promise<AdminHeroBanner> {
  const banner = await db.heroBanner.findUnique({
    where: { id: bannerId },
    select: ADMIN_HERO_BANNER_SELECT,
  });

  if (!banner) {
    throw ApiError.notFound("That hero banner does not exist.");
  }

  return banner;
}

/**
 * Creates a banner.
 *
 * The banner and its `HERO_BANNER_CREATED` audit entry are written in
 * **one** transaction.
 */
export async function createHeroBanner(
  actor: AuditActor,
  input: HeroBannerCreateInput,
): Promise<AdminHeroBanner> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const banner = await tx.heroBanner.create({
        data: {
          eyebrow: input.eyebrow,
          title: input.title,
          body: input.body,
          ctaLabel: input.ctaLabel,
          ctaHref: input.ctaHref,
          secondaryCtaLabel: input.secondaryCtaLabel,
          secondaryCtaHref: input.secondaryCtaHref,
          trust: input.trust,
          image: input.image ?? null,
          gradient: input.gradient,
          glow: input.glow,
          isActive: input.isActive,
          sortOrder: input.sortOrder,
        },
        select: ADMIN_HERO_BANNER_SELECT,
      });

      await writeAuditEntry(tx, {
        actor,
        action: HERO_BANNER_ACTIONS.created,
        entityType: "hero_banner",
        entityId: banner.id,
        before: null,
        after: {
          eyebrow: banner.eyebrow,
          title: banner.title,
          ctaLabel: banner.ctaLabel,
          ctaHref: banner.ctaHref,
          image: banner.image,
          isActive: banner.isActive,
          sortOrder: banner.sortOrder,
        },
        reason: null,
      });

      return banner;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Updates a banner.
 *
 * The update is **conditional on the values the admin saw**, so two
 * admins editing the same banner produce one winner and one 409.
 */
export async function updateHeroBanner(
  actor: AuditActor,
  bannerId: string,
  input: HeroBannerUpdateInput,
): Promise<AdminHeroBanner> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const current = await tx.heroBanner.findUnique({
        where: { id: bannerId },
        select: ADMIN_HERO_BANNER_SELECT,
      });

      if (!current) {
        throw ApiError.notFound("That hero banner does not exist.");
      }

      const touched = EDITABLE_FIELDS.filter(
        (field) => input[field] !== undefined,
      );

      if (touched.length === 0) {
        return current;
      }

      const data: Prisma.HeroBannerUpdateInput = {};

      if (input.eyebrow !== undefined) data.eyebrow = input.eyebrow;
      if (input.title !== undefined) data.title = input.title;
      if (input.body !== undefined) data.body = input.body;
      if (input.ctaLabel !== undefined) data.ctaLabel = input.ctaLabel;
      if (input.ctaHref !== undefined) data.ctaHref = input.ctaHref;

      if (input.secondaryCtaLabel !== undefined) {
        data.secondaryCtaLabel = input.secondaryCtaLabel;
      }

      if (input.secondaryCtaHref !== undefined) {
        data.secondaryCtaHref = input.secondaryCtaHref;
      }

      if (input.trust !== undefined) data.trust = input.trust;

      // `null` clears the artwork. An absent field leaves it alone.
      if (input.image !== undefined) data.image = input.image;

      if (input.gradient !== undefined) data.gradient = input.gradient;
      if (input.glow !== undefined) data.glow = input.glow;

      if (input.isActive !== undefined) data.isActive = input.isActive;
      if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

      // ── The conditional update ─────────────────────────────────────
      const expectation: Prisma.HeroBannerWhereInput = { id: bannerId };

      for (const field of touched) {
        if (field === "trust") {
          expectation.trust = { equals: current.trust };
        } else {
          (expectation as Record<string, unknown>)[field] =
            current[field as keyof typeof current];
        }
      }

      const updated = await tx.heroBanner.updateMany({
        where: expectation,
        data,
      });

      if (updated.count === 0) {
        throw ApiError.conflict(
          "This banner was changed by someone else while you were editing it. Reload and try again.",
        );
      }

      const after = await tx.heroBanner.findUnique({
        where: { id: bannerId },
        select: ADMIN_HERO_BANNER_SELECT,
      });

      if (!after) {
        throw ApiError.notFound("That hero banner does not exist.");
      }

      await writeAuditEntry(tx, {
        actor,
        action: HERO_BANNER_ACTIONS.updated,
        entityType: "hero_banner",
        entityId: bannerId,
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
 * Deletes a banner.
 *
 * The row and its audit entry move together. The artwork is removed
 * afterwards, on a best-effort basis — see the note at the top of this
 * file.
 */
export async function deleteHeroBanner(
  actor: AuditActor,
  bannerId: string,
  reason: string,
): Promise<void> {
  let artwork: string | null = null;

  await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const banner = await tx.heroBanner.findUnique({
        where: { id: bannerId },
        select: ADMIN_HERO_BANNER_SELECT,
      });

      if (!banner) {
        throw ApiError.notFound("That hero banner does not exist.");
      }

      artwork = banner.image;

      await tx.heroBanner.delete({ where: { id: bannerId } });

      await writeAuditEntry(tx, {
        actor,
        action: HERO_BANNER_ACTIONS.deleted,
        entityType: "hero_banner",
        entityId: bannerId,
        before: {
          eyebrow: banner.eyebrow,
          title: banner.title,
          ctaLabel: banner.ctaLabel,
          ctaHref: banner.ctaHref,
          image: banner.image,
          isActive: banner.isActive,
          sortOrder: banner.sortOrder,
        },
        after: null,
        reason,
      });
    },
    { maxWait: 5_000, timeout: 10_000 },
  );

  /*
    The artwork goes after the transaction commits.

    Inside the transaction it would be the wrong order: a file deleted
    first and a transaction that then rolls back would leave a live
    banner pointing at a file that no longer exists. After the commit,
    the worst case is an orphaned file — disk space for a cleanup job —
    rather than a broken storefront.
  */
  if (artwork) {
    await deleteHeroBannerImage(artwork);
  }
}

/**
 * The changed-field snapshot of a banner.
 *
 * Only the fields the edit actually touched are recorded.
 */
function snapshot(
  banner: {
    readonly eyebrow: string;
    readonly title: string;
    readonly body: string;
    readonly ctaLabel: string;
    readonly ctaHref: string;
    readonly secondaryCtaLabel: string;
    readonly secondaryCtaHref: string;
    readonly trust: string[];
    readonly image: string | null;
    readonly gradient: string;
    readonly glow: string;
    readonly isActive: boolean;
    readonly sortOrder: number;
  },
  fields: readonly EditableField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    result[field] = banner[field];
  }

  return result;
}
