/**
 * Reading the files out of a multipart form.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * An upload route has to answer one question: "did any files actually
 * arrive?" Getting that wrong in one direction is a crash; getting it
 * wrong in the other is a **silent, total failure** — the admin picks
 * three images, the request carries them, and the server says "Choose
 * at least one image to upload."
 *
 * The obvious check is `entry instanceof File`. It works in most
 * runtimes, but it is a **cross-realm identity check**, and that is
 * exactly the kind of check that breaks silently:
 *
 *   • `request.formData()` returns objects created by **undici** (the
 *     HTTP layer), not by the route module's own realm.
 *   • `File` here is the **global** `File`.
 *   • If the two are different objects — a bundled `File`, a polyfill,
 *     a different runtime version — `instanceof` says `false` for every
 *     file, and every upload is reported as an empty one.
 *
 * So the check here is **structural** rather than nominal: an entry
 * qualifies when it behaves like a file — it has a `name`, a `size`,
 * and can be read as bytes. That holds for a real `File` whatever realm
 * it came from, and it does not hold for a plain form string, which is
 * the only other thing a `FormData` entry can be.
 *
 * The structural check is **not** a weakening of the `instanceof` check:
 * a form value is a `string`, and a string has no `size`, no `name`
 * and no `arrayBuffer`. So the two checks accept exactly the same
 * entries — the structural one simply does not depend on which realm
 * the object was born in.
 */

/**
 * Returns true when a `FormData` entry is a file.
 *
 * The entry is typed as the union `FormData` actually produces — a
 * string or a `File` — so the check narrows it.
 */
export function isFileEntry(entry: FormDataEntryValue): entry is File {
  /*
   * The fast path: a real `File` from this realm. Checked first
   * because it is the common case and it is a single pointer compare.
   */
  if (typeof File !== "undefined" && entry instanceof File) {
    return true;
  }

  /*
   * The structural path: a file from another realm.
   *
   * A `string` entry fails on every one of these — a string has no
   * `size`, no `name` and no `arrayBuffer` — so a plain form value can
   * never be mistaken for a file.
   */
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  const candidate = entry as Partial<File>;

  return (
    typeof candidate.size === "number" &&
    typeof candidate.name === "string" &&
    typeof candidate.arrayBuffer === "function"
  );
}

/**
 * Reads every file out of a parsed form, under the given field name.
 *
 * A multi-file selection arrives as **one entry per file**, all under
 * the same name — so `getAll` is the only correct way to read them.
 *
 * @param form - The parsed multipart form.
 * @param field - The field name the files were sent under.
 *
 * @returns The files, in the order the browser sent them. Empty when
 *          the field held no files, or held only non-file values.
 */
export function readFilesFromForm(
  form: FormData,
  field: string,
): File[] {
  const files: File[] = [];

  for (const entry of form.getAll(field)) {
    if (isFileEntry(entry)) {
      files.push(entry);
    }
  }

  return files;
}
