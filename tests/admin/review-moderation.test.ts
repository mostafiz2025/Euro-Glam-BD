import { describe, expect, it } from "vitest";

import {
  isPublicReview,
  moderationTarget,
  reviewState,
  reviewStateWhere,
} from "@/lib/admin/reviews";

/**
 * The review moderation state machine.
 *
 * These are pure functions, so they are tested without a database. The
 * properties they lock down are:
 *
 *   1. The three states are derived correctly from the two flags.
 *   2. The public predicate needs **both** flags — `isApproved` alone
 *      would publish hidden reviews.
 *   3. Hiding a pending review is refused, because there is nothing to
 *      withdraw and it would produce an unreachable fourth state.
 *   4. Each state filter maps to a `where` clause that selects exactly
 *      that state — and no two filters select the same rows.
 */

describe("reviewState", () => {
  it("reads an unmoderated review as PENDING", () => {
    expect(reviewState({ isApproved: false, isHidden: false })).toBe("PENDING");
  });

  it("reads a published review as APPROVED", () => {
    expect(reviewState({ isApproved: true, isHidden: false })).toBe("APPROVED");
  });

  it("reads a withdrawn review as HIDDEN", () => {
    expect(reviewState({ isApproved: true, isHidden: true })).toBe("HIDDEN");
  });

  it("reads the unreachable combination as PENDING", () => {
    // `isApproved = false, isHidden = true` cannot be produced by the
    // state machine — hiding a pending review is refused. If it ever
    // appeared in the database it would mean the data was corrupted
    // outside the service, and reporting it as PENDING is the honest
    // answer.
    expect(reviewState({ isApproved: false, isHidden: true })).toBe("PENDING");
  });
});

describe("isPublicReview", () => {
  it("publishes an approved, unhidden review", () => {
    expect(isPublicReview({ isApproved: true, isHidden: false })).toBe(true);
  });

  it("does not publish a hidden review, even though it is still approved", () => {
    // This is the case that makes `isApproved` alone unsafe. Hiding sets
    // `isHidden = true` and leaves `isApproved = true`, because the
    // review *was* approved and that history must not be lost.
    expect(isPublicReview({ isApproved: true, isHidden: true })).toBe(false);
  });

  it("does not publish a pending review", () => {
    expect(isPublicReview({ isApproved: false, isHidden: false })).toBe(false);
  });
});

describe("moderationTarget", () => {
  it("approves a pending review", () => {
    expect(
      moderationTarget({ isApproved: false, isHidden: false }, "APPROVE"),
    ).toEqual({ isApproved: true, isHidden: false });
  });

  it("hides an approved review, keeping it approved", () => {
    expect(
      moderationTarget({ isApproved: true, isHidden: false }, "HIDE"),
    ).toEqual({ isApproved: true, isHidden: true });
  });

  it("unhides a hidden review, restoring it to published", () => {
    expect(
      moderationTarget({ isApproved: true, isHidden: true }, "UNHIDE"),
    ).toEqual({ isApproved: true, isHidden: false });
  });

  it("refuses to hide a pending review", () => {
    // Nothing was published, so there is nothing to withdraw.
    expect(
      moderationTarget({ isApproved: false, isHidden: false }, "HIDE"),
    ).toBeNull();
  });

  it("refuses to approve an already approved review", () => {
    expect(
      moderationTarget({ isApproved: true, isHidden: false }, "APPROVE"),
    ).toBeNull();
  });

  it("refuses to hide an already hidden review", () => {
    expect(
      moderationTarget({ isApproved: true, isHidden: true }, "HIDE"),
    ).toBeNull();
  });

  it("refuses to unhide a review that was never hidden", () => {
    expect(
      moderationTarget({ isApproved: true, isHidden: false }, "UNHIDE"),
    ).toBeNull();
    expect(
      moderationTarget({ isApproved: false, isHidden: false }, "UNHIDE"),
    ).toBeNull();
  });

  it("never produces the unreachable fourth state", () => {
    const states = [
      { isApproved: false, isHidden: false },
      { isApproved: true, isHidden: false },
      { isApproved: true, isHidden: true },
    ];

    const actions = ["APPROVE", "HIDE", "UNHIDE"] as const;

    for (const state of states) {
      for (const action of actions) {
        const target = moderationTarget(state, action);

        if (!target) continue;

        expect(
          target.isApproved === false && target.isHidden === true,
        ).toBe(false);
      }
    }
  });
});

describe("reviewStateWhere", () => {
  it("selects only pending reviews for PENDING", () => {
    expect(reviewStateWhere("PENDING")).toEqual({
      isApproved: false,
      isHidden: false,
    });
  });

  it("selects only published reviews for APPROVED", () => {
    expect(reviewStateWhere("APPROVED")).toEqual({
      isApproved: true,
      isHidden: false,
    });
  });

  it("selects only withdrawn reviews for HIDDEN", () => {
    expect(reviewStateWhere("HIDDEN")).toEqual({
      isApproved: true,
      isHidden: true,
    });
  });

  it("selects everything for ALL", () => {
    expect(reviewStateWhere("ALL")).toEqual({});
  });

  it("gives each state a distinct filter", () => {
    const filters = (["PENDING", "APPROVED", "HIDDEN"] as const).map(
      (state) => JSON.stringify(reviewStateWhere(state)),
    );

    expect(new Set(filters).size).toBe(3);
  });
});
