import { CouponDiscountType, Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { db } from "@/lib/db";
import {
  couponStatus,
  normaliseCouponCode,
  type CouponStatus,
} from "@/lib/coupons/rules";

import {
  COUPON_ACTIONS,
  writeAuditEntry,
  type AuditActor,
} from "./audit";

/**
 * The admin coupon service.
 *
 * ── What a coupon is ──────────────────────────────────────────────────────
 *
 * A coupon is a **commercial decision with a monetary value**. "Twenty
 * percent off" is not a feature — it is a price reduction that changes
 * what the customer pays. So it is treated like a price change: it is
 * validated strictly, it requires a reason, and it is audited.
 *
 * ── Why the terms live in columns, not in code ────────────────────────────
 *
 * The percentage and the fixed amount are **separate columns**, one of
 * which is always null. A single `value` column would make "20" mean
 * 20% in one row and ৳20 in another, and the reader would have to know
 * which. Two columns cannot be misread.
 *
 * Money is integer poisha everywhere in this codebase (1 BDT = 100
 * poisha). A float taka amount would introduce a second unit into a
 * system that has exactly one, and the rounding would not be ours.
 *
 * ── Why `usageLimit` is nullable ───────────────────────────────────────────
 *
 * Null means "no limit". Zero would mean "nobody may use this", which
 * is a different thing — and an accidental zero would silently kill a
 * campaign.
 *
 * ── Why the code is normalised to uppercase ────────────────────────────────
 *
 * A customer typing "eid2026" and one typing "EID2026" mean the same
 * coupon. Storing the uppercase form and relying on the unique
 * constraint means the two cannot become two coupons. The service
 * normalises on the way in; the client never has to remember to.
 *
 * ── Why the audit entry records the changed fields only ───────────────────
 *
 * The same rule the product catalogue follows: the log should read
 * "percentOff 10 → 20", not reproduce the whole row on every save. A
 * trail that dumps everything is a trail nobody reads.
 */
export type AdminCoupon = {
  readonly id: string;
  readonly code: string;
  readonly description: string | null;
  readonly discountType: CouponDiscountType;
  readonly percentOff: number | null;
  readonly amountOffPaisa: number | null;
  readonly expiresAt: Date;
  readonly usageLimit: number | null;
  readonly usageCount: number;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * The coupon fields an admin may change.
 */
export type CouponPatch = {
  readonly description?: string | null;
  readonly discountType?: CouponDiscountType;
  readonly percentOff?: number | null;
  readonly amountOffPaisa?: number | null;
  readonly expiresAt?: Date;
  readonly usageLimit?: number | null;
  readonly isActive?: boolean;
  readonly reason?: string;
};

/**
 * The Prisma select for a coupon.
 */
const COUPON_SELECT = {
  id: true,
  code: true,
  description: true,
  discountType: true,
  percentOff: true,
  amountOffPaisa: true,
  expiresAt: true,
  usageLimit: true,
  usageCount: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CouponSelect;

/**
 * The coupon list result.
 */
export type AdminCouponListResult = {
  readonly coupons: readonly AdminCoupon[];
  readonly pagination: {
    readonly page: number;
    readonly limit: number;
    readonly total: number;
    readonly totalPages: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
  };
  readonly counts: {
    readonly total: number;
    readonly active: number;
    readonly expired: number;
    readonly exhausted: number;
  };
};

/**
 * Whether a coupon is currently redeemable.
 *
 * Three reasons a coupon cannot be used, and they are **different
 * facts** an admin needs to tell apart:
 *
 *   • **Inactive** — an admin switched it off.
 *   • **Expired** — the clock ran out.
 *   • **Exhausted** — the usage limit was reached.
 *
 * Collapsing them into "not valid" would leave an admin unable to answer
 * "why is this code being rejected?" — which is the only question they
 * are looking at the page to answer.
 *
 * ── Why it is re-exported rather than defined here ───────────────────────
 *
 * The rule now lives in `@/lib/coupons/rules`, because the **shopfront**
 * has to make the same judgement when a customer types a code at
 * checkout. One implementation, two callers — so the admin panel and the
 * checkout can never disagree about whether a code works.
 *
 * It is re-exported from here so the admin panel's existing imports keep
 * working and the panel's vocabulary stays in one place.
 */
export type { CouponStatus };

export { couponStatus, normaliseCouponCode };

/**
 * Validates a coupon's terms.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 *   • A `PERCENTAGE` coupon has a percentage and no fixed amount.
 *   • A `FIXED` coupon has a fixed amount and no percentage.
 *   • The percentage is 1–100. Zero would be a coupon worth nothing;
 *     more than 100 would be a coupon worth more than the order.
 *   • The fixed amount is positive.
 *   • The expiry is in the future.
 *
 * The two-columns-one-null rule is enforced **in the service**, not only
 * in the schema. A rule that lives only in the schema can be bypassed by
 * any other caller of the table; a rule that lives in the service is
 * enforced for every caller.
 */
function validateTerms(terms: {
  readonly discountType: CouponDiscountType;
  readonly percentOff: number | null;
  readonly amountOffPaisa: number | null;
  readonly expiresAt: Date;
  readonly usageLimit: number | null;
}): void {
  if (terms.discountType === CouponDiscountType.PERCENTAGE) {
    if (terms.percentOff === null) {
      throw ApiError.validation(
        "A percentage coupon needs a percentage.",
        { fieldErrors: { percentOff: ["Enter the percentage to take off."] } },
      );
    }

    if (terms.amountOffPaisa !== null) {
      throw ApiError.validation(
        "A percentage coupon cannot also have a fixed amount.",
        {
          fieldErrors: {
            amountOffPaisa: ["Clear the fixed amount — this coupon is a percentage."],
          },
        },
      );
    }

    if (terms.percentOff < 1 || terms.percentOff > 100) {
      throw ApiError.validation(
        "The percentage must be between 1 and 100.",
        { fieldErrors: { percentOff: ["Use a whole number from 1 to 100."] } },
      );
    }
  }

  if (terms.discountType === CouponDiscountType.FIXED) {
    if (terms.amountOffPaisa === null) {
      throw ApiError.validation(
        "A fixed-amount coupon needs an amount.",
        {
          fieldErrors: {
            amountOffPaisa: ["Enter the amount to take off."],
          },
        },
      );
    }

    if (terms.percentOff !== null) {
      throw ApiError.validation(
        "A fixed-amount coupon cannot also have a percentage.",
        {
          fieldErrors: {
            percentOff: ["Clear the percentage — this coupon is a fixed amount."],
          },
        },
      );
    }

    if (terms.amountOffPaisa <= 0) {
      throw ApiError.validation(
        "The amount must be more than zero.",
        {
          fieldErrors: {
            amountOffPaisa: ["Enter an amount greater than zero."],
          },
        },
      );
    }
  }

  if (terms.expiresAt.getTime() <= Date.now()) {
    throw ApiError.validation(
      "The expiry date must be in the future.",
      { fieldErrors: { expiresAt: ["Choose a date after today."] } },
    );
  }

  if (terms.usageLimit !== null && terms.usageLimit < 1) {
    throw ApiError.validation(
      "The usage limit must be at least 1.",
      {
        fieldErrors: {
          usageLimit: ["Use 1 or more — or leave it empty for no limit."],
        },
      },
    );
  }
}

/**
 * The fields that differ between two coupon snapshots.
 *
 * Only the fields that actually changed are recorded, so the audit entry
 * reads "percentOff 10 → 20" rather than reproducing the whole row.
 */
function diffCoupon(
  before: AdminCoupon,
  after: AdminCoupon,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const beforeFields: Record<string, unknown> = {};
  const afterFields: Record<string, unknown> = {};

  const compare = (
    field: keyof AdminCoupon,
    equal: (a: unknown, b: unknown) => boolean,
  ): void => {
    if (equal(before[field], after[field])) return;

    beforeFields[field] = before[field] ?? null;
    afterFields[field] = after[field] ?? null;
  };

  compare("description", (a, b) => a === b);
  compare("discountType", (a, b) => a === b);
  compare("percentOff", (a, b) => a === b);
  compare("amountOffPaisa", (a, b) => a === b);
  compare("expiresAt", (a, b) => {
    const left = a instanceof Date ? a.getTime() : null;
    const right = b instanceof Date ? b.getTime() : null;

    return left === right;
  });
  compare("usageLimit", (a, b) => a === b);
  compare("isActive", (a, b) => a === b);

  return { before: beforeFields, after: afterFields };
}

/**
 * Lists the coupons for the admin panel.
 *
 * The counts are computed over the **whole** table, while the pagination
 * total counts only what the current filter matched — the two answer
 * different questions, and neither is derived from the other. This is
 * the same relationship the inventory list and the user list have.
 */
export async function listAdminCoupons(query: {
  readonly search?: string;
  readonly page: number;
  readonly limit: number;
}): Promise<AdminCouponListResult> {
  const where: Prisma.CouponWhereInput = query.search
    ? {
        code: {
          contains: query.search.trim().toUpperCase(),
          mode: "insensitive",
        },
      }
    : {};

  const skip = (query.page - 1) * query.limit;

  const [rows, total, all, active, expired, exhausted] = await Promise.all([
    db.coupon.findMany({
      where,
      select: COUPON_SELECT,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take: query.limit,
    }),
    db.coupon.count({ where }),
    db.coupon.count(),
    db.coupon.count({ where: { isActive: true } }),
    db.coupon.count({ where: { expiresAt: { lte: new Date() } } }),
    /*
     * An exhausted coupon is one whose `usageCount` has reached its
     * `usageLimit` — a comparison **between two columns of the same
     * row**, which Prisma's filter API cannot express.
     *
     * So this one count runs as raw SQL. The query has no user input
     * in it at all, so there is nothing to parameterise and nothing to
     * inject. The `usageLimit IS NOT NULL` guard is what makes the
     * comparison meaningful: a coupon with no limit has NULL there,
     * and `usageCount >= NULL` is never true, so the guard is
     * belt-and-braces rather than load-bearing.
     */
    db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM coupons
      WHERE "usageLimit" IS NOT NULL
        AND "usageCount" >= "usageLimit"
    `,
  ]);

  const totalPages = Math.max(1, Math.ceil(total / query.limit));

  return {
    coupons: rows,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages,
      hasNextPage: query.page < totalPages,
      hasPreviousPage: query.page > 1,
    },
    counts: {
      total: all,
      active,
      expired,
      // The raw query returns a `BigInt`, which Prisma surfaces as a
      // `BigInt` object. `Number()` converts it — safe here, because it
      // is a count.
      exhausted: Number(exhausted[0]?.count ?? 0),
    },
  };
}

/**
 * Reads one coupon.
 */
export async function getAdminCoupon(
  couponId: string,
): Promise<AdminCoupon | null> {
  return db.coupon.findUnique({
    where: { id: couponId },
    select: COUPON_SELECT,
  });
}

/**
 * Creates a coupon, atomically with its audit entry.
 *
 * @param actor - The admin making the change.
 * @param input - The coupon's terms.
 *
 * @throws ApiError 400 when the terms are invalid.
 * @throws ApiError 409 when the code is already taken.
 */
export async function createCoupon(
  actor: AuditActor,
  input: {
    readonly code: string;
    readonly description?: string | null;
    readonly discountType: CouponDiscountType;
    readonly percentOff?: number | null;
    readonly amountOffPaisa?: number | null;
    readonly expiresAt: Date;
    readonly usageLimit?: number | null;
    readonly isActive?: boolean;
    readonly reason?: string;
  },
): Promise<AdminCoupon> {
  const code = normaliseCouponCode(input.code);

  validateTerms({
    discountType: input.discountType,
    percentOff: input.percentOff ?? null,
    amountOffPaisa: input.amountOffPaisa ?? null,
    expiresAt: input.expiresAt,
    usageLimit: input.usageLimit ?? null,
  });

  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      /*
       * The uniqueness check is done **inside** the transaction, and it
       * is a read rather than a blind insert, so the error message can
       * name the code that is already taken.
       *
       * The unique constraint on `code` is still the real guarantee —
       * two admins creating the same code at the same moment would both
       * pass this read, and the constraint would reject the second. This
       * read turns the common case into a clear message; the constraint
       * turns the race into a 409. Neither is relied on alone.
       */
      const existing = await tx.coupon.findUnique({
        where: { code },
        select: { id: true },
      });

      if (existing) {
        throw ApiError.conflict(`The code ${code} is already in use.`, {
          fieldErrors: { code: ["That code already exists."] },
        });
      }

      const created = await tx.coupon.create({
        data: {
          code,
          description: input.description?.trim() || null,
          discountType: input.discountType,
          percentOff:
            input.discountType === CouponDiscountType.PERCENTAGE
              ? (input.percentOff ?? null)
              : null,
          amountOffPaisa:
            input.discountType === CouponDiscountType.FIXED
              ? (input.amountOffPaisa ?? null)
              : null,
          expiresAt: input.expiresAt,
          usageLimit: input.usageLimit ?? null,
          isActive: input.isActive ?? true,
        },
        select: COUPON_SELECT,
      });

      await writeAuditEntry(tx, {
        actor,
        action: COUPON_ACTIONS.created,
        entityType: "coupon",
        entityId: created.id,
        before: null,
        // The whole row on creation — there is no "before" to diff
        // against, and the terms are the thing worth recording.
        after: {
          code: created.code,
          description: created.description,
          discountType: created.discountType,
          percentOff: created.percentOff,
          amountOffPaisa: created.amountOffPaisa,
          expiresAt: created.expiresAt.toISOString(),
          usageLimit: created.usageLimit,
          isActive: created.isActive,
        },
        reason: input.reason?.trim() || null,
      });

      return created;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Updates a coupon, atomically with its audit entry.
 *
 * A **partial** update: a field that is absent is left exactly as it
 * was. And a change to the **discount terms** requires a reason — the
 * terms are a price reduction, and "why" is part of the record. The
 * same rule the product price change follows.
 */
export async function updateCoupon(
  actor: AuditActor,
  couponId: string,
  patch: CouponPatch,
): Promise<AdminCoupon> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const existing = await tx.coupon.findUnique({
        where: { id: couponId },
        select: COUPON_SELECT,
      });

      if (!existing) {
        throw ApiError.notFound("That coupon does not exist.");
      }

      const discountType =
        patch.discountType ?? existing.discountType;

      /*
       * The two discount columns are **mutually exclusive**, and a
       * change of type is the moment that exclusivity has to be
       * re-established.
       *
       * The naive merge — "take the patched value, or the old one" —
       * would carry the old `percentOff` into a FIXED coupon, and the
       * merged terms would then be rejected as "a fixed-amount coupon
       * cannot also have a percentage". That would make a type change
       * impossible, which is the wrong answer: the coupon's own
       * contract says a type change clears the column that no longer
       * applies.
       *
       * So when the type moves, the column that no longer applies is
       * dropped **before** the merge, and the patch's value for it —
       * if the caller supplied one — is honoured. The result is that a
       * type change always lands on a coherent row.
       */
      const typeChanged = discountType !== existing.discountType;

      const percentOff =
        discountType === CouponDiscountType.FIXED
          ? null
          : patch.percentOff !== undefined
            ? patch.percentOff
            : existing.percentOff;

      const amountOffPaisa =
        discountType === CouponDiscountType.PERCENTAGE
          ? null
          : patch.amountOffPaisa !== undefined
            ? patch.amountOffPaisa
            : existing.amountOffPaisa;

      const expiresAt = patch.expiresAt ?? existing.expiresAt;

      const usageLimit =
        patch.usageLimit !== undefined ? patch.usageLimit : existing.usageLimit;

      // The merged terms are validated as a whole, so a coupon can never
      // end up in a state that the create path would have refused.
      validateTerms({
        discountType,
        percentOff,
        amountOffPaisa,
        expiresAt,
        usageLimit,
      });

      /*
       * A change to what the coupon is **worth** needs a reason. The
       * terms are a price reduction, so an audit entry that says
       * "percentOff 10 → 20" with no reason cannot answer "why".
       *
       * Switching a coupon on or off is *not* a change to what it is
       * worth — it is a decision about whether to offer it — so it does
       * not need one.
       */
      const termsChanged =
        typeChanged ||
        percentOff !== existing.percentOff ||
        amountOffPaisa !== existing.amountOffPaisa ||
        usageLimit !== existing.usageLimit;

      if (termsChanged && !patch.reason?.trim()) {
        throw ApiError.validation(
          "Give a reason for the change to the discount.",
          {
            fieldErrors: {
              reason: ["A change to what the coupon is worth needs a reason."],
            },
          },
        );
      }

      const updated = await tx.coupon.update({
        where: { id: couponId },
        data: {
          ...(patch.description !== undefined
            ? { description: patch.description?.trim() || null }
            : {}),
          discountType,
          percentOff:
            discountType === CouponDiscountType.PERCENTAGE
              ? percentOff
              : null,
          amountOffPaisa:
            discountType === CouponDiscountType.FIXED ? amountOffPaisa : null,
          expiresAt,
          usageLimit,
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        },
        select: COUPON_SELECT,
      });

      const { before, after } = diffCoupon(existing, updated);

      // A save that changed nothing is not an action worth auditing.
      // An entry with empty `before` and `after` would pad the log with
      // noise and make a real change harder to find.
      if (Object.keys(after).length > 0) {
        await writeAuditEntry(tx, {
          actor,
          action: COUPON_ACTIONS.updated,
          entityType: "coupon",
          entityId: updated.id,
          before,
          after,
          reason: patch.reason?.trim() || null,
        });
      }

      return updated;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}

/**
 * Deactivates a coupon, atomically with its audit entry.
 *
 * ── Why deactivation, not deletion ────────────────────────────────────────
 *
 * A coupon that has been redeemed has **history**. Deleting the row
 * would erase the record of the campaign — how many times it ran, when
 * it ran, what it was worth — and the orders that used it would point at
 * a code that no longer exists.
 *
 * So the ordinary path is "switch it off". The row stays, the audit
 * entry says it was deactivated, and the redemption count is preserved.
 *
 * The **reason is mandatory**: deactivating a coupon stops an advertised
 * discount working, and a customer holding that code is entitled to an
 * explanation.
 */
export async function deactivateCoupon(
  actor: AuditActor,
  couponId: string,
  reason: string,
): Promise<AdminCoupon> {
  /*
   * The reason is checked **here**, in the service, and not only in the
   * request schema.
   *
   * A rule that lives only in the schema can be bypassed by any other
   * caller of the table — and the reason is the one thing that survives
   * the deactivation. A blank reason would leave an audit entry with a
   * null `reason`, which is exactly the entry that cannot answer "why
   * did this coupon stop working?" — the question the whole record
   * exists to answer.
   */
  const trimmedReason = reason.trim();

  if (trimmedReason.length === 0) {
    throw ApiError.validation("Give a reason for deactivating the coupon.", {
      fieldErrors: {
        reason: ["A customer holding this code is entitled to an explanation."],
      },
    });
  }

  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const existing = await tx.coupon.findUnique({
        where: { id: couponId },
        select: COUPON_SELECT,
      });

      if (!existing) {
        throw ApiError.notFound("That coupon does not exist.");
      }

      const updated = await tx.coupon.update({
        where: { id: couponId },
        data: { isActive: false },
        select: COUPON_SELECT,
      });

      const { before, after } = diffCoupon(existing, updated);

      await writeAuditEntry(tx, {
        actor,
        action: COUPON_ACTIONS.deleted,
        entityType: "coupon",
        entityId: updated.id,
        before,
        after,
        reason: trimmedReason,
      });

      return updated;
    },
    { maxWait: 5_000, timeout: 10_000 },
  );
}
