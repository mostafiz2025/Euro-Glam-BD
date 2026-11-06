import { describe, expect, it } from "vitest";

import {
  manualResendIdempotencyKey,
  reminderIdempotencyKey,
  SMS_REASONS,
} from "@/lib/sms/service";

/**
 * The idempotency keys.
 *
 * `SmsLog.idempotencyKey` is `@unique`, so the key is what actually
 * prevents a double-send. Two properties matter:
 *
 *   1. The automated key is **deterministic** — the same order item
 *      always produces the same key, so a re-run of the sweep cannot
 *      double-send.
 *
 *   2. The manual resend key is **distinct** from the automated one. If
 *      they were the same, the admin's explicit instruction to resend
 *      would be silently swallowed by the unique constraint from the
 *      original automated message — the admin would see a success
 *      response and the customer would receive nothing.
 */

describe("reminderIdempotencyKey", () => {
  it("is derived from the order item", () => {
    expect(reminderIdempotencyKey("item-1")).toBe("reminder:item-1");
  });

  it("is deterministic", () => {
    expect(reminderIdempotencyKey("item-1")).toBe(
      reminderIdempotencyKey("item-1"),
    );
  });

  it("differs for different items", () => {
    expect(reminderIdempotencyKey("item-1")).not.toBe(
      reminderIdempotencyKey("item-2"),
    );
  });

  it("fits the column", () => {
    // `SmsLog.idempotencyKey` is a VarChar(120). A cuid is 25
    // characters, so the key is 34 — comfortably inside it. The test
    // guards against someone lengthening the prefix.
    const key = reminderIdempotencyKey("c".repeat(25));

    expect(key.length).toBeLessThanOrEqual(120);
  });
});

describe("manualResendIdempotencyKey", () => {
  it("is derived from the order item", () => {
    expect(manualResendIdempotencyKey("item-1")).toBe(
      "reminder:item-1:manual",
    );
  });

  it("is deterministic", () => {
    expect(manualResendIdempotencyKey("item-1")).toBe(
      manualResendIdempotencyKey("item-1"),
    );
  });

  it("differs from the automated key for the same item", () => {
    // The whole point of the separate key.
    expect(manualResendIdempotencyKey("item-1")).not.toBe(
      reminderIdempotencyKey("item-1"),
    );
  });

  it("does not collide with another item's automated key", () => {
    // A manual resend of "item-1" must not collide with the automated
    // reminder for a *different* item whose id happens to make the
    // strings look alike.
    expect(manualResendIdempotencyKey("item-1")).not.toBe(
      reminderIdempotencyKey("item-11"),
    );
    expect(manualResendIdempotencyKey("item-11")).not.toBe(
      reminderIdempotencyKey("item-1"),
    );
  });
});

describe("the message reasons", () => {
  it("distinguishes an automated reminder from a manual resend", () => {
    expect(SMS_REASONS.depletionReminder).not.toBe(SMS_REASONS.manualResend);
  });

  it("uses short, storable values", () => {
    // `SmsLog.reason` is a VarChar(40).
    for (const reason of Object.values(SMS_REASONS)) {
      expect(reason.length).toBeLessThanOrEqual(40);
    }
  });
});
