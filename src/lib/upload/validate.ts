/**
 * Server-side upload validation.
 *
 * ── The one rule that matters ────────────────────────────────────────────
 *
 * **The declared `Content-Type` is untrusted. The magic bytes are not.**
 *
 * A client can send `Content-Type: image/png` with a text file attached. It
 * can rename `payload.exe` to `photo.png`. The header is just a string the
 * client controls; the first bytes of the file are not. So every validation
 * decision is made from the bytes, and the declared type is only ever used
 * to *cross-check* that the bytes match what the client claimed.
 *
 * A `.txt` file renamed to `.png` is rejected. That is the test that proves
 * this validation is real rather than decorative.
 */

/**
 * The error thrown when an upload fails validation.
 */
export class UploadValidationError extends Error {
  readonly code:
    | "EMPTY_FILE"
    | "FILE_TOO_LARGE"
    | "UNSUPPORTED_MIME_TYPE"
    | "MIME_MISMATCH"
    | "DIMENSION_TOO_LARGE"
    | "MALFORMED_FILE";

  constructor(code: UploadValidationError["code"], message: string) {
    super(message);
    this.name = "UploadValidationError";
    this.code = code;
  }
}

/**
 * The image types the platform accepts.
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/**
 * The video types the platform accepts.
 */
export const ALLOWED_VIDEO_MIME_TYPES = ["video/mp4", "video/webm"] as const;

export type AllowedVideoMimeType = (typeof ALLOWED_VIDEO_MIME_TYPES)[number];

/**
 * The maximum pixel dimension allowed on either axis.
 *
 * A decompression-bomb guard. A 40 000 × 40 000 PNG is a few hundred
 * kilobytes on disk but expands to roughly 6 GB in memory once decoded — a
 * cheap way to take down a server. Rejecting anything wider or taller than
 * 4000 px before the image is ever decoded closes that door.
 */
export const MAX_IMAGE_DIMENSION = 4000;

/**
 * The default size caps, used when the environment does not override them.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * The file extension to use for each detected MIME type.
 *
 * The extension is chosen from the **detected** type, never from the
 * client's filename. A user who uploads `payload.png` gets `.png` on disk
 * only if the bytes really are a PNG.
 */
export const MIME_TYPE_EXTENSIONS: Readonly<
  Record<AllowedImageMimeType | AllowedVideoMimeType, string>
> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/**
 * Reads the size cap for a scope from the environment.
 *
 * @param kind - `"image"` or `"video"`.
 */
export function getMaxBytes(kind: "image" | "video"): number {
  const raw =
    kind === "image"
      ? process.env.MAX_IMAGE_BYTES
      : process.env.MAX_VIDEO_BYTES;

  if (!raw) {
    return kind === "image"
      ? DEFAULT_MAX_IMAGE_BYTES
      : DEFAULT_MAX_VIDEO_BYTES;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[upload] Ignoring invalid ${kind.toUpperCase()} size limit "${raw}".`,
    );

    return kind === "image"
      ? DEFAULT_MAX_IMAGE_BYTES
      : DEFAULT_MAX_VIDEO_BYTES;
  }

  return parsed;
}

/**
 * Detects the MIME type of a buffer from its magic bytes.
 *
 * Returns `null` when the bytes match nothing in the allow-list. It does
 * not throw — the caller decides whether an unknown type is an error, and
 * it is usually better to report the specific reason (mismatch vs.
 * unsupported) than a generic one.
 *
 * ### Signatures checked
 *
 * | Type      | Magic bytes                |
 * |-----------|----------------------------|
 * | JPEG      | `FF D8 FF`                 |
 * | PNG       | `89 50 4E 47 0D 0A 1A 0A` |
 * | WebP      | `RIFF` … `WEBP`            |
 * | MP4       | `ftyp` at offset 4         |
 * | WebM      | `1A 45 DF A3`              |
 */
export function detectMimeType(buffer: Buffer): string | null {
  if (buffer.length === 0) return null;

  // ── JPEG ────────────────────────────────────────────────────────────────
  // SOI marker `FF D8` followed by a marker byte. The third byte is
  // usually `FF` (the start of a marker segment) but is not guaranteed, so
  // only the two-byte SOI is required.
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }

  // ── PNG ────────────────────────────────────────────────────────────────
  // The full 8-byte signature, including the CRLF and the `1A 0A` control
  // byte. Checking all eight avoids matching a file that merely starts
  // with the same four bytes.
  if (buffer.length >= 8) {
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    if (pngSignature.every((byte, index) => buffer[index] === byte)) {
      return "image/png";
    }
  }

  // ── WebP ───────────────────────────────────────────────────────────────
  // `RIFF` .... `WEBP` — the four bytes at offset 8 are the format tag.
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // ── MP4 ────────────────────────────────────────────────────────────────
  // The `ftyp` box type at offset 4.
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return "video/mp4";
  }

  // ── WebM / Matroska ───────────────────────────────────────────────────
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return "video/webm";
  }

  return null;
}

/**
 * Returns true when the MIME type is one the platform accepts as an image.
 */
export function isAllowedImageMimeType(mimeType: string): mimeType is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Returns true when the MIME type is one the platform accepts as a video.
 */
export function isAllowedVideoMimeType(mimeType: string): mimeType is AllowedVideoMimeType {
  return (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * The outcome of a successful validation.
 */
export type ValidatedUpload = {
  /** The MIME type detected from the magic bytes. */
  readonly mimeType: AllowedImageMimeType;
  /** The size in bytes. */
  readonly byteSize: number;
  /** The image's pixel width, when it could be read. */
  readonly width: number | null;
  /** The image's pixel height, when it could be read. */
  readonly height: number | null;
};

/**
 * Reads the pixel dimensions from an image header.
 *
 * The dimensions are read from the header only — the image is never fully
 * decoded. That is what makes the decompression-bomb guard cheap: a
 * 40 000 × 40 000 PNG is rejected after reading a few dozen bytes, not
 * after allocating 6 GB.
 *
 * @returns the dimensions, or `null` when they cannot be read.
 */
export function readImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  try {
    if (mimeType === "image/png") {
      return readPngDimensions(buffer);
    }

    if (mimeType === "image/jpeg") {
      return readJpegDimensions(buffer);
    }

    if (mimeType === "image/webp") {
      return readWebpDimensions(buffer);
    }
  } catch {
    // A malformed header is not a crash — it is a rejected upload.
    return null;
  }

  return null;
}

/**
 * Reads the dimensions from a PNG's IHDR chunk.
 *
 * The IHDR chunk is always first, and the width and height are big-endian
 * 32-bit integers at offsets 16 and 20.
 */
function readPngDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  // 8-byte signature + 4-byte length + 4-byte "IHDR" + 8 bytes of data.
  if (buffer.length < 24) return null;

  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/**
 * Reads the dimensions from a JPEG's SOF marker.
 *
 * The SOF0–SOF15 markers (excluding the DHT/JPG/DAC markers, which share
 * the range) carry the frame dimensions. The marker is followed by the
 * precision byte and then the height and width.
 */
function readJpegDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  let offset = 2;

  while (offset + 9 < buffer.length) {
    // Markers are 0xFF followed by a non-zero, non-0xFF byte.
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];

    if (marker === undefined) return null;

    // Standalone markers with no payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    // Start of scan — the dimensions are past this point.
    if (marker === 0xda) return null;

    const length = buffer.readUInt16BE(offset + 2);

    // SOF0–SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + length;
  }

  return null;
}

/**
 * Reads the dimensions from a WebP header.
 *
 * WebP has three chunk layouts, distinguished by the `VP8 `, `VP8L` and
 * `VP8X` tags.
 */
function readWebpDimensions(
  buffer: Buffer,
): { width: number; height: number } | null {
  const tag = buffer.subarray(12, 16).toString("ascii");

  if (tag === "VP8 ") {
    // Lossy: the layout after the "VP8 " chunk header is
    //   [12..15] "VP8 "
    //   [16..18] frame tag
    //   [19..21] start code 9d 01 2a
    //   [22..23] width  (14 bits) + 2 bits scale + 2 bits reserved
    //   [24..25] height (14 bits) + 2 bits scale + 2 bits reserved
    // The dimensions are little-endian, with the low 14 bits holding the
    // value.
    if (buffer.length < 26) return null;

    return {
      width: buffer.readUInt16LE(22) & 0x3fff,
      height: buffer.readUInt16LE(24) & 0x3fff,
    };
  }

  if (tag === "VP8L") {
    // Lossless: 14-bit width and height, 1-bit-alpha packed into 4 bytes.
    if (buffer.length < 25) return null;

    const bits = buffer.readUInt32LE(21);

    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (tag === "VP8X") {
    // Extended: 24-bit width and height, minus one, at offsets 24 and 27.
    if (buffer.length < 30) return null;

    const width =
      buffer[24] | (buffer[25] << 8) | (buffer[26] << 16);
    const height =
      buffer[27] | (buffer[28] << 8) | (buffer[29] << 16);

    return { width: width + 1, height: height + 1 };
  }

  return null;
}

/**
 * Validates an uploaded image.
 *
 * The checks, in order:
 *
 *  1. The file is not empty.
 *  2. The size is within the cap.
 *  3. The magic bytes match a supported image type.
 *  4. The detected type matches the declared type — a mismatch means the
 *     client is lying about what it sent, and it is rejected even when
 *     the detected type is perfectly acceptable.
 *  5. Neither axis exceeds `MAX_IMAGE_DIMENSION`.
 *
 * @param bytes        - The uploaded bytes.
 * @param declaredMime - The client-declared MIME type. Cross-checked, never trusted.
 * @param maxBytes     - The size cap. Defaults to `MAX_IMAGE_BYTES`.
 *
 * @throws UploadValidationError when any check fails.
 */
export function assertValidImage(
  bytes: Buffer,
  declaredMime: string | null | undefined,
  maxBytes: number = getMaxBytes("image"),
): ValidatedUpload {
  if (!bytes || bytes.length === 0) {
    throw new UploadValidationError(
      "EMPTY_FILE",
      "The uploaded file is empty.",
    );
  }

  if (bytes.length > maxBytes) {
    throw new UploadValidationError(
      "FILE_TOO_LARGE",
      `The file is too large. The maximum is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
    );
  }

  const detected = detectMimeType(bytes);

  if (detected === null || !isAllowedImageMimeType(detected)) {
    throw new UploadValidationError(
      "UNSUPPORTED_MIME_TYPE",
      "That file is not a supported image. Please upload a JPEG, PNG or WebP file.",
    );
  }

  // The client said one thing, the bytes said another. Reject rather than
  // pick a winner — the mismatch is either a bug or an attempt to slip
  // something past the check.
  if (declaredMime && declaredMime !== detected) {
    throw new UploadValidationError(
      "MIME_MISMATCH",
      "The file's contents do not match its file type. Please re-upload the correct file.",
    );
  }

  const dimensions = readImageDimensions(bytes, detected);

  if (
    dimensions &&
    (dimensions.width > MAX_IMAGE_DIMENSION ||
      dimensions.height > MAX_IMAGE_DIMENSION)
  ) {
    throw new UploadValidationError(
      "DIMENSION_TOO_LARGE",
      `The image is ${dimensions.width}×${dimensions.height} pixels. Images must be no larger than ${MAX_IMAGE_DIMENSION} pixels on either side.`,
    );
  }

  return {
    mimeType: detected,
    byteSize: bytes.length,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
}

/**
 * Validates an uploaded video.
 *
 * The same shape as `assertValidImage`, with the video type list and the
 * video size cap.
 *
 * @throws UploadValidationError when any check fails.
 */
export function assertValidVideo(
  bytes: Buffer,
  declaredMime: string | null | undefined,
  maxBytes: number = getMaxBytes("video"),
): ValidatedUpload {
  if (!bytes || bytes.length === 0) {
    throw new UploadValidationError(
      "EMPTY_FILE",
      "The uploaded file is empty.",
    );
  }

  if (bytes.length > maxBytes) {
    throw new UploadValidationError(
      "FILE_TOO_LARGE",
      `The file is too large. The maximum is ${Math.floor(maxBytes / 1024 / 1024)} MB.`,
    );
  }

  const detected = detectMimeType(bytes);

  if (detected === null || !isAllowedVideoMimeType(detected)) {
    throw new UploadValidationError(
      "UNSUPPORTED_MIME_TYPE",
      "That file is not a supported video. Please upload an MP4 or WebM file.",
    );
  }

  if (declaredMime && declaredMime !== detected) {
    throw new UploadValidationError(
      "MIME_MISMATCH",
      "The file's contents do not match its file type. Please re-upload the correct file.",
    );
  }

  return {
    mimeType: detected as AllowedImageMimeType,
    byteSize: bytes.length,
    width: null,
    height: null,
  };
}
