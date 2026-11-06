import { describe, expect, it } from "vitest";

import { submitReviewSchema } from "@/lib/validation/commerce";

/**
 * The review submission schema.
 *
 * ── What these tests are really about ────────────────────────────────────
 *
 * The schema is the only thing standing between a request body and a
 * review row, so the properties that matter are the *bounds* and the
 * *absences*:
 *
 *   1. The rating is 1 to 5. Not 0, not 6, not 4.5.
 *   2. The comment has a floor and a ceiling.
 *   3. The body carries **no** identity and **no** moderation state.
 *      A schema that accepted `isApproved` would let anyone publish
 *      their own review.
 *
 * The third is the one that is easy to regress: a future developer
 * adding a "publish immediately" feature would add the field to the
 * schema, and the moderation would be bypassed silently. These tests
 * fail if they do.
 */
describe("submitReviewSchema", () => {
  it("accepts a valid submission", () => {
    const result = submitReviewSchema.parse({
      rating: 4,
      comment: "It worked well for my oily skin.",
    });

    expect(result.rating).toBe(4);
    expect(result.comment).toBe("It worked well for my oily skin.");
  });

  it("defaults `purchased` to false", () => {
    const result = submitReviewSchema.parse({
      rating: 5,
      comment: "A very good product overall.",
    });

    expect(result.purchased).toBe(false);
  });

  it("trims the comment", () => {
    const result = submitReviewSchema.parse({
      rating: 3,
      comment: "   Padded with spaces.   ",
    });

    expect(result.comment).toBe("Padded with spaces.");
  });

  // ── The rating bounds ───────────────────────────────────────────────────

  it("rejects a rating of 0", () => {
    const result = submitReviewSchema.safeParse({
      rating: 0,
      comment: "A comment that is long enough.",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a rating of 6", () => {
    const result = submitReviewSchema.safeParse({
      rating: 6,
      comment: "A comment that is long enough.",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a fractional rating", () => {
    const result = submitReviewSchema.safeParse({
      rating: 4.5,
      comment: "A comment that is long enough.",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a missing rating", () => {
    const result = submitReviewSchema.safeParse({
      comment: "A comment that is long enough.",
    });

    expect(result.success).toBe(false);
  });

  it("accepts the boundary ratings, 1 and 5", () => {
    expect(
      submitReviewSchema.safeParse({
        rating: 1,
        comment: "A comment that is long enough.",
      }).success,
    ).toBe(true);

    expect(
      submitReviewSchema.safeParse({
        rating: 5,
        comment: "A comment that is long enough.",
      }).success,
    ).toBe(true);
  });

  // ── The comment bounds ──────────────────────────────────────────────────

  it("rejects a comment under 10 characters", () => {
    const result = submitReviewSchema.safeParse({
      rating: 4,
      comment: "Too short",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a comment over 2000 characters", () => {
    const result = submitReviewSchema.safeParse({
      rating: 4,
      comment: "a".repeat(2001),
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty comment", () => {
    const result = submitReviewSchema.safeParse({
      rating: 4,
      comment: "     ",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a comment at exactly 10 characters", () => {
    const result = submitReviewSchema.safeParse({
      rating: 4,
      comment: "1234567890",
    });

    expect(result.success).toBe(true);
  });

  // ── The absences ────────────────────────────────────────────────────────

  it("strips the moderation state, the author and the product id", () => {
    const result = submitReviewSchema.parse({
      rating: 4,
      comment: "A comment that is long enough.",
      // A client trying to publish its own review, or to write as
      // somebody else. The schema drops all three.
      isApproved: true,
      isHidden: false,
      userId: "someone-else",
      productId: "another-product",
      authorName: "Dr. Someone Else",
    });

    expect(result).not.toHaveProperty("isApproved");
    expect(result).not.toHaveProperty("isHidden");
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("productId");
    expect(result).not.toHaveProperty("authorName");
  });

  it("strips an unknown field rather than passing it through", () => {
    const result = submitReviewSchema.parse({
      rating: 4,
      comment: "A comment that is long enough.",
      moderationStatus: "APPROVED",
    });

    // Zod strips unknown keys by default. That is the safer behaviour
    // and it is what the previous test relies on: an extra field the
    // client sends is dropped, not honoured.
    expect(result).not.toHaveProperty("moderationStatus");
  });
});
