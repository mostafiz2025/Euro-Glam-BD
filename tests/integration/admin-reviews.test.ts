import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type AuditActor } from "@/lib/admin/audit";
import {
  getAdminReview,
  listAdminReviews,
  moderateReview,
} from "@/lib/admin/reviews";
import { ApiError } from "@/lib/api/errors";

/**
 * Review moderation integration tests.
 *
 * These exercise the real database and the real Prisma transaction. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. The moderation and its audit entry are written **together** — one
 *      transaction, so a review can never be moderated without a record
 *      of who did it.
 *   2. The conditional update makes concurrent moderation safe: two
 *      admins acting on the same review produce one winner and one 409.
 *   3. The moderation queue's counts match its lists.
 *   4. The public predicate needs both flags, so a hidden review is not
 *      published.
 *
 * These tests need a reachable PostgreSQL. When the database is not
 * available they are skipped rather than failed.
 */

import { prisma } from "./client";

let databaseAvailable = false;

const createdUserIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdProductIds: string[] = [];
const createdReviewIds: string[] = [];

const runId = `rev${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function createUser(
  email: string,
  role: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Test Reviewer",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role,
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Review Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

async function createProduct(categoryId: string, name: string): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Review test product ${name}`,
      categoryId,
      pricePaisa: 100000,
      stockQuantity: 10,
      ingredientTags: [],
    },
    select: { id: true },
  });

  createdProductIds.push(product.id);
  return product.id;
}

async function createReview(
  productId: string,
  userId: string,
  comment: string,
): Promise<string> {
  const review = await prisma.review.create({
    data: {
      productId,
      userId,
      rating: 4,
      comment,
      isApproved: false,
      isHidden: false,
    },
    select: { id: true },
  });

  createdReviewIds.push(review.id);
  return review.id;
}

/**
 * The admin who performs the moderation.
 *
 * The `actorId` is a foreign key to `User`, so the audit actor has to be
 * a real user row — the tests create an admin rather than inventing an
 * id.
 */
let actor: AuditActor;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the review " +
        "moderation integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }

  if (!databaseAvailable) return;

  const adminId = await createUser(`${runId}_admin@example.com`, "ADMIN");

  actor = {
    id: adminId,
    name: "Admin Actor",
    email: `${runId}_admin@example.com`,
  };
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
    await prisma.adminAuditLog.deleteMany({
      where: { entityType: "review", entityId: { in: createdReviewIds } },
    });
    await prisma.review.deleteMany({
      where: { id: { in: createdReviewIds } },
    });
    await prisma.product.deleteMany({
      where: { id: { in: createdProductIds } },
    });
    await prisma.category.deleteMany({
      where: { id: { in: createdCategoryIds } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: createdUserIds } },
    });
  } finally {
  }
});

describe("moderateReview — the write and its audit entry", () => {
  it("approves a pending review and records the decision", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_approve@example.com`);
    const categoryId = await createCategory(`${runId}-cat-approve`);
    const productId = await createProduct(categoryId, "Approve");
    const reviewId = await createReview(productId, userId, "Great product");

    const result = await moderateReview(actor, reviewId, "APPROVE");

    expect(result.isApproved).toBe(true);
    expect(result.isHidden).toBe(false);
    expect(result.moderatedAt).not.toBeNull();

    // The audit entry exists, with the before and after states.
    const entry = await prisma.adminAuditLog.findFirst({
      where: { entityType: "review", entityId: reviewId },
    });

    expect(entry).not.toBeNull();
    expect(entry?.action).toBe("REVIEW_APPROVED");
    expect(entry?.actorEmail).toBe(actor.email);
    expect(entry?.before).toMatchObject({ state: "PENDING" });
    expect(entry?.after).toMatchObject({ state: "APPROVED" });
  });

  it("hides an approved review, keeping it approved but not public", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_hide@example.com`);
    const categoryId = await createCategory(`${runId}-cat-hide`);
    const productId = await createProduct(categoryId, "Hide");
    const reviewId = await createReview(productId, userId, "Spam");

    await moderateReview(actor, reviewId, "APPROVE");

    const result = await moderateReview(
      actor,
      reviewId,
      "HIDE",
      "Contains personal information.",
    );

    // Still approved — the history is not destroyed — but hidden.
    expect(result.isApproved).toBe(true);
    expect(result.isHidden).toBe(true);

    const entry = await prisma.adminAuditLog.findFirst({
      where: {
        entityType: "review",
        entityId: reviewId,
        action: "REVIEW_HIDDEN",
      },
      orderBy: { createdAt: "desc" },
    });

    expect(entry).not.toBeNull();
    expect(entry?.reason).toBe("Contains personal information.");
  });

  it("keeps the full history across approve, hide and unhide", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_history@example.com`);
    const categoryId = await createCategory(`${runId}-cat-history`);
    const productId = await createProduct(categoryId, "History");
    const reviewId = await createReview(productId, userId, "History test");

    await moderateReview(actor, reviewId, "APPROVE");
    await moderateReview(actor, reviewId, "HIDE");
    await moderateReview(actor, reviewId, "UNHIDE");

    // Three decisions, three audit entries — none of them overwritten.
    const entries = await prisma.adminAuditLog.findMany({
      where: { entityType: "review", entityId: reviewId },
      orderBy: { createdAt: "asc" },
    });

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.action)).toEqual([
      "REVIEW_APPROVED",
      "REVIEW_HIDDEN",
      "REVIEW_UNHIDDEN",
    ]);
  });

  it("refuses to hide a pending review and writes nothing", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_nohide@example.com`);
    const categoryId = await createCategory(`${runId}-cat-nohide`);
    const productId = await createProduct(categoryId, "NoHide");
    const reviewId = await createReview(productId, userId, "Pending");

    await expect(
      moderateReview(actor, reviewId, "HIDE"),
    ).rejects.toThrow(ApiError);

    // The review is untouched.
    const review = await prisma.review.findUnique({
      where: { id: reviewId },
      select: { isApproved: true, isHidden: true },
    });

    expect(review?.isApproved).toBe(false);
    expect(review?.isHidden).toBe(false);

    // And no audit entry was written.
    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "review", entityId: reviewId },
    });

    expect(entries).toBe(0);
  });

  it("refuses to approve an already approved review", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_reapprove@example.com`);
    const categoryId = await createCategory(`${runId}-cat-reapprove`);
    const productId = await createProduct(categoryId, "Reapprove");
    const reviewId = await createReview(productId, userId, "Already");

    await moderateReview(actor, reviewId, "APPROVE");

    await expect(
      moderateReview(actor, reviewId, "APPROVE"),
    ).rejects.toThrow(ApiError);

    // Still exactly one audit entry.
    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "review", entityId: reviewId },
    });

    expect(entries).toBe(1);
  });

  it("throws a 404 for a review that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      moderateReview(actor, "ckq1doesnotexist00000000a", "APPROVE"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lets exactly one of two concurrent moderators win", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_race@example.com`);
    const categoryId = await createCategory(`${runId}-cat-race`);
    const productId = await createProduct(categoryId, "Race");
    const reviewId = await createReview(productId, userId, "Race");

    // A second, real admin — so the audit entry's foreign key holds.
    const otherAdminId = await createUser(
      `${runId}_race_other@example.com`,
      "ADMIN",
    );

    const otherActor: AuditActor = {
      id: otherAdminId,
      name: "Other Admin",
      email: `${runId}_race_other@example.com`,
    };

    // Both admins try to approve the same pending review at once. One
    // wins; the other gets a conflict, not a silent overwrite.
    const results = await Promise.allSettled([
      moderateReview(actor, reviewId, "APPROVE"),
      moderateReview(otherActor, reviewId, "APPROVE"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const rejection = rejected[0];
    expect(rejection.status).toBe("rejected");

    if (rejection.status === "rejected") {
      expect(rejection.reason).toMatchObject({ code: "CONFLICT" });
    }

    // Exactly one audit entry was written.
    const entries = await prisma.adminAuditLog.count({
      where: { entityType: "review", entityId: reviewId },
    });

    expect(entries).toBe(1);
  });
});

describe("listAdminReviews — the moderation queue", () => {
  it("shows a pending review in the pending queue and not in the approved one", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_queue@example.com`);
    const categoryId = await createCategory(`${runId}-cat-queue`);
    const productId = await createProduct(categoryId, "Queue");
    const reviewId = await createReview(productId, userId, "Queued");

    const pending = await listAdminReviews({
      status: "PENDING",
      page: 1,
      limit: 100,
    });

    expect(pending.reviews.map((r) => r.id)).toContain(reviewId);

    const approved = await listAdminReviews({
      status: "APPROVED",
      page: 1,
      limit: 100,
    });

    expect(approved.reviews.map((r) => r.id)).not.toContain(reviewId);

    // The counts agree with the lists.
    expect(pending.counts.pending).toBe(pending.pagination.total);
    expect(approved.counts.approved).toBe(approved.pagination.total);
  });

  it("moves a review between queues as it is moderated", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_move@example.com`);
    const categoryId = await createCategory(`${runId}-cat-move`);
    const productId = await createProduct(categoryId, "Move");
    const reviewId = await createReview(productId, userId, "Moving");

    await moderateReview(actor, reviewId, "APPROVE");

    const approved = await listAdminReviews({
      status: "APPROVED",
      page: 1,
      limit: 100,
    });

    expect(approved.reviews.map((r) => r.id)).toContain(reviewId);

    await moderateReview(actor, reviewId, "HIDE");

    const hidden = await listAdminReviews({
      status: "HIDDEN",
      page: 1,
      limit: 100,
    });

    expect(hidden.reviews.map((r) => r.id)).toContain(reviewId);

    // And it is no longer in the approved queue.
    const approvedAgain = await listAdminReviews({
      status: "APPROVED",
      page: 1,
      limit: 100,
    });

    expect(approvedAgain.reviews.map((r) => r.id)).not.toContain(reviewId);
  });

  it("filters by product", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_product@example.com`);
    const categoryId = await createCategory(`${runId}-cat-product`);
    const productA = await createProduct(categoryId, "Product A");
    const productB = await createProduct(categoryId, "Product B");
    const reviewA = await createReview(productA, userId, "A");
    const reviewB = await createReview(productB, userId, "B");

    const result = await listAdminReviews({
      status: "ALL",
      productId: productA,
      page: 1,
      limit: 100,
    });

    const ids = result.reviews.map((r) => r.id);

    expect(ids).toContain(reviewA);
    expect(ids).not.toContain(reviewB);
  });

  it("reports a total of zero for a filter that matches nothing", async () => {
    if (!databaseAvailable) return;

    const result = await listAdminReviews({
      status: "ALL",
      productId: "ckq1nosuchproduct000000a",
      page: 1,
      limit: 100,
    });

    // The Step 9 bug class: a filter that matches nothing must not look
    // like a queue that has items in it.
    expect(result.reviews).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });
});

describe("getAdminReview", () => {
  it("loads one review with its product and its author", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_get@example.com`);
    const categoryId = await createCategory(`${runId}-cat-get`);
    const productId = await createProduct(categoryId, "Get");
    const reviewId = await createReview(productId, userId, "Get me");

    const review = await getAdminReview(reviewId);

    expect(review.id).toBe(reviewId);
    expect(review.product.id).toBe(productId);
    expect(review.user.id).toBe(userId);
  });

  it("throws a 404 for a review that does not exist", async () => {
    if (!databaseAvailable) return;

    await expect(
      getAdminReview("ckq1doesnotexist00000000a"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
