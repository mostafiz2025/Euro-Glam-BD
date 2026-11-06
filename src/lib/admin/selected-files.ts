/**
 * Reading the files an admin chose.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 *
 * A file input's selected files live in `input.files`, which is a
 * `FileList` — **not** an array. And the HTML specification says that
 * setting a file input's `value` to the empty string "must empty the
 * list of selected files".
 *
 * That combination is a trap. The obvious order is:
 *
 * ```tsx
 * const files = input.files;   // the FileList
 * input.value = "";            // empties it
 * for (const file of files) {  // …now there are none
 *   body.append("images", file);
 * }
 * ```
 *
 * and it fails **silently and totally**. The admin picks three images,
 * the input is cleared, the loop appends nothing, the multipart body
 * carries no file parts, and the server answers "Choose at least one
 * image to upload" — for a request the admin had every right to make.
 *
 * Whether the captured `FileList` reference survives the clear depends
 * on the browser: some return a fresh snapshot from `input.files` on
 * every access, others hand back the same live list and empty it in
 * place. Rather than depend on which browser the admin happens to use,
 * the files are copied out **first**, so the upload sends exactly what
 * was chosen on every browser.
 *
 * The `File` objects themselves are immutable snapshots of the chosen
 * file, so copying the list loses nothing.
 */

/**
 * Reads the files an admin chose out of a file input.
 *
 * The returned array is a **snapshot**: it is not affected by anything
 * that happens to the input afterwards. The caller may safely clear the
 * input as soon as it has this array.
 *
 * @param input - The file input the admin chose from.
 *
 * @returns The chosen files, in the order the browser reported them.
 *          Empty when nothing was chosen.
 */
export function readSelectedFiles(
  input: HTMLInputElement,
): File[] {
  return Array.from(input.files ?? []);
}

/**
 * Clears a file input so the same file can be chosen again.
 *
 * The input's own `value` setter is the supported way to do this. It is
 * what makes choosing the *same* file twice fire a change event — and,
 * without a prior snapshot, it is also what empties the file list. So
 * the snapshot has to be taken **first**; see `readSelectedFiles`.
 */
export function clearFileInput(input: HTMLInputElement): void {
  input.value = "";
}
