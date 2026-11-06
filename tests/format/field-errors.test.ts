import { describe, expect, it } from "vitest";

import {
  readErrorMessage,
  readFieldErrors,
} from "@/lib/format/field-errors";

/**
 * Reading a failed form's field errors.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * When a request fails validation the API says **which field** was
 * wrong and why — the envelope's `details.fieldErrors`. That map is the
 * only thing that carries that information; the envelope's `message` is
 * deliberately generic ("The request failed validation"), because the
 * server cannot know what the admin was looking at.
 *
 * So a client that renders only `message` throws the information away,
 * and the admin is told their form is invalid without being told what
 * to fix. That is the bug this reader exists to prevent.
 *
 * These tests also pin the reader's **defensiveness**. The envelope is
 * a wire format: `details` may be absent, `fieldErrors` may be absent,
 * and a field's messages may be the wrong shape entirely. A reader that
 * threw on any of those would turn a validation error into a crash —
 * which is a worse failure than the one it was written to fix.
 */
describe("reading field errors", () => {
  it("reads a field's message", () => {
    const errors = readFieldErrors({
      message: "The request failed validation.",
      details: {
        fieldErrors: {
          name: ["The product needs a name."],
        },
      },
    });

    expect(errors.name).toBe("The product needs a name.");
  });

  it("reads several fields at once", () => {
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          name: ["The product needs a name."],
          pricePaisa: ["The price cannot be negative."],
        },
      },
    });

    expect(errors).toEqual({
      name: "The product needs a name.",
      pricePaisa: "The price cannot be negative.",
    });
  });

  it("keeps the FIRST message for a field", () => {
    // Zod reports the type error before the range error, and "expected
    // string, received null" is more useful to the admin than "expected
    // string, received number".
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          climateTips: [
            "Invalid input: expected string, received null",
            "That climate tip is too long.",
          ],
        },
      },
    });

    expect(errors.climateTips).toBe(
      "Invalid input: expected string, received null",
    );
  });

  it("folds an indexed path back onto its field", () => {
    // A problem inside an array is reported by Zod with an indexed path
    // — `images.0` — because the offending *element* is what is wrong.
    // But a form has one input per field: the admin picked three
    // images, they did not type "images.0".
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          "images.0": [
            "That image reference points outside the upload directory.",
          ],
        },
      },
    });

    expect(errors.images).toBe(
      "That image reference points outside the upload directory.",
    );
    expect(errors["images.0"]).toBeUndefined();
  });

  it("folds a nested path back onto its field", () => {
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          "shippingAddress.city": ["A city is required."],
        },
      },
    });

    expect(errors.shippingAddress).toBe("A city is required.");
  });

  it("keeps the first message when a field has several paths", () => {
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          "images.0": ["The first image is bad."],
          "images.1": ["The second image is bad."],
        },
      },
    });

    expect(errors.images).toBe("The first image is bad.");
  });

  it("accepts a single message where an array was expected", () => {
    // A hand-written or legacy error body should not leave the admin
    // staring at a blank form.
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          name: "The product needs a name.",
        },
      },
    });

    expect(errors.name).toBe("The product needs a name.");
  });

  it("falls back to a usable message when the array holds nothing readable", () => {
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          name: [null],
        },
      },
    });

    // Never blank. An empty error box is worse than a vague one.
    expect(errors.name).toBe("This value is not valid.");
  });

  it("reads nothing from a failure with no details", () => {
    // A conflict, a network failure, a 500 — none of them name a field.
    expect(readFieldErrors({ message: "That record already exists." })).toEqual(
      {},
    );
  });

  it("reads nothing from a failure with no field errors", () => {
    expect(
      readFieldErrors({ message: "Something went wrong.", details: {} }),
    ).toEqual({});
  });

  it("reads nothing from a failure with a malformed field errors block", () => {
    expect(
      readFieldErrors({
        details: { fieldErrors: "not an object" },
      }),
    ).toEqual({});

    expect(
      readFieldErrors({ details: { fieldErrors: null } }),
    ).toEqual({});
  });

  it("reads nothing from a missing error", () => {
    expect(readFieldErrors(undefined)).toEqual({});
    expect(readFieldErrors(null)).toEqual({});
    expect(readFieldErrors("a string")).toEqual({});
  });

  it("skips a field with no messages at all", () => {
    // An empty array says nothing, so there is nothing to show.
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          name: [],
        },
      },
    });

    expect(errors).toEqual({});
  });

  it("gives a blank message the generic fallback rather than nothing", () => {
    // The array is not empty — it holds a message that happens to be
    // blank. So the field *was* rejected, and saying so beats showing
    // nothing.
    const errors = readFieldErrors({
      details: {
        fieldErrors: {
          description: [""],
        },
      },
    });

    expect(errors.description).toBe("This value is not valid.");
  });
});

describe("reading the whole-form message", () => {
  it("reads the message", () => {
    expect(
      readErrorMessage({ message: "That record already exists." }),
    ).toBe("That record already exists.");
  });

  it("falls back when there is no message", () => {
    expect(readErrorMessage({})).toBe(
      "We could not save that. Please try again.",
    );
    expect(readErrorMessage(null)).toBe(
      "We could not save that. Please try again.",
    );
  });

  it("uses the caller's fallback when it has one", () => {
    expect(readErrorMessage({}, "We could not reach the server.")).toBe(
      "We could not reach the server.",
    );
  });

  it("never returns a blank message", () => {
    // An empty banner is worse than a vague one.
    expect(readErrorMessage({ message: "" })).not.toBe("");
  });
});
