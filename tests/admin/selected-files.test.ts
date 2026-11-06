import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearFileInput,
  readSelectedFiles,
} from "@/lib/admin/selected-files";

/**
 * Reading the files an admin chose.
 *
 * ── What these prove ──────────────────────────────────────────────────────
 *
 * The bug this file exists for was a **silent, total failure** of every
 * product image upload:
 *
 *   1. The admin picks three images.
 *   2. The picker reads `input.files` — a `FileList`.
 *   3. The picker sets `input.value = ""` so the same file can be
 *      chosen twice. Per the HTML specification, that "must empty the
 *      list of selected files".
 *   4. The loop that appends the files to the `FormData` therefore
 *      appends **nothing**.
 *   5. The multipart body carries no file parts, and the server answers
 *      "Choose at least one image to upload" — for a request the admin
 *      had every right to make.
 *
 * The fix is to **snapshot** the files before clearing the input. The
 * snapshot is an array, so nothing that happens to the input afterwards
 * can change it.
 *
 * These tests use a **fake input** rather than a real DOM element,
 * because the behaviour under test is the *ordering* of the snapshot
 * and the clear — and a fake input can model the spec's "empty the list
 * of selected files" rule exactly, on any runtime.
 */

/**
 * A fake file input.
 *
 * `files` is a **live** list, exactly as a browser's is: clearing the
 * input empties it in place. This is the behaviour that broke the
 * upload, so the fake has to reproduce it faithfully.
 */
function makeInput(fileNames: string[]): HTMLInputElement {
  const files: File[] = fileNames.map(
    (name) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" }),
  );

  const input = {
    get files(): FileList {
      // A live `FileList` — the same array, every time.
      return files as unknown as FileList;
    },
    set value(next: string) {
      if (next === "") {
        // The spec's "empty the list of selected files" algorithm.
        files.length = 0;
      }
    },
    get value(): string {
      return "";
    },
  };

  return input as unknown as HTMLInputElement;
}

describe("readSelectedFiles", () => {
  it("reads the files the admin chose", () => {
    const input = makeInput(["one.png", "two.png"]);

    expect(readSelectedFiles(input).map((file) => file.name)).toEqual([
      "one.png",
      "two.png",
    ]);
  });

  it("reads nothing when no file was chosen", () => {
    const input = makeInput([]);

    expect(readSelectedFiles(input)).toEqual([]);
  });

  it("reads nothing from an input with no files property", () => {
    // A browser that exposes no `files` at all must not crash the
    // picker.
    const input = {} as HTMLInputElement;

    expect(readSelectedFiles(input)).toEqual([]);
  });

  it("returns an ARRAY, not the live list", () => {
    const input = makeInput(["one.png"]);

    const files = readSelectedFiles(input);

    expect(Array.isArray(files)).toBe(true);
  });
});

describe("the snapshot survives the input being cleared", () => {
  it("keeps the files after the input is cleared", () => {
    // ── The bug this file exists for ────────────────────────────────────
    //
    // The snapshot is taken first and the input is cleared second, so
    // the upload sends the files the admin actually chose.
    const input = makeInput(["one.png", "two.png", "three.png"]);

    const files = readSelectedFiles(input);

    clearFileInput(input);

    // The input's own list is empty now — that is the whole point of
    // clearing it.
    expect(input.files?.length).toBe(0);

    // But the snapshot is untouched.
    expect(files).toHaveLength(3);
    expect(files.map((file) => file.name)).toEqual([
      "one.png",
      "two.png",
      "three.png",
    ]);
  });

  it("sends every chosen file to the server", () => {
    // The end-to-end shape of the fix: the multipart body carries
    // exactly the files the admin chose, so the server does not answer
    // "Choose at least one image to upload".
    const input = makeInput(["one.png", "two.png"]);

    const files = readSelectedFiles(input);

    clearFileInput(input);

    const body = new FormData();

    for (const file of files) {
      body.append("images", file);
    }

    expect(body.getAll("images")).toHaveLength(2);
  });

  it("reads nothing after the input has been cleared", () => {
    // Reading *after* the clear is the bug's exact shape — and it is
    // why the order matters, not just the presence of the clear.
    const input = makeInput(["one.png"]);

    clearFileInput(input);

    expect(readSelectedFiles(input)).toEqual([]);
  });
});

describe("clearFileInput", () => {
  it("empties the input's file list", () => {
    const input = makeInput(["one.png"]);

    clearFileInput(input);

    expect(input.files?.length).toBe(0);
  });

  it("is safe on an input that holds nothing", () => {
    const input = makeInput([]);

    expect(() => clearFileInput(input)).not.toThrow();
  });
});

/**
 * The order the pickers call things in.
 *
 * ── Why this file inspects the source ─────────────────────────────────────
 *
 * The helper tests above prove that `readSelectedFiles` returns a
 * snapshot that survives a clear. They do **not** prove that the
 * components *take* that snapshot before they clear — and that ordering
 * is the bug.
 *
 * The two orders are:
 *
 * ```tsx
 * const files = readSelectedFiles(input);  // ✅ snapshot first
 * clearFileInput(input);                    //    …then clear
 * ```
 *
 * ```tsx
 * clearFileInput(input);                    // ❌ clear first
 * const files = readSelectedFiles(input);  //    …now it is empty
 * ```
 *
 * and the second one uploads nothing while looking perfectly correct to
 * every test that exercises the helper on its own.
 *
 * Mounting the components would catch it too, but the pickers are
 * client components whose upload path runs through `fetch`, and the
 * component test would be asserting the mock rather than the order.
 * Reading the two calls out of the source is a smaller, sturdier claim:
 * it fails the moment someone swaps the two lines, and it fails for
 * the reason the bug happened.
 */
describe("the pickers snapshot before they clear", () => {
  const PICKERS = [
    "src/components/admin/products/ProductImagePicker.tsx",
    "src/components/admin/discovery/DiscoveryImageField.tsx",
  ];

  for (const picker of PICKERS) {
    it(`${picker} reads the files before it clears the input`, () => {
      const source = readFileSync(
        path.join(process.cwd(), picker),
        "utf8",
      );

      const readAt = source.indexOf("readSelectedFiles(");
      const clearAt = source.indexOf("clearFileInput(");

      // Both calls must be present at all.
      expect(readAt).toBeGreaterThan(-1);
      expect(clearAt).toBeGreaterThan(-1);

      // And the read must come first.
      expect(readAt).toBeLessThan(clearAt);
    });
  }

  it("the product picker sends the snapshot, not the input's live list", () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "src/components/admin/products/ProductImagePicker.tsx",
      ),
      "utf8",
    );

    // The loop that builds the multipart body must iterate the
    // snapshot, not `input.files` — otherwise the clear still empties
    // it, however the snapshot was taken.
    expect(source).toContain("for (const file of files)");

    expect(source).not.toMatch(/for\s*\(\s*const\s+\w+\s+of\s+input\.files/);
  });
});
