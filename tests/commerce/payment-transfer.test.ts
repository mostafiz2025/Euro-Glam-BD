import { describe, expect, it } from "vitest";

import {
  EMPTY_TRANSFER_DETAILS,
  isTransferDetailsValid,
  normaliseTransferDetails,
  validateTransferDetails,
} from "@/components/commerce/payment-transfer-form";

/**
 * The transfer details form's logic.
 *
 * Vitest runs in a `node` environment with no jsdom and no React Testing
 * Library, so the component itself cannot be rendered here. Its logic
 * can — and it is the part that matters.
 *
 * ── What these tests are actually about ──────────────────────────────────
 *
 * The transfer reference is the **reconciliation key** for a
 * mobile-banking payment. The shop matches a transfer against the
 * operator's statement by the sender number and the TrxID, so:
 *
 *   1. The two fields are a **pair**. Half a transfer is not a
 *      transfer.
 *
 *   2. The rules are the **server's** rules, reused — the same schemas
 *      the settle endpoint validates against. A second implementation
 *      would be a second thing to keep in step, and the two would drift.
 *
 *   3. The sender number is **normalised** to the local
 *      `01XXXXXXXXX` form, because that is the form the operator prints
 *      on its statement. A number stored in any other form would appear
 *      in no statement, and the reconciliation query would not find it.
 */
describe("validateTransferDetails", () => {
  it("says nothing about a pair that is complete and well-formed", () => {
    const errors = validateTransferDetails({
      senderNumber: "01712345678",
      transactionId: "8N3F2K9LM4",
    });

    expect(errors).toEqual({});
  });

  it("requires both fields", () => {
    const errors = validateTransferDetails(EMPTY_TRANSFER_DETAILS);

    expect(errors.senderNumber).toBeTruthy();
    expect(errors.transactionId).toBeTruthy();
  });

  it("refuses half a pair — a sender number with no TrxID", () => {
    // A transfer the shop cannot match to a statement line.
    const errors = validateTransferDetails({
      senderNumber: "01712345678",
      transactionId: "",
    });

    expect(errors.transactionId).toBeTruthy();
    expect(errors.senderNumber).toBeUndefined();
  });

  it("refuses half a pair — a TrxID with no sender number", () => {
    const errors = validateTransferDetails({
      senderNumber: "",
      transactionId: "8N3F2K9LM4",
    });

    expect(errors.senderNumber).toBeTruthy();
    expect(errors.transactionId).toBeUndefined();
  });

  it("refuses a sender number that is not a Bangladeshi mobile number", () => {
    // The same rule the server applies — a landline number cannot be a
    // wallet's sender number.
    const errors = validateTransferDetails({
      senderNumber: "12345",
      transactionId: "8N3F2K9LM4",
    });

    expect(errors.senderNumber).toBeTruthy();
  });

  it("refuses a TrxID with characters that are not letters or digits", () => {
    // The two operators do not use identical formats, and this codebase
    // should not be the thing that rejects a legitimate TrxID over a
    // formatting rule. But whitespace and punctuation are a paste error.
    const errors = validateTransferDetails({
      senderNumber: "01712345678",
      transactionId: "8N3F 2K9L#M4",
    });

    expect(errors.transactionId).toBeTruthy();
  });

  it("refuses a TrxID that is too short to be a TrxID", () => {
    const errors = validateTransferDetails({
      senderNumber: "01712345678",
      transactionId: "8N",
    });

    expect(errors.transactionId).toBeTruthy();
  });
});

describe("isTransferDetailsValid", () => {
  it("is true only for a complete, well-formed pair", () => {
    expect(
      isTransferDetailsValid({
        senderNumber: "01712345678",
        transactionId: "8N3F2K9LM4",
      }),
    ).toBe(true);

    expect(isTransferDetailsValid(EMPTY_TRANSFER_DETAILS)).toBe(false);

    expect(
      isTransferDetailsValid({
        senderNumber: "01712345678",
        transactionId: "",
      }),
    ).toBe(false);
  });
});

describe("normaliseTransferDetails", () => {
  it("normalises the sender number to the local 01XXXXXXXXX form", () => {
    // The merchant statements list the number as the customer typed it.
    // `+8801712345678`, `8801712345678`, `01712345678` and `1712345678`
    // are all the same transfer, and it is stored in the form the
    // operator prints — so the reconciliation query finds it.
    for (const typed of [
      "+8801712345678",
      "8801712345678",
      "01712345678",
      "1712345678",
    ]) {
      const result = normaliseTransferDetails({
        senderNumber: typed,
        transactionId: "8N3F2K9LM4",
      });

      expect(result.paymentSenderNumber).toBe("01712345678");
    }
  });

  it("upper-cases the TrxID", () => {
    // `abc123` and `ABC123` are the same TrxID typed two different ways,
    // and they must be one value in the database — matching on one
    // reconciliation query.
    const result = normaliseTransferDetails({
      senderNumber: "01712345678",
      transactionId: "8n3f2k9lm4",
    });

    expect(result.paymentTransactionId).toBe("8N3F2K9LM4");
  });

  it("strips spacing from both fields", () => {
    const result = normaliseTransferDetails({
      senderNumber: "01712 3456 78",
      transactionId: "  8N3F2K9LM4  ",
    });

    expect(result.paymentSenderNumber).toBe("01712345678");
    expect(result.paymentTransactionId).toBe("8N3F2K9LM4");
  });

  it("throws on an invalid pair rather than sending a half transfer", () => {
    // A silent normalisation of a malformed value would send a
    // reference the server then refuses, and the customer would be told
    // "try again" with nothing to fix.
    expect(() =>
      normaliseTransferDetails({
        senderNumber: "01712345678",
        transactionId: "",
      }),
    ).toThrow();
  });
});
