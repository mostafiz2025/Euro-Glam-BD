import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_DIMENSION,
  UploadValidationError,
  assertValidImage,
  detectMimeType,
  getMaxBytes,
  readImageDimensions,
} from "@/lib/upload/validate";

/**
 * Upload validation tests.
 *
 * The critical test in this file is the last one: a `.txt` file renamed to
 * `.png` must be **rejected**. That is the test that proves the validation
 * is real rather than decorative — a check that only looks at the
 * declared `Content-Type` or the filename would pass that file.
 */

/**
 * A valid 1×1 PNG.
 *
 * The 67-byte canonical PNG: the 8-byte signature, an IHDR chunk with a
 * 1×1 dimension, an IDAT chunk, and an IEND chunk.
 */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/**
 * A valid 1×1 JPEG.
 *
 * The smallest structurally-valid JPEG: SOI, an APP0 segment, an SOF0
 * frame header carrying the dimensions, an empty scan, and EOI.
 */
const JPEG_1X1 = Buffer.from(
  "ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd9",
  "hex",
);

/**
 * A valid 30×30 WebP (lossy VP8).
 *
 * The layout after the "VP8 " chunk header is: a 3-byte frame tag, the
 * 3-byte start code (9d 01 2a), then the width and height as 14-bit
 * little-endian values.
 */
const WEBP_1X1 = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]), // file size - 8
  Buffer.from("WEBP", "ascii"),
  Buffer.from("VP8 ", "ascii"),
  Buffer.from([0x00, 0x00, 0x00]), // frame tag
  Buffer.from([0x9d, 0x01, 0x2a]), // start code
  Buffer.from([0x1e, 0x00]), // width  = 30
  Buffer.from([0x1e, 0x00]), // height = 30
]);

/**
 * A plain-text file. Not an image in any sense.
 */
const TEXT_FILE = Buffer.from(
  "This is a plain text file pretending to be a PNG.\n",
  "utf8",
);

describe("detectMimeType", () => {
  it("detects a PNG", () => {
    expect(detectMimeType(PNG_1X1)).toBe("image/png");
  });

  it("detects a JPEG", () => {
    expect(detectMimeType(JPEG_1X1)).toBe("image/jpeg");
  });

  it("detects a WebP", () => {
    expect(detectMimeType(WEBP_1X1)).toBe("image/webp");
  });

  it("returns null for a text file", () => {
    expect(detectMimeType(TEXT_FILE)).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(detectMimeType(Buffer.alloc(0))).toBeNull();
  });

  it("returns null for a buffer that is too short to classify", () => {
    expect(detectMimeType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("does not match a PNG that only shares the first four bytes", () => {
    // The full 8-byte signature is required — a file that starts with
    // 89 50 4E 47 but differs afterwards is not a PNG.
    const almostPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from([0x0d, 0x0a, 0x1a, 0x00]),
    ]);

    expect(detectMimeType(almostPng)).toBeNull();
  });

  it("returns null for an executable", () => {
    const fakeExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

    expect(detectMimeType(fakeExe)).toBeNull();
  });
});

describe("readImageDimensions", () => {
  it("reads the dimensions of a PNG", () => {
    expect(readImageDimensions(PNG_1X1, "image/png")).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("reads the dimensions of a WebP", () => {
    const dimensions = readImageDimensions(WEBP_1X1, "image/webp");

    expect(dimensions).not.toBeNull();
    expect(dimensions?.width).toBe(30);
    expect(dimensions?.height).toBe(30);
  });

  it("returns null for an unrecognised type", () => {
    expect(readImageDimensions(PNG_1X1, "image/gif")).toBeNull();
  });

  it("returns null rather than throwing for a malformed header", () => {
    const malformed = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("NOTIHDR", "ascii"),
    ]);

    expect(readImageDimensions(malformed, "image/png")).toBeNull();
  });
});

describe("assertValidImage", () => {
  it("accepts a valid PNG", () => {
    const result = assertValidImage(PNG_1X1, "image/png");

    expect(result.mimeType).toBe("image/png");
    expect(result.byteSize).toBe(PNG_1X1.length);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it("accepts a valid PNG with no declared type", () => {
    const result = assertValidImage(PNG_1X1, null);

    expect(result.mimeType).toBe("image/png");
  });

  it("rejects an empty file", () => {
    expect(() => assertValidImage(Buffer.alloc(0), "image/png")).toThrow(
      UploadValidationError,
    );
  });

  it("rejects a file that is too large", () => {
    // A 10-byte cap is enough to prove the check fires.
    expect(() => assertValidImage(PNG_1X1, "image/png", 10)).toThrow(
      /too large/i,
    );
  });

  it("rejects a text file that claims to be a PNG", () => {
    // THE key test: a `.txt` renamed to `.png`. The declared type says
    // image/png, but the bytes say text. It must be rejected.
    expect(() => assertValidImage(TEXT_FILE, "image/png")).toThrow(
      UploadValidationError,
    );
  });

  it("rejects a text file with the correct-looking declared type", () => {
    let error: unknown;

    try {
      assertValidImage(TEXT_FILE, "image/png");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UploadValidationError);
    expect((error as UploadValidationError).code).toBe("UNSUPPORTED_MIME_TYPE");
  });

  it("rejects an executable disguised as an image", () => {
    const fakeExe = Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
      Buffer.alloc(64),
    ]);

    expect(() => assertValidImage(fakeExe, "image/png")).toThrow(
      UploadValidationError,
    );
  });

  it("rejects a declared type that does not match the bytes", () => {
    // Real PNG bytes, but the client claimed JPEG. The mismatch means the
    // client is not describing the file accurately.
    expect(() => assertValidImage(PNG_1X1, "image/jpeg")).toThrow(
      /do not match/i,
    );
  });

  it("rejects an image wider than the dimension cap", () => {
    // A PNG header claiming 9000×100 pixels.
    const wide = Buffer.from(PNG_1X1);

    wide.writeUInt32BE(9000, 16);
    wide.writeUInt32BE(100, 20);

    expect(() => assertValidImage(wide, "image/png")).toThrow(
      /pixels/i,
    );
  });

  it("rejects an image taller than the dimension cap", () => {
    const tall = Buffer.from(PNG_1X1);

    tall.writeUInt32BE(100, 16);
    tall.writeUInt32BE(9000, 20);

    expect(() => assertValidImage(tall, "image/png")).toThrow(/pixels/i);
  });

  it("accepts an image exactly at the dimension cap", () => {
    const atCap = Buffer.from(PNG_1X1);

    atCap.writeUInt32BE(MAX_IMAGE_DIMENSION, 16);
    atCap.writeUInt32BE(MAX_IMAGE_DIMENSION, 20);

    expect(() => assertValidImage(atCap, "image/png")).not.toThrow();
  });
});

describe("getMaxBytes", () => {
  it("falls back to the default when the env var is absent", () => {
    const original = process.env.MAX_IMAGE_BYTES;

    delete process.env.MAX_IMAGE_BYTES;

    try {
      expect(getMaxBytes("image")).toBe(5 * 1024 * 1024);
    } finally {
      if (original !== undefined) process.env.MAX_IMAGE_BYTES = original;
    }
  });

  it("reads the cap from the environment", () => {
    const original = process.env.MAX_IMAGE_BYTES;

    process.env.MAX_IMAGE_BYTES = "1234";

    try {
      expect(getMaxBytes("image")).toBe(1234);
    } finally {
      if (original === undefined) {
        delete process.env.MAX_IMAGE_BYTES;
      } else {
        process.env.MAX_IMAGE_BYTES = original;
      }
    }
  });

  it("falls back to the default when the env var is not a number", () => {
    const original = process.env.MAX_IMAGE_BYTES;

    process.env.MAX_IMAGE_BYTES = "not-a-number";

    try {
      expect(getMaxBytes("image")).toBe(5 * 1024 * 1024);
    } finally {
      if (original === undefined) {
        delete process.env.MAX_IMAGE_BYTES;
      } else {
        process.env.MAX_IMAGE_BYTES = original;
      }
    }
  });
});
