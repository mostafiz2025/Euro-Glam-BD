import { describe, expect, it } from "vitest";

import {
  adminNotificationQuerySchema,
  adminOrderCreateSchema,
  adminOrderQuerySchema,
  adminReviewQuerySchema,
  orderStatusUpdateSchema,
  paymentStatusUpdateSchema,
  resendSchema,
  reviewModerationSchema,
  smsLogQuerySchema,
  triggerRemindersSchema,
} from "@/lib/validation/admin";

/**
 * The admin validation schemas.
 *
 * The rules under test are the same everywhere else in the codebase:
 *
 *   1. An invalid filter is **rejected**, never silently ignored. If the
 *      client asks for `status=shipped` and gets `PENDING` back with a
 *      200, nobody can work out why.
 *   2. Query strings are strings, so the numeric fields coerce.
 *   3. Free text is bounded.
 */

/**
 * A plausible entity id — a cuid is 25 lowercase alphanumeric chars.
 */
const entityId = "ckq1example0000000000abc";

describe("reviewModerationSchema", () => {
  it("accepts the three moderation actions", () => {
    for (const action of ["APPROVE", "HIDE", "UNHIDE"]) {
      expect(reviewModerationSchema.parse({ action }).action).toBe(action);
    }
  });

  it("rejects an unknown action", () => {
    expect(() => reviewModerationSchema.parse({ action: "DELETE" })).toThrow();
  });

  it("requires an action", () => {
    expect(() => reviewModerationSchema.parse({})).toThrow();
  });

  it("accepts an optional reason", () => {
    const parsed = reviewModerationSchema.parse({
      action: "HIDE",
      reason: "Contains personal information.",
    });

    expect(parsed.reason).toBe("Contains personal information.");
  });

  it("trims the reason", () => {
    const parsed = reviewModerationSchema.parse({
      action: "HIDE",
      reason: "   Spammy   ",
    });

    expect(parsed.reason).toBe("Spammy");
  });

  it("rejects an over-long reason", () => {
    expect(() =>
      reviewModerationSchema.parse({ action: "HIDE", reason: "x".repeat(501) }),
    ).toThrow();
  });

  it("accepts a reason of exactly the maximum length", () => {
    expect(() =>
      reviewModerationSchema.parse({ action: "HIDE", reason: "x".repeat(500) }),
    ).not.toThrow();
  });

  it("rejects a non-string reason", () => {
    expect(() =>
      reviewModerationSchema.parse({ action: "HIDE", reason: 42 }),
    ).toThrow();
  });
});

describe("adminReviewQuerySchema", () => {
  it("defaults to the pending queue", () => {
    expect(adminReviewQuerySchema.parse({}).status).toBe("PENDING");
  });

  it("accepts the four status filters", () => {
    for (const status of ["PENDING", "APPROVED", "HIDDEN", "ALL"]) {
      expect(adminReviewQuerySchema.parse({ status }).status).toBe(status);
    }
  });

  it("rejects an unknown status", () => {
    expect(() => adminReviewQuerySchema.parse({ status: "shipped" })).toThrow();
  });

  it("coerces the pagination from strings", () => {
    const parsed = adminReviewQuerySchema.parse({ page: "3", limit: "25" });

    expect(parsed.page).toBe(3);
    expect(parsed.limit).toBe(25);
  });

  it("defaults the pagination", () => {
    const parsed = adminReviewQuerySchema.parse({});

    expect(parsed.page).toBe(1);
    expect(parsed.limit).toBe(20);
  });

  it("rejects a page below one", () => {
    expect(() => adminReviewQuerySchema.parse({ page: "0" })).toThrow();
    expect(() => adminReviewQuerySchema.parse({ page: "-1" })).toThrow();
  });

  it("rejects a fractional page", () => {
    expect(() => adminReviewQuerySchema.parse({ page: "1.5" })).toThrow();
  });

  it("rejects a page size over the maximum", () => {
    expect(() => adminReviewQuerySchema.parse({ limit: "101" })).toThrow();
  });

  it("accepts a page size of exactly the maximum", () => {
    expect(adminReviewQuerySchema.parse({ limit: "100" }).limit).toBe(100);
  });

  it("accepts the optional id filters", () => {
    const parsed = adminReviewQuerySchema.parse({
      productId: entityId,
      userId: entityId,
    });

    expect(parsed.productId).toBe(entityId);
    expect(parsed.userId).toBe(entityId);
  });

  it("rejects a malformed id", () => {
    expect(() => adminReviewQuerySchema.parse({ productId: "" })).toThrow();
    expect(() =>
      adminReviewQuerySchema.parse({ productId: "x".repeat(500) }),
    ).toThrow();
  });
});

describe("orderStatusUpdateSchema", () => {
  it("accepts the four target statuses", () => {
    for (const status of ["PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"]) {
      expect(orderStatusUpdateSchema.parse({ status }).status).toBe(status);
    }
  });

  it("rejects PENDING as a target", () => {
    // An order is created as PENDING; an admin never moves it back.
    expect(() => orderStatusUpdateSchema.parse({ status: "PENDING" })).toThrow();
  });

  it("requires a status", () => {
    expect(() => orderStatusUpdateSchema.parse({})).toThrow();
  });
});

describe("paymentStatusUpdateSchema", () => {
  it("accepts the three target statuses", () => {
    for (const paymentStatus of ["PAID", "FAILED", "REFUNDED"]) {
      expect(
        paymentStatusUpdateSchema.parse({ paymentStatus }).paymentStatus,
      ).toBe(paymentStatus);
    }
  });

  it("rejects PENDING as a target", () => {
    // Marking an order PAID before the courier collects the cash would
    // be recording something untrue.
    expect(() =>
      paymentStatusUpdateSchema.parse({ paymentStatus: "PENDING" }),
    ).toThrow();
  });
});

describe("adminOrderQuerySchema", () => {
  it("accepts the status filters", () => {
    expect(
      adminOrderQuerySchema.parse({ status: "SHIPPED" }).status,
    ).toBe("SHIPPED");
    expect(
      adminOrderQuerySchema.parse({ paymentStatus: "PAID" }).paymentStatus,
    ).toBe("PAID");
  });

  it("rejects an unknown status", () => {
    expect(() => adminOrderQuerySchema.parse({ status: "on-hold" })).toThrow();
    expect(() =>
      adminOrderQuerySchema.parse({ paymentStatus: "pending" }),
    ).toThrow();
  });

  it("accepts the payment method filter", () => {
    for (const method of ["COD", "BKASH", "NAGAD", "CARD"]) {
      expect(adminOrderQuerySchema.parse({ paymentMethod: method }).paymentMethod).toBe(
        method,
      );
    }
  });

  it("rejects an unknown payment method", () => {
    expect(() =>
      adminOrderQuerySchema.parse({ paymentMethod: "BKASH2" }),
    ).toThrow();
    expect(() =>
      adminOrderQuerySchema.parse({ paymentMethod: "bkash" }),
    ).toThrow();
  });

  it("trims and bounds the search term", () => {
    expect(adminOrderQuerySchema.parse({ search: "  abc  " }).search).toBe(
      "abc",
    );
    expect(() =>
      adminOrderQuerySchema.parse({ search: "x".repeat(121) }),
    ).toThrow();
  });

  it("coerces the pagination", () => {
    const parsed = adminOrderQuerySchema.parse({ page: "2", limit: "10" });

    expect(parsed.page).toBe(2);
    expect(parsed.limit).toBe(10);
  });
});

describe("triggerRemindersSchema", () => {
  it("defaults dryRun to false", () => {
    expect(triggerRemindersSchema.parse({}).dryRun).toBe(false);
  });

  it("accepts an explicit dryRun", () => {
    expect(triggerRemindersSchema.parse({ dryRun: true }).dryRun).toBe(true);
  });

  it("rejects a non-boolean dryRun", () => {
    expect(() => triggerRemindersSchema.parse({ dryRun: "yes" })).toThrow();
  });
});

describe("resendSchema", () => {
  it("accepts an order item id", () => {
    expect(resendSchema.parse({ orderItemId: entityId }).orderItemId).toBe(
      entityId,
    );
  });

  it("requires an order item id", () => {
    expect(() => resendSchema.parse({})).toThrow();
  });

  it("rejects a malformed order item id", () => {
    expect(() => resendSchema.parse({ orderItemId: "" })).toThrow();
  });

  it("accepts an optional reason", () => {
    expect(
      resendSchema.parse({ orderItemId: entityId, reason: "Customer asked." })
        .reason,
    ).toBe("Customer asked.");
  });
});

describe("smsLogQuerySchema", () => {
  it("accepts the status filter", () => {
    expect(smsLogQuerySchema.parse({ status: "failed" }).status).toBe("failed");
  });

  it("rejects an unknown status", () => {
    expect(() => smsLogQuerySchema.parse({ status: "delivered" })).toThrow();
  });

  it("coerces the pagination", () => {
    const parsed = smsLogQuerySchema.parse({ page: "4", limit: "50" });

    expect(parsed.page).toBe(4);
    expect(parsed.limit).toBe(50);
  });
});

describe("adminNotificationQuerySchema", () => {
  it("defaults the limit to 20", () => {
    expect(adminNotificationQuerySchema.parse({}).limit).toBe(20);
  });

  it("coerces the limit from a string", () => {
    expect(adminNotificationQuerySchema.parse({ limit: "5" }).limit).toBe(5);
  });

  it("rejects a limit below one", () => {
    expect(() => adminNotificationQuerySchema.parse({ limit: "0" })).toThrow();
  });

  it("rejects a limit over the maximum", () => {
    expect(() => adminNotificationQuerySchema.parse({ limit: "51" })).toThrow();
  });

  it("accepts a limit of exactly the maximum", () => {
    expect(adminNotificationQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it("rejects a fractional limit", () => {
    expect(() => adminNotificationQuerySchema.parse({ limit: "1.5" })).toThrow();
  });
});

describe("adminOrderCreateSchema", () => {
  /**
   * A valid order body, used as the base for the refusal tests.
   */
  const validOrder = {
    userId: entityId,
    fullName: "Ayesha Rahman",
    phone: "01712345678",
    addressLine1: "House 12, Road 5, Dhanmondi",
    city: "Dhaka",
    district: "Dhaka",
    postalCode: "1209",
    paymentMethod: "COD",
    lines: [{ productId: entityId, quantity: 2 }],
    reason: "Phone order.",
  };

  it("accepts a cash-on-delivery order", () => {
    const parsed = adminOrderCreateSchema.parse(validOrder);

    expect(parsed.paymentMethod).toBe("COD");
    expect(parsed.lines).toHaveLength(1);
  });

  it("requires a reason", () => {
    const { reason, ...withoutReason } = validOrder;

    expect(reason).toBeTruthy();
    expect(() => adminOrderCreateSchema.parse(withoutReason)).toThrow();
  });

  it("requires at least one line", () => {
    expect(() =>
      adminOrderCreateSchema.parse({ ...validOrder, lines: [] }),
    ).toThrow();
  });

  it("requires a customer id", () => {
    expect(() =>
      adminOrderCreateSchema.parse({ ...validOrder, userId: "" }),
    ).toThrow();
  });

  it("accepts a mobile-banking order with a transaction id", () => {
    const parsed = adminOrderCreateSchema.parse({
      ...validOrder,
      paymentMethod: "BKASH",
      paymentTransactionId: "TRX12345",
      paymentSenderNumber: "01712345678",
    });

    expect(parsed.paymentTransactionId).toBe("TRX12345");
  });

  it("refuses a mobile-banking order without a transaction id", () => {
    expect(() =>
      adminOrderCreateSchema.parse({ ...validOrder, paymentMethod: "NAGAD" }),
    ).toThrow();
  });

  it("refuses a cash order with a transaction id", () => {
    expect(() =>
      adminOrderCreateSchema.parse({
        ...validOrder,
        paymentMethod: "COD",
        paymentTransactionId: "TRX12345",
      }),
    ).toThrow();
  });

  it("refuses a card order with a sender number", () => {
    expect(() =>
      adminOrderCreateSchema.parse({
        ...validOrder,
        paymentMethod: "CARD",
        paymentSenderNumber: "01712345678",
      }),
    ).toThrow();
  });

  it("rejects an unknown payment method", () => {
    expect(() =>
      adminOrderCreateSchema.parse({ ...validOrder, paymentMethod: "BKASH2" }),
    ).toThrow();
  });

  it("rejects a line with no product", () => {
    expect(() =>
      adminOrderCreateSchema.parse({
        ...validOrder,
        lines: [{ productId: "", quantity: 1 }],
      }),
    ).toThrow();
  });

  it("rejects a line with a zero quantity", () => {
    expect(() =>
      adminOrderCreateSchema.parse({
        ...validOrder,
        lines: [{ productId: entityId, quantity: 0 }],
      }),
    ).toThrow();
  });

  it("rejects an over-long reason", () => {
    expect(() =>
      adminOrderCreateSchema.parse({ ...validOrder, reason: "x".repeat(501) }),
    ).toThrow();
  });

  it("accepts a reason of exactly the maximum length", () => {
    expect(() =>
      adminOrderCreateSchema.parse({ ...validOrder, reason: "x".repeat(500) }),
    ).not.toThrow();
  });
});

