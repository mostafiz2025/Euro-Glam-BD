import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The product-image upload route.
 *
 * ── What this tests that the service tests cannot ───────────────────────
 *
 * The service tests prove that the *bytes* are handled correctly. This
 * proves the **HTTP boundary**:
 *
 *   1. A multipart request with several files is read, and **every**
 *      file is stored — not just the first.
 *   2. A request with no files is a 400, not a 500.
 *   3. A renamed payload is a **415**, and the message is the one the
 *      admin sees — not a generic "something went wrong".
 *   4. A request with **no session** is refused. The upload is an
 *      admin surface; an unauthenticated caller must not be able to
 *      write files to the server.
 *   5. The response carries the **key** as well as the URL, because the
 *      key is what goes in the database.
 *
 * The guard is mocked, so the test is about the route's own logic rather
 * than about the session machinery — which has its own tests.
 */

/**
 * A valid 1×1 PNG.
 */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

/**
 * A plain-text file — the classic "renamed to .png" payload.
 */
const TEXT_FILE = Buffer.from(
  "This is not an image, whatever the filename says.",
  "utf8",
);

/**
 * Whether the mocked guard lets the request through.
 */
let sessionValid = true;

/**
 * The upload root the route writes into.
 */
let uploadRoot: string;

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();

  return {
    ...actual,
    connection: async () => undefined,
  };
});

vi.mock("@/lib/auth/guards", () => ({
  requireAdmin: async () => {
    if (!sessionValid) {
      const { ApiError } = await import("@/lib/api/errors");

      throw ApiError.unauthenticated("You must be signed in to do that.");
    }

    return {
      id: "admin-1",
      name: "Test Admin",
      email: "admin@example.com",
      role: "ADMIN" as const,
    };
  },
}));

const { POST } = await import("@/app/api/admin/products/images/route");

/**
 * Builds a multipart request body carrying the given files.
 */
function buildRequest(
  files: { bytes: Buffer; name: string; type: string }[],
): Request {
  const form = new FormData();

  for (const file of files) {
    form.append(
      "images",
      new File([new Uint8Array(file.bytes)], file.name, {
        type: file.type,
      }),
    );
  }

  return new Request("http://localhost/api/admin/products/images", {
    method: "POST",
    body: form,
  });
}

beforeAll(async () => {
  uploadRoot = await mkdtemp(path.join(tmpdir(), "egb-upload-route-"));

  process.env.UPLOAD_ROOT = uploadRoot;
  process.env.STORAGE_URL_PREFIX = "/uploads";
});

afterAll(async () => {
  if (uploadRoot) {
    await rm(uploadRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  sessionValid = true;
});

describe("POST /api/admin/products/images", () => {
  it("stores every file in a multi-file selection", async () => {
    const response = await POST(
      buildRequest([
        { bytes: PNG_1X1, name: "one.png", type: "image/png" },
        { bytes: PNG_1X1, name: "two.png", type: "image/png" },
        { bytes: PNG_1X1, name: "three.png", type: "image/png" },
      ]),
    );

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      data: {
        images: { key: string; url: string; originalName: string }[];
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.images).toHaveLength(3);

    for (const image of payload.data.images) {
      expect(image.key).toMatch(
        /^products\/\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/,
      );
      expect(image.url).toBe(`/uploads/${image.key}`);
    }
  });

  it("returns the key as well as the URL", async () => {
    const response = await POST(
      buildRequest([
        { bytes: PNG_1X1, name: "serum.png", type: "image/png" },
      ]),
    );

    const payload = (await response.json()) as {
      data: { images: { key: string; url: string }[] };
    };

    const [image] = payload.data.images;

    // The key is what the product row holds. The URL is a convenience
    // so the form can show a preview without reconstructing the prefix.
    expect(image.key).not.toContain("/uploads");
    expect(image.url).toContain(image.key);
  });

  it("refuses a request with no files", async () => {
    const response = await POST(
      buildRequest([]),
    );

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a renamed payload with 415", async () => {
    const response = await POST(
      buildRequest([
        { bytes: TEXT_FILE, name: "payload.png", type: "image/png" },
      ]),
    );

    expect(response.status).toBe(415);

    const payload = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    // The message names the problem. An admin who uploaded a renamed
    // text file is told what to do about it.
    expect(payload.error.message).toContain("JPEG");
  });

  it("refuses a request with no session", async () => {
    sessionValid = false;

    const response = await POST(
      buildRequest([
        { bytes: PNG_1X1, name: "serum.png", type: "image/png" },
      ]),
    );

    expect(response.status).toBe(401);

    const payload = (await response.json()) as {
      ok: boolean;
      error: { code: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("UNAUTHENTICATED");
  });

  it("accepts a file that arrived from another realm", async () => {
    // ── The false "Choose at least one image" ────────────────────────────
    //
    // The files are created by the HTTP layer, and the `File` the route
    // sees is the global one. When the two are not the same object,
    // an `instanceof File` check says "not a file" for **every** file —
    // and the admin is told they chose no images when they chose one.
    //
    // So the route reads the entries **structurally**, and this test
    // puts a file that is deliberately not an instance of the global
    // `File` into the form.
    const form = new FormData();

    const foreign = {
      name: "serum.png",
      size: PNG_1X1.byteLength,
      type: "image/png",
      arrayBuffer: async () =>
        PNG_1X1.buffer.slice(
          PNG_1X1.byteOffset,
          PNG_1X1.byteOffset + PNG_1X1.byteLength,
        ) as ArrayBuffer,
    };

    // A `FormData` will not hold a foreign object, so the entry is
    // placed by hand — which is what the HTTP layer's own parsing
    // effectively produces.
    const originalGetAll = FormData.prototype.getAll;

    FormData.prototype.getAll = function getAll(name: string) {
      if (name === "images") {
        return [foreign as unknown as File];
      }

      return originalGetAll.call(this, name);
    };

    try {
      const response = await POST(
        new Request("http://localhost/api/admin/products/images", {
          method: "POST",
          body: form,
        }),
      );

      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        ok: boolean;
        data: { images: { key: string }[] };
      };

      expect(payload.ok).toBe(true);
      expect(payload.data.images).toHaveLength(1);
    } finally {
      FormData.prototype.getAll = originalGetAll;
    }
  });

  it("still refuses a request whose only entry is a form value", async () => {
    // The structural check must not accept a plain string — a
    // `FormData` entry that is a value, not a file.
    const form = new FormData();

    form.append("images", "not-a-file");

    const response = await POST(
      new Request("http://localhost/api/admin/products/images", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };

    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe("VALIDATION_ERROR");
    expect(payload.error.message).toContain("image");
  });
});
