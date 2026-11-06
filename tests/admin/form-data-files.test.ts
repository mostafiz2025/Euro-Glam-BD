import { describe, expect, it } from "vitest";

import {
  isFileEntry,
  readFilesFromForm,
} from "@/lib/admin/form-data-files";

/**
 * Reading the files out of a multipart form.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * An upload route has to answer one question: "did any files actually
 * arrive?" Getting it wrong in the **other** direction is a silent,
 * total failure — the admin picks three images, the request carries
 * them, and the server answers "Choose at least one image to upload."
 * The admin is told they chose no images when they chose several.
 *
 * So the reader must:
 *
 *   1. Recognise a file that came from **another realm** — the HTTP
 *      layer creates the `File`, and the route sees the global `File`,
 *      and `instanceof` between the two is an identity check that can
 *      fail for reasons that have nothing to do with the file.
 *   2. Reject a plain **form value**, which is the only other thing a
 *      `FormData` entry can be. A string has no `size`, no `name` and
 *      no `arrayBuffer`.
 *   3. Read **every** file under the field — a multi-file selection
 *      arrives as one entry per file, all under the same name.
 */

/**
 * A stand-in for a `File` created in another realm.
 *
 * It has the shape of a file but is **not** an instance of the global
 * `File` — which is exactly the case `instanceof` gets wrong.
 */
function foreignFile(name: string, bytes: Uint8Array): File {
  const candidate = {
    name,
    size: bytes.byteLength,
    type: "image/png",
    arrayBuffer: async () =>
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
  };

  return candidate as unknown as File;
}

describe("isFileEntry", () => {
  it("accepts a real File", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "serum.png", {
      type: "image/png",
    });

    expect(isFileEntry(file)).toBe(true);
  });

  it("accepts a file from another realm", () => {
    // The case `instanceof File` gets wrong: the object behaves like
    // a file, but it is not an instance of *this* realm's `File`.
    const file = foreignFile("serum.png", new Uint8Array([1, 2, 3]));

    expect(file instanceof File).toBe(false);
    expect(isFileEntry(file)).toBe(true);
  });

  it("rejects a plain form value", () => {
    // A `FormData` entry is a string or a `File` — never a boolean.
    expect(isFileEntry("serum.png")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isFileEntry("")).toBe(false);
  });

  it("rejects a plain object", () => {
    expect(isFileEntry({} as unknown as FormDataEntryValue)).toBe(false);
  });

  it("rejects an object with a size but no name", () => {
    const candidate = {
      size: 10,
      arrayBuffer: async () => new ArrayBuffer(0),
    };

    expect(
      isFileEntry(candidate as unknown as FormDataEntryValue),
    ).toBe(false);
  });

  it("rejects an object with a name but no size", () => {
    const candidate = {
      name: "serum.png",
      arrayBuffer: async () => new ArrayBuffer(0),
    };

    expect(
      isFileEntry(candidate as unknown as FormDataEntryValue),
    ).toBe(false);
  });

  it("rejects an object that cannot be read as bytes", () => {
    const candidate = {
      name: "serum.png",
      size: 10,
    };

    expect(
      isFileEntry(candidate as unknown as FormDataEntryValue),
    ).toBe(false);
  });
});

describe("readFilesFromForm", () => {
  it("reads every file under the field", () => {
    const form = new FormData();

    form.append(
      "images",
      new File([new Uint8Array([1])], "one.png", { type: "image/png" }),
    );
    form.append(
      "images",
      new File([new Uint8Array([2])], "two.png", { type: "image/png" }),
    );
    form.append(
      "images",
      new File([new Uint8Array([3])], "three.png", { type: "image/png" }),
    );

    const files = readFilesFromForm(form, "images");

    expect(files).toHaveLength(3);
    expect(files.map((file) => file.name)).toEqual([
      "one.png",
      "two.png",
      "three.png",
    ]);
  });

  it("reads a file from another realm", () => {
    const form = new FormData();

    // A `FormData` will not hold a foreign object, so the entry is
    // placed by hand — which is what the HTTP layer's own parsing
    // effectively does.
    const original = FormData.prototype.getAll;

    FormData.prototype.getAll = function getAll(name: string) {
      if (name === "images") {
        return [foreignFile("serum.png", new Uint8Array([1, 2, 3]))];
      }

      return original.call(this, name);
    };

    try {
      const files = readFilesFromForm(form, "images");

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe("serum.png");
    } finally {
      FormData.prototype.getAll = original;
    }
  });

  it("skips a form value that shares the field name", () => {
    const form = new FormData();

    form.append("images", "not-a-file");

    expect(readFilesFromForm(form, "images")).toEqual([]);
  });

  it("reads nothing from a field that holds no entries", () => {
    const form = new FormData();

    expect(readFilesFromForm(form, "images")).toEqual([]);
  });

  it("reads nothing from a different field", () => {
    const form = new FormData();

    form.append(
      "other",
      new File([new Uint8Array([1])], "one.png", { type: "image/png" }),
    );

    expect(readFilesFromForm(form, "images")).toEqual([]);
  });

  it("keeps the order the browser sent", () => {
    const form = new FormData();

    for (const name of ["a.png", "b.png", "c.png"]) {
      form.append(
        "images",
        new File([new Uint8Array([1])], name, { type: "image/png" }),
      );
    }

    expect(readFilesFromForm(form, "images").map((file) => file.name)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
  });
});
