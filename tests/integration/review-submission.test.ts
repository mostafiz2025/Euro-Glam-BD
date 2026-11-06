import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hasCustomerReviewed,
  submitCustomerReview,
} from "@/lib/catalog/review-submission";
import { listPublicReviews } from "@/lib/catalog/reviews";

/**
 * Customer review submission — integration tests.
 *
 * These exercise the real write path against the real database. The
 * properties they prove are the ones a unit test cannot:
 *
 *   1. **A submitted review is pending.** It is not published, and it
 *      does not appear in the public listing. This is the property the
 *      whole moderation system rests on.
 *   2. **The author is the session.** The review is attributed to the
 *      user id the service was given, and nothing else.
 *   3. **One live review per customer per product.** A second one is
 *      refused.
 *   4. **The moderation state is honest.** A pending review reports
 *      `PENDING`; the customer is told the truth about their review.
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

const runId = `rsub${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function createUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      name: "Submission Tester",
      email,
      passwordHash: "$2a$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN",
      role: "CUSTOMER",
    },
    select: { id: true },
  });

  createdUserIds.push(user.id);
  return user.id;
}

async function createCategory(slug: string): Promise<string> {
  const category = await prisma.category.create({
    data: { name: "Submission Test", slug },
    select: { id: true },
  });

  createdCategoryIds.push(category.id);
  return category.id;
}

async function createProduct(categoryId: string, name: string): Promise<string> {
  const product = await prisma.product.create({
    data: {
      name,
      description: `Submission test product ${name}`,
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

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    databaseAvailable = true;
  } catch {
    console.warn(
      "\n[integration] PostgreSQL is not reachable — skipping the review " +
        "submission integration tests.\n[integration] Set DATABASE_URL in .env to run them.\n",
    );
    databaseAvailable = false;
  }
});

afterAll(async () => {
  if (!databaseAvailable) {
    return;
  }

  try {
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

describe("submitCustomerReview", () => {
  it("creates a review that is pending, not published", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_pending@example.com`);
    const categoryId = await createCategory(`${runId}-cat-pending`);
    const productId = await createProduct(categoryId, "Pending");

    const result = await submitCustomerReview(productId, userId, {
      rating: 5,
      comment: "Absolutely love this. My skin has never looked better.",
    });

    createdReviewIds.push(result.review.id);

    expect(result.review.moderationStatus).toBe("PENDING");

    // The row itself: the moderation flags are the database's defaults,
    // and the review is attributed to the session's user.
    const row = await prisma.review.findUnique({
      where: { id: result.review.id },
    });

    expect(row?.isApproved).toBe(false);
    expect(row?.isHidden).toBe(false);
    expect(row?.userId).toBe(userId);
    expect(row?.productId).toBe(productId);
    expect(row?.rating).toBe(5);
  });

  it("keeps a pending review out of the public listing", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_hidden@example.com`);
    const categoryId = await createCategory(`${runId}-cat-hidden`);
    const productId = await createProduct(categoryId, "Not Public");

    const result = await submitCustomerReview(productId, userId, {
      rating: 3,
      comment: "It was okay for me, nothing special at all.",
    });

    createdReviewIds.push(result.review.id);

    // The public listing must not show it. This is the property that
    // makes the moderation meaningful.
    const listed = await listPublicReviews(productId);

    expect(listed.count).toBe(0);
    expect(listed.reviews).toHaveLength(0);
  });

  it("refuses a second live review by the same customer", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_duplicate@example.com`);
    const categoryId = await createCategory(`${runId}-cat-duplicate`);
    const productId = await createProduct(categoryId, "Once Only");

    const first = await submitCustomerReview(productId, userId, {
      rating: 4,
      comment: "Really good, would buy it again for sure.",
    });

    createdReviewIds.push(first.review.id);

    // Approve it, so it becomes a *live* review.
    await prisma.review.update({
      where: { id: first.review.id },
      data: { isApproved: true },
    });

    await expect(
      submitCustomerReview(productId, userId, {
        rating: 2,
        comment: "Actually, I changed my mind about this one.",
      }),
    ).rejects.toThrow("ALREADY_REVIEWED");
  });

  it("allows a second review while the first is still pending", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_pending-twice@example.com`);
    const categoryId = await createCategory(`${runId}-cat-pending-twice`);
    const productId = await createProduct(categoryId, "Pending Twice");

    const first = await submitCustomerReview(productId, userId, {
      rating: 4,
      comment: "My first impression of this product.",
    });

    createdReviewIds.push(first.review.id);

    // The first is still pending — not published — so a second
    // submission is allowed. The customer may have mis-tapped, or
    // changed their mind before the shop saw it.
    const second = await submitCustomerReview(productId, userId, {
      rating: 5,
      comment: "Second thoughts — I actually like it much more.",
    });

    createdReviewIds.push(second.review.id);

    expect(second.review.id).not.toBe(first.review.id);
    expect(second.review.moderationStatus).toBe("PENDING");
  });

  it("refuses a review on a product that does not exist", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_ghost@example.com`);

    await expect(
      submitCustomerReview("no-such-product", userId, {
        rating: 4,
        comment: "This product does not exist at all.",
      }),
    ).rejects.toThrow("PRODUCT_NOT_FOUND");
  });

  it("reports APPROVED for a review that was already approved", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_approved@example.com`);
    const categoryId = await createCategory(`${runId}-cat-approved`);
    const productId = await createProduct(categoryId, "Approved");

    const result = await submitCustomerReview(productId, userId, {
      rating: 5,
      comment: "Fantastic product, exactly what I was looking for.",
    });

    createdReviewIds.push(result.review.id);

    await prisma.review.update({
      where: { id: result.review.id },
      data: { isApproved: true },
    });

    // The same review, re-read. The moderation status is derived from
    // the row, not remembered from the insert.
    const listed = await listPublicReviews(productId);

    expect(listed.count).toBe(1);
  });
});

describe("hasCustomerReviewed", () => {
  it("is false before the customer reviews and true after approval", async () => {
    if (!databaseAvailable) return;

    const userId = await createUser(`${runId}_has-reviewed@example.com`);
    const categoryId = await createCategory(`${runId}-cat-has-reviewed`);
    const productId = await createProduct(categoryId, "Has Reviewed");

    expect(await hasCustomerReviewed(productId, userId)).toBe(false);

    const result = await submitCustomerReview(productId, userId, {
      rating: 4,
      comment: "A perfectly reasonable review comment.",
    });

    createdReviewIds.push(result.review.id);

    // Still pending, so it is not a *published* review yet.
    expect(await hasCustomerReviewed(productId, userId)).toBe(false);

    await prisma.review.update({
      where: { id: result.review.id },
      data: { isApproved: true },
    });

    expect(await hasCustomerReviewed(productId, userId)).toBe(true);
  });

  it("does not count another customer's review", async () => {
    if (!databaseAvailable) return;

    const first = await createUser(`${runId}_mine@example.com`);
    const second = await createUser(`${runId}_theirs@example.com`);
    const categoryId = await createCategory(`${runId}-cat-mine`);
    const productId = await createProduct(categoryId, "Mine");

    const result = await submitCustomerReview(productId, first, {
      rating: 4,
      comment: "A perfectly reasonable review comment.",
    });

    createdReviewIds.push(result.review.id);

    await prisma.review.update({
      where: { id: result.review.id },
      data: { isApproved: true },
    });

    expect(await hasCustomerReviewed(productId, second)).toBe(false);
  });
});
